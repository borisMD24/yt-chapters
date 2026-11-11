// Registre de jobs en mémoire pour le chapitrage d'un média local.
// - Exécution séquentielle : un seul pipeline à la fois (file d'attente chaînée).
// - Progression relayée depuis le pipeline sous forme d'événements bruts ;
//   le registre en dérive un message en français compréhensible.
// - Annulation coopérative via AbortSignal.
// - Aucune clé d'API n'est stockée ni renvoyée : les erreurs sont nettoyées.
import { randomUUID } from 'node:crypto';
import { MediaValidationError, MEDIA_TOOLS_MISSING_MESSAGE } from './media-check';

export type JobStatus = 'queued' | 'running' | 'cancelling' | 'done' | 'error' | 'cancelled';
export type JobPhase = 'chunking' | 'transcribing' | 'chaptering' | 'persisting' | 'done';

/**
 * Messages français actionnables pour les causes OpenRouter réelles (clé,
 * crédit, débit). Le détail brut reste dans la trace serveur et dans le repli
 * « Détails techniques » nettoyé.
 */
export const OPENROUTER_KEY_MISSING_MESSAGE =
  "La clé OpenRouter est manquante ou refusée. Renseignez une clé valide dans le fichier .env (OPENROUTER_API_KEY), puis relancez le serveur.";
export const OPENROUTER_CREDIT_MESSAGE = 'Crédit OpenRouter insuffisant pour transcrire ce fichier.';
export const OPENROUTER_RATE_LIMIT_MESSAGE = "Trop de requêtes envoyées à OpenRouter d'un coup. Réessayez dans une minute.";

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
  /** Diagnostic : nombre d'entrées de nettoyage encore référencées en mémoire. */
  retainedCleanupCount(): number;
};

export type JobRegistryOptions = {
  /**
   * Nombre de jobs terminés conservés en mémoire. Au-delà, les plus anciens
   * jobs terminés sont évincés (jamais un job actif) ; le plus récent reste
   * disponible pour l'affichage.
   */
  maxRetainedFinished?: number;
  /**
   * Trace SERVEUR d'un échec de job (jamais renvoyée au navigateur). Reçoit
   * l'erreur BRUTE (elle peut contenir des chemins ou une ligne de commande
   * ffmpeg) : l'appelant décide du format (ici : `app.log.error`).
   */
  logger?: JobFailureLogger;
};

/** Trace d'un échec de job, telle que reçue par le logger serveur. */
export type JobFailure = {
  jobId: string;
  /** Phase atteinte au moment de l'échec. */
  phase: JobPhase;
  /** Temps écoulé depuis le démarrage du pipeline (ms). */
  elapsedMs: number;
  /** Erreur BRUTE d'origine : jamais exposée au navigateur. */
  error: unknown;
};

export type JobFailureLogger = (failure: JobFailure) => void;

/** Message d'état français déduit de la phase et de l'avancement. */
function messageFor(job: Job): string {
  switch (job.phase) {
    case 'chunking':
      return job.totalChunks > 0 ? 'Découpage du fichier terminé.' : 'Découpage du fichier…';
    case 'transcribing': {
      // Morceau EN COURS, en base 1 : `doneChunks` compte les morceaux TERMINÉS,
      // donc le premier morceau lit « morceau 1 sur N… » et le dernier « N sur N… ».
      const cur = Math.min(job.doneChunks + 1, job.totalChunks);
      return `Transcription du morceau ${cur} sur ${job.totalChunks}…`;
    }
    case 'chaptering':
      return 'Recherche des chapitres…';
    case 'persisting':
      return 'Enregistrement des chapitres…';
    case 'done':
      return 'Chapitres prêts.';
  }
}

/**
 * Plafond du détail technique envoyé au navigateur. Assez large pour lire la
 * cause utile, assez court pour qu'une ligne de commande ffmpeg complète (avec
 * ses chemins absolus) ne s'affiche jamais en entier dans la page.
 */
export const MAX_TECHNICAL_DETAIL = 500;

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
    .slice(0, MAX_TECHNICAL_DETAIL);
}

/** Traduit une erreur technique en message non technique. */
export function friendlyErrorMessage(err: unknown): string {
  // Les erreurs de contrôle média portent DÉJÀ un message français actionnable
  // (fichier muet, illisible, ffmpeg absent) : on le renvoie tel quel.
  if (err instanceof MediaValidationError) return err.message;
  const raw = err instanceof Error ? err.message : String(err);
  // Clé absente ou refusée : 401/403, en-tête d'authentification manquant, ou
  // garde-fou local (`OPENROUTER_API_KEY manquante`). Sans cela, l'utilisateur
  // ne voyait qu'un « réessayez » alors que réessayer ne peut pas marcher.
  if (
    /\b401\b|\b403\b|Missing Authentication header|No auth credentials|OPENROUTER_API_KEY|clé\s*d'?api|api key/i.test(raw)
  ) {
    return OPENROUTER_KEY_MISSING_MESSAGE;
  }
  if (/\b402\b|insufficient/i.test(raw)) return OPENROUTER_CREDIT_MESSAGE;
  if (/\b429\b|too many requests/i.test(raw)) return OPENROUTER_RATE_LIMIT_MESSAGE;
  if (/ffmpeg est introuvable|spawn (ffmpeg|ffprobe) ENOENT/i.test(raw)) {
    return MEDIA_TOOLS_MISSING_MESSAGE;
  }
  if (/ffmpeg|ffprobe|illisible|aucun chunk|ENOENT|EACCES|EPERM|EBUSY|spawn|EPIPE/i.test(raw)) {
    return "Impossible de lire ce fichier. Vérifiez qu'il n'est pas ouvert par un autre programme, puis réessayez.";
  }
  return "Le chapitrage n'a pas abouti. Vous pouvez réessayer.";
}

export function createJobRegistry(pipeline: JobPipeline, opts: JobRegistryOptions = {}): JobRegistry {
  const jobs = new Map<string, Job>();
  const controllers = new Map<string, AbortController>();
  /** Nettoyage propre à chaque job (fichier temporaire d'un envoi), mémoïsé. */
  const cleanups = new Map<string, () => Promise<boolean>>();
  const maxFinished = opts.maxRetainedFinished ?? 20;
  /** Trace d'échec : no-op par défaut (les tests injectent une espionne). */
  const logFailure: JobFailureLogger = opts.logger ?? (() => {});
  /** Ids des jobs terminés, dans l'ordre d'achèvement (le plus récent en dernier). */
  const finishedOrder: string[] = [];
  let tail: Promise<void> = Promise.resolve();

  const isFinished = (status: JobStatus) => status === 'done' || status === 'error' || status === 'cancelled';

  /**
   * Emballe un finaliseur pour qu'il ne s'exécute jamais deux fois en parallèle
   * ni deux fois après un succès (idempotent quel que soit l'ordre
   * annulation/exécution/fin). Une seule relance est autorisée après un échec
   * transitoire ; seule une réussite marque le nettoyage comme terminé.
   */
  function makeCleanup(fn?: () => void | Promise<void>): () => Promise<boolean> {
    let succeeded = false;
    let inFlight: Promise<boolean> | null = null;
    let attempts = 0;
    return () => {
      if (succeeded || !fn) return Promise.resolve(true);
      if (inFlight) return inFlight;
      if (attempts >= 2) return Promise.resolve(false);
      attempts++;
      // La remise à zéro de `inFlight` est attachée APRÈS l'affectation : si
      // `fn` jette SYNCHRONEMENT, la tentative se termine pendant son exécution
      // synchrone et l'ancienne version remettait `inFlight` à zéro trop tôt
      // (la garde restait alors figée sur une promesse `false`, et plus aucun
      // nettoyage n'était jamais relancé).
      const attempt = (async () => {
        try {
          await fn();
          succeeded = true;
          return true;
        } catch {
          return false;
        }
      })();
      inFlight = attempt.finally(() => {
        inFlight = null;
      });
      return inFlight;
    };
  }

  function cleanupOf(id: string): Promise<boolean> {
    return cleanups.get(id)?.() ?? Promise.resolve(true);
  }

  /**
   * Libère le controller d'un job terminé et évince les jobs terminés les plus
   * anciens au-delà du plafond. Les jobs actifs (queued/running/cancelling) ne
   * sont jamais évincés ; le résultat le plus récent reste disponible.
   */
  function releaseFinished(job: Job): void {
    // Un job deja evince n'a plus rien a liberer : sinon un job en attente
    // execute plus tard reintroduirait son id et evincerait un job plus recent.
    if (!jobs.has(job.id)) return;
    controllers.delete(job.id);
    if (!finishedOrder.includes(job.id)) finishedOrder.push(job.id);
    while (finishedOrder.length > maxFinished) {
      const oldest = finishedOrder.shift()!;
      const candidate = jobs.get(oldest);
      if (candidate && isFinished(candidate.status)) {
        jobs.delete(oldest);
        // Le nettoyage est déjà terminé (on ne publie l'état terminal qu'après) :
        // on peut oublier son entrée au lieu de la garder pour toujours.
        cleanups.delete(oldest);
      }
    }
  }

  /** Publie l'état terminal « annulé » ; à n'appeler qu'après le nettoyage. */
  function publishCancelled(job: Job): void {
    if (job.status === 'cancelled') return;
    job.status = 'cancelled';
    job.message = 'Annulé.';
    job.error = undefined;
    job.result = undefined;
    releaseFinished(job);
  }

  async function finalizeAndCancel(job: Job): Promise<void> {
    await cleanupOf(job.id);
    publishCancelled(job);
  }

  /** Passe le job en « annulation en cours » : l'arrêt n'est pas instantané. */
  function beginCancelling(job: Job): void {
    if (isFinished(job.status) || job.status === 'cancelling') return;
    job.status = 'cancelling';
    job.message = 'Annulation en cours…';
    controllers.get(job.id)?.abort();
  }

  /**
   * Statut courant du job, relu dynamiquement : une annulation peut survenir
   * pendant un `await`, ce que l'analyse de types ne peut pas modéliser.
   */
  const statusOf = (job: Job): JobStatus => job.status;

  async function run(job: Job, input: JobInput, signal: AbortSignal): Promise<void> {
    // Annulé avant de démarrer (ou pendant l'attente dans la file) : le
    // nettoyage a déjà été lancé par `cancelJob`, ou va l'être ici.
    if (isFinished(job.status) || job.status === 'cancelling') {
      await finalizeAndCancel(job);
      return;
    }
    job.status = 'running';
    const startedAt = Date.now();
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
      // Le nettoyage est TERMINÉ avant de publier l'état terminal : aucun
      // observateur ne voit « terminé » alors que le fichier existe encore.
      await cleanupOf(job.id);
      if (signal.aborted || statusOf(job) === 'cancelling') {
        publishCancelled(job);
        return;
      }
      job.result = result;
      job.status = 'done';
      job.phase = 'done';
      job.doneChunks = job.totalChunks;
      job.message = 'Chapitres prêts.';
      releaseFinished(job);
    } catch (err) {
      await cleanupOf(job.id);
      if (signal.aborted || statusOf(job) === 'cancelling') {
        publishCancelled(job);
        return;
      }
      // Trace SERVEUR : id, phase, durée et erreur BRUTE (chemins et commande
      // ffmpeg compris). Le navigateur ne reçoit qu'un message nettoyé/tronqué.
      logFailure({ jobId: job.id, phase: job.phase, elapsedMs: Date.now() - startedAt, error: err });
      job.error = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
      job.message = friendlyErrorMessage(err);
      job.status = 'error';
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
    cleanups.set(id, makeCleanup(input.onFinished));
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
    if (isFinished(job.status) || job.status === 'cancelling') return job;
    const wasQueued = job.status === 'queued';
    beginCancelling(job);
    if (wasQueued) {
      // Rien ne tourne : on nettoie tout de suite. L'état `cancelled` n'est
      // publié qu'une fois le fichier temporaire effectivement supprimé.
      void finalizeAndCancel(job);
    }
    // Job en cours : l'état terminal viendra quand le pipeline aura observé
    // l'annulation ET que le nettoyage sera terminé.
    return job;
  }

  return {
    createJob,
    getJob,
    cancelJob,
    retainedCleanupCount: () => cleanups.size,
  };
}
