// Registre de jobs en mémoire pour le chapitrage d'un média local.
// - Exécution séquentielle : un seul pipeline à la fois (file d'attente chaînée).
// - Progression relayée depuis le pipeline sous forme d'événements bruts ;
//   le registre en dérive un message en français compréhensible.
// - Annulation coopérative via AbortSignal.
// - Aucune clé d'API n'est stockée ni renvoyée : les erreurs sont nettoyées.
import { randomUUID } from 'node:crypto';

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'cancelled';
export type JobPhase = 'chunking' | 'transcribing' | 'chaptering' | 'persisting' | 'done';

export type JobInput = {
  path: string;
  chunkSec?: number;
  lang?: string;
  maxChunks?: number;
  /** Identifiant de vidéo imposé (envoi de fichier) au lieu de l'id dérivé du chemin. */
  videoId?: string;
  /**
   * Nettoyage appelé exactement une fois quand le job atteint un état terminal
   * (done, error, cancelled). Sert à supprimer le fichier temporaire d'un envoi.
   */
  onFinished?: () => void | Promise<void>;
};

export type JobChapter = { startSec: number; title: string };
export type JobTranscriptLine = { startSec: number; text: string };

export type JobResult = {
  videoId: string;
  chapters: JobChapter[];
  text: string;
  warnings: string[];
  durationSec: number;
  /** Vue condensée du transcript (pour l'affichage repliable). */
  transcript?: JobTranscriptLine[];
};

export type Job = {
  id: string;
  status: JobStatus;
  phase: JobPhase;
  doneChunks: number;
  totalChunks: number;
  /** Message d'état en français, adapté à un public non technique. */
  message: string;
  /** Détail technique nettoyé (sans clé), pour le repli « Détails techniques ». */
  error?: string;
  result?: JobResult;
};

export type ProgressEvent = {
  phase: Exclude<JobPhase, 'done'>;
  doneChunks: number;
  totalChunks: number;
};

export type JobPipeline = (
  input: JobInput,
  ctx: { onProgress: (e: ProgressEvent) => void; signal: AbortSignal },
) => Promise<JobResult>;

export type JobRegistry = {
  createJob(input: JobInput): Job;
  getJob(id: string): Job | undefined;
  cancelJob(id: string): Job | undefined;
};

export type JobRegistryOptions = {
  /**
   * Nombre de jobs terminés conservés en mémoire. Au-delà, les plus anciens
   * jobs terminés sont évincés (jamais un job actif) ; le plus récent reste
   * disponible pour l'affichage.
   */
  maxRetainedFinished?: number;
};

/** Message d'état français déduit de la phase et de l'avancement. */
function messageFor(job: Job): string {
  switch (job.phase) {
    case 'chunking':
      return job.totalChunks > 0 ? 'Découpage du fichier terminé.' : 'Découpage du fichier…';
    case 'transcribing':
      return `Transcription du morceau ${job.doneChunks} sur ${job.totalChunks}…`;
    case 'chaptering':
      return 'Recherche des chapitres…';
    case 'persisting':
      return 'Enregistrement des chapitres…';
    case 'done':
      return 'Chapitres prêts.';
  }
}

/**
 * Retire tout secret (clés OpenRouter, tokens Bearer) ET tout chemin de fichier
 * absolu des messages d'erreur destinés au navigateur.
 *
 * Règles : lecteur Windows (`C:\…`, espaces et délimiteurs `( ) ' " :` compris
 * DANS le chemin), UNC (`\\serveur\partage\…`) et POSIX limité aux racines
 * usuelles (`home|Users|media|Volumes|mnt|tmp|opt|root|srv|var|data|usr`, pour
 * ne pas abîmer une date comme `12/03/2024`). Un chemin est consommé jusqu'à
 * un terminateur : `:`, fin de ligne, ou début d'un autre chemin — jamais un
 * simple espace, sinon « Mes documents » ferait fuiter la fin du chemin.
 *
 * Défensif et cosmétique pour un outil local mono-utilisateur : ce n'est PAS
 * une frontière de sécurité. Compromis assumés :
 *  - la queue d'un chemin étendu `\\?\C:\…` peut survivre (la règle UNC
 *    s'arrête au `:`) ;
 *  - du texte suivant un chemin sur la même ligne peut être sur-nettoyé
 *    (le chemin va jusqu'à la fin de ligne faute de terminateur explicite).
 */
export function sanitizeErrorMessage(message: string): string {
  // Terminateur partagé : `:`, fin de ligne, ou un autre chemin qui commence.
  return message
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
    .replace(/\\\\[^:\n]*?(?=:|$|\n|\s+(?:[A-Za-z]:\\|\\\\|\/))/g, '<chemin>')
    .replace(/[A-Za-z]:\\[^:\n]*?(?=:|$|\n|\s+(?:[A-Za-z]:\\|\\\\|\/))/g, '<chemin>')
    .replace(
      /\/(?:home|Users|media|Volumes|mnt|tmp|opt|root|srv|var|data|usr)\/[^:\n]*?(?=:|$|\n|\s+(?:[A-Za-z]:\\|\\\\|\/))/g,
      '<chemin>',
    )
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 400);
}

/** Traduit une erreur technique en message non technique. */
export function friendlyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  if (/OPENROUTER_API_KEY|clé\s*d'?api|api key/i.test(raw)) {
    return "Le service de transcription n'est pas configuré. Contactez la personne qui a installé l'outil.";
  }
  if (/ffmpeg|ffprobe|illisible|aucun chunk|ENOENT|EACCES|EPERM|EBUSY|spawn|EPIPE/i.test(raw)) {
    return "Impossible de lire ce fichier. Vérifiez qu'il n'est pas ouvert par un autre programme, puis réessayez.";
  }
  return "Le chapitrage n'a pas abouti. Vous pouvez réessayer.";
}

export function createJobRegistry(pipeline: JobPipeline, opts: JobRegistryOptions = {}): JobRegistry {
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  const maxFinished = opts.maxRetainedFinished ?? 20;
  /** Ids des jobs terminés, dans l'ordre d'achèvement (le plus récent en dernier). */
  const finishedOrder: string[] = [];
  let tail: Promise<void> = Promise.resolve();

  const isFinished = (status: JobStatus) => status === 'done' || status === 'error' || status === 'cancelled';

  /**
   * Libère le controller d'un job terminé et évince les jobs terminés les plus
   * anciens au-delà du plafond. Les jobs actifs (queued/running) ne sont jamais
   * évincés ; le résultat le plus récent reste donc disponible pour l'affichage.
   */
  function releaseFinished(job: Job): void {
    // Un job déjà évincé n'a plus rien à libérer : sinon un job en attente
    // exécuté plus tard réintroduirait son id et évincerait un job plus récent.
    if (!jobs.has(job.id)) return;
    controllers.delete(job.id);
    if (!finishedOrder.includes(job.id)) finishedOrder.push(job.id);
    while (finishedOrder.length > maxFinished) {
      const oldest = finishedOrder.shift()!;
      const candidate = jobs.get(oldest);
      if (candidate && isFinished(candidate.status)) jobs.delete(oldest);
    }
  }

  async function run(job: Job, input: JobInput, signal: AbortSignal): Promise<void> {
    // Le nettoyage (fichier temporaire d'un envoi) doit avoir lieu exactement
    // une fois, quel que soit l'état terminal atteint.
    let finalized = false;
    const finalize = async (): Promise<void> => {
      if (finalized) return;
      finalized = true;
      try {
        await input.onFinished?.();
      } catch {
        /* nettoyage au mieux : ne doit jamais masquer l'état du job */
      }
    };

    if (job.status === 'cancelled') {
      await finalize();
      releaseFinished(job);
      return;
    }
    job.status = 'running';
    try {
      const result = await pipeline(input, {
        signal,
        onProgress: (e) => {
          if (job.status !== 'running') return;
          job.phase = e.phase;
          // Une fois le nombre de morceaux connu, on le garde : les phases
          // suivantes (chapitrage, enregistrement) ne le remettent pas à zéro.
          if (e.totalChunks > 0) {
            job.totalChunks = e.totalChunks;
            job.doneChunks = e.doneChunks;
          }
          job.message = messageFor(job);
        },
      });
      // Le nettoyage a lieu AVANT d'exposer l'état terminal : un observateur ne
      // peut pas voir « terminé » alors que le fichier temporaire existe encore.
      await finalize();
      if (signal.aborted) {
        job.status = 'cancelled';
        job.message = 'Annulé.';
        releaseFinished(job);
        return;
      }
      job.result = result;
      job.status = 'done';
      job.phase = 'done';
      job.doneChunks = job.totalChunks;
      job.message = 'Chapitres prêts.';
      releaseFinished(job);
    } catch (err) {
      const cancelled = signal.aborted;
      job.error = cancelled ? undefined : sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      job.message = cancelled ? 'Annulé.' : friendlyErrorMessage(err);
      await finalize();
      job.status = cancelled ? 'cancelled' : 'error';
      releaseFinished(job);
    }
  }

  function createJob(input: JobInput): Job {
    const id = randomUUID();
    const job: Job = {
      id,
      status: 'queued',
      phase: 'chunking',
      doneChunks: 0,
      totalChunks: 0,
      message: 'En attente…',
    };
    jobs.set(id, job);
    const controller = new AbortController();
    controllers.set(id, controller);
    tail = tail.then(() => run(job, input, controller.signal)).catch(() => {});
    return job;
  }

  function getJob(id: string): Job | undefined {
    return jobs.get(id);
  }

  function cancelJob(id: string): Job | undefined {
    const job = jobs.get(id);
    if (!job) return undefined;
    if (isFinished(job.status)) return job;
    job.status = 'cancelled';
    job.message = 'Annulé.';
    controllers.get(id)?.abort();
    releaseFinished(job);
    return job;
  }

  return { createJob, getJob, cancelJob };
}
