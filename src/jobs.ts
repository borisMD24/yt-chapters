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
  /** Seam déterministe pour les tests. */
  newId?: () => string;
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

/** Retire tout secret (clés OpenRouter, tokens Bearer) d'un message d'erreur. */
export function sanitizeErrorMessage(message: string): string {
  return message
    .replace(/sk-[A-Za-z0-9_-]{6,}/g, 'sk-***')
    .replace(/Bearer\s+[A-Za-z0-9._-]{6,}/gi, 'Bearer ***')
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
  let tail: Promise<void> = Promise.resolve();

  async function run(job: Job, input: JobInput, signal: AbortSignal): Promise<void> {
    if (job.status === 'cancelled') return;
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
      if (signal.aborted) {
        job.status = 'cancelled';
        job.message = 'Annulé.';
        return;
      }
      job.result = result;
      job.status = 'done';
      job.phase = 'done';
      job.doneChunks = job.totalChunks;
      job.message = 'Chapitres prêts.';
    } catch (err) {
      if (signal.aborted) {
        job.status = 'cancelled';
        job.message = 'Annulé.';
        job.error = undefined;
        return;
      }
      job.status = 'error';
      job.message = friendlyErrorMessage(err);
      job.error = sanitizeErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  function createJob(input: JobInput): Job {
    const id = opts.newId?.() ?? randomUUID();
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
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job;
    job.status = 'cancelled';
    job.message = 'Annulé.';
    controllers.get(id)?.abort();
    return job;
  }

  return { createJob, getJob, cancelJob };
}
