// Analyse d'une FENÊTRE d'un média local pour l'éditeur de bornes : pics (forme
// d'onde) et silences, en UN SEUL passage ffmpeg.
//
// Principe : on demande à ffmpeg de ré-échantillonner la tranche demandée en PCM
// 16 bits mono 8 kHz sur la sortie STANDARD (→ pics) tout en activant le filtre
// `silencedetect` (→ dates des silences sur la sortie d'ERREUR). Aucun fichier
// temporaire, aucun second outil, aucune écriture disque.
//
// Robustesse : exécution asynchrone, délai maximal, sortie bornée, cache mémoire
// par identifiant + fenêtre quantifiée. Le module est PUR côté entrées/sorties
// (le lanceur ffmpeg est injectable) : les tests n'ont jamais besoin du réseau ni
// de ffmpeg réel.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isToolMissingError } from './media-check';

const run = promisify(execFile);

/** Nombre de points visés pour la forme d'onde d'une fenêtre. */
export const PEAK_POINTS = 600;

/** Durée maximale analysable en un appel (secondes). */
export const ANALYSIS_MAX_WINDOW_SEC = 120;

/** Pas de quantification de la fenêtre (secondes) : clé de cache stable. */
export const ANALYSIS_QUANTUM_SEC = 0.5;

/** Délai maximal d'un passage ffmpeg (millisecondes). */
export const ANALYSIS_TIMEOUT_MS = 10_000;

/** Taille de sortie PCM maximale acceptée (octets) : 120 s × 8 kHz × 2 = 1,92 Mo. */
const ANALYSIS_MAX_PCM_BYTES = ANALYSIS_MAX_WINDOW_SEC * 8000 * 2;

/** TTL du cache (millisecondes). */
export const ANALYSIS_CACHE_TTL_MS = 5 * 60 * 1000;

/** Nombre maximal d'entrées du cache. */
export const ANALYSIS_CACHE_MAX_ENTRIES = 64;

/** Nombre maximal d'analyses simultanées (au-delà : 429, jamais de file). */
export const ANALYSIS_MAX_CONCURRENT = 3;

/** Message : fenêtre invalide (négative, inversée, non finie). */
export const ANALYSIS_WINDOW_INVALID_MESSAGE =
  'Fenêtre d’analyse invalide : indiquez un début positif ou nul et une fin strictement supérieure au début.';

/** Message : fenêtre trop longue. */
export const ANALYSIS_WINDOW_TOO_LONG_MESSAGE = `Fenêtre d’analyse trop longue : la durée maximale est de ${ANALYSIS_MAX_WINDOW_SEC} secondes. Zoomez pour analyser une portion plus courte.`;

/** Message : délai dépassé. */
export const ANALYSIS_TIMEOUT_MESSAGE = `L’analyse de cette portion a dépassé le délai de ${ANALYSIS_TIMEOUT_MS / 1000} secondes. Rapprochez-vous, ou réduisez la fenêtre, puis réessayez.`;

/** Message : ffmpeg absent. */
export const ANALYSIS_TOOLS_MISSING_MESSAGE =
  'ffmpeg est introuvable sur cet ordinateur : la forme d’onde ne peut pas être analysée. Le reste de l’éditeur reste utilisable.';

/** Message : échec générique (le reste de l’éditeur doit continuer à fonctionner). */
export const ANALYSIS_FAILED_MESSAGE =
  'L’analyse de la forme d’onde a échoué. Le reste de l’éditeur reste utilisable : réessayez, ou déplacez la borne à la main.';

/** Message : trop d’analyses simultanées (plafond de concurrence atteint). */
export const ANALYSIS_BUSY_MESSAGE =
  'Trop d’analyses simultanées : réessayez dans un instant, ou zoomez sur une portion plus courte.';

export type AnalysisFailureKind = 'timeout' | 'missing-tools' | 'busy' | 'failed';

/** Code HTTP associé à chaque échec d'analyse. */
const ANALYSIS_FAILURE_STATUS: Record<AnalysisFailureKind, number> = {
  timeout: 504,
  'missing-tools': 503,
  busy: 429,
  failed: 500,
};

/** Erreur d'analyse portant le code HTTP à renvoyer (message français destiné à l'utilisateur). */
export class AnalysisError extends Error {
  readonly status: number;
  constructor(
    readonly kind: AnalysisFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'AnalysisError';
    this.status = ANALYSIS_FAILURE_STATUS[kind];
  }
}

/** Traduit une erreur de lancement en `AnalysisError` française. */
export function toAnalysisError(err: unknown): AnalysisError {
  const e = err as { killed?: boolean; signal?: string | null; code?: string } | null;
  if (e && (e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL')) {
    return new AnalysisError('timeout', ANALYSIS_TIMEOUT_MESSAGE);
  }
  if (isToolMissingError(err)) return new AnalysisError('missing-tools', ANALYSIS_TOOLS_MISSING_MESSAGE);
  return new AnalysisError('failed', ANALYSIS_FAILED_MESSAGE);
}

/** Résultat d'un passage ffmpeg sur une tranche (PCM sur stdout, journal sur stderr). */
export type AnalysisRunnerOutput = { pcm: Buffer; stderr: string };

/** Lanceur injectable : un seul passage ffmpeg sur `[from, from + len]`. */
export type AnalysisRunner = (file: string, from: number, len: number) => Promise<AnalysisRunnerOutput>;

/**
 * Lanceur réel : une seule commande ffmpeg, sortie PCM 16 bits mono 8 kHz sur la
 * sortie standard, `silencedetect` sur la sortie d'erreur. `-ss` AVANT `-i`
 * (décodage partiel, rapide) ; la durée totale du média reste imprimée par ffmpeg
 * dans son en-tête et sert à tronquer `to` si la demande dépasse la fin.
 */
export const defaultAnalysisRunner: AnalysisRunner = async (file, from, len) => {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-ss',
    String(from),
    '-t',
    String(len),
    '-i',
    file,
    '-af',
    'silencedetect=noise=-30dB:d=0.35',
    '-f',
    's16le',
    '-ac',
    '1',
    '-ar',
    '8000',
    '-',
  ];
  const { stdout, stderr } = await run('ffmpeg', args, {
    timeout: ANALYSIS_TIMEOUT_MS,
    maxBuffer: ANALYSIS_MAX_PCM_BYTES * 2,
    encoding: 'buffer',
  });
  const pcm = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout as unknown as Uint8Array);
  return { pcm, stderr: Buffer.isBuffer(stderr) ? stderr.toString('utf8') : String(stderr) };
};

// ---------- validation de la fenêtre ----------

export type AnalysisQueryResult = { ok: true; from: number; to: number } | { ok: false; message: string };

/** Lit un paramètre de requête (chaîne ou nombre) en nombre fini, sinon `NaN`. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Valide `?from=&to=` : finis, `from ≥ 0`, `0 < to − from ≤ 120`. Toute autre
 * situation est refusée par un message français (l'appelant répond `400`).
 * La troncature de `to` au-delà de la durée du média n'est PAS faite ici : elle
 * dépend du média et se fait après l'analyse.
 */
export function parseAnalysisQuery(query: unknown): AnalysisQueryResult {
  const q = (query ?? {}) as { from?: unknown; to?: unknown };
  const from = toNumber(q.from);
  const to = toNumber(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || !(to > from)) {
    return { ok: false, message: ANALYSIS_WINDOW_INVALID_MESSAGE };
  }
  if (to - from > ANALYSIS_MAX_WINDOW_SEC) return { ok: false, message: ANALYSIS_WINDOW_TOO_LONG_MESSAGE };
  return { ok: true, from, to };
}

/** Quantifie la fenêtre sur une grille de `ANALYSIS_QUANTUM_SEC` (clé de cache stable). */
export function quantizeWindow(from: number, to: number): { from: number; to: number; len: number } {
  const snap = (v: number) => Math.round(v / ANALYSIS_QUANTUM_SEC) * ANALYSIS_QUANTUM_SEC;
  const f = Math.max(0, snap(from));
  let len = snap(to - from);
  if (!(len > 0)) len = ANALYSIS_QUANTUM_SEC;
  if (len > ANALYSIS_MAX_WINDOW_SEC) len = ANALYSIS_MAX_WINDOW_SEC;
  return { from: f, to: f + len, len };
}

// ---------- lecture du journal ffmpeg ----------

/** Arrondi à 0,01 s (deux décimales), tel qu'exposé au client. */
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Durée totale annoncée par ffmpeg (`Duration: HH:MM:SS.ss`), ou `null`. */
export function parseMediaDurationSec(stderr: string): number | null {
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  if (!m) return null;
  const total = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(total) && total > 0 ? total : null;
}

/** Intervalle de silence en TEMPS ABSOLU (secondes), arrondi à 0,01 s. */
export type SilenceInterval = { startSec: number; endSec: number };

/**
 * Analyse la sortie d'erreur de `silencedetect` et renvoie les intervalles de
 * silence en temps ABSOLU (`offsetFrom + x`). Un `silence_start` non refermé
 * (silence courant jusqu'à la fin de la tranche) est refermé à `offsetFrom + len`.
 */
export function parseSilences(stderr: string, offsetFrom: number, windowLen: number): SilenceInterval[] {
  const re = /silence_(start|end):\s*(-?\d+(?:\.\d+)?)/g;
  const out: SilenceInterval[] = [];
  let pending: number | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stderr)) !== null) {
    const value = Number(m[2]);
    if (!Number.isFinite(value)) continue;
    if (m[1] === 'start') {
      pending = value;
    } else if (pending !== null) {
      out.push({ startSec: round2(offsetFrom + pending), endSec: round2(offsetFrom + value) });
      pending = null;
    }
  }
  if (pending !== null) {
    out.push({ startSec: round2(offsetFrom + pending), endSec: round2(offsetFrom + windowLen) });
  }
  return out;
}

// ---------- pics ----------

const clampUnit = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

/**
 * Réduit un PCM 16 bits mono (petit-boutiste) à `targetPoints` intervalles
 * `[min, max]` normalisés dans [-1, 1] et arrondis à deux décimales. Renvoie
 * moins de points si le tampon est plus court que la cible (jamais plus).
 */
export function computePeaks(pcm: Buffer, targetPoints: number = PEAK_POINTS): number[][] {
  const samples = Math.floor(pcm.length / 2);
  if (samples <= 0) return [];
  const points = Math.max(1, Math.min(targetPoints, samples));
  const out: number[][] = [];
  for (let p = 0; p < points; p++) {
    let start = Math.floor((p * samples) / points);
    let end = Math.floor(((p + 1) * samples) / points);
    if (end <= start) end = Math.min(samples, start + 1);
    let mn = 1;
    let mx = -1;
    for (let i = start; i < end; i++) {
      const v = pcm.readInt16LE(i * 2) / 32768;
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    if (mx < mn) {
      mn = 0;
      mx = 0;
    }
    out.push([clampUnit(round2(mn)), clampUnit(round2(mx))]);
  }
  return out;
}

// ---------- service (analyse + cache) ----------

/** Analyse d'une fenêtre, telle que renvoyée au client. */
export type AnalysisResult = {
  from: number;
  to: number;
  durationSec: number;
  peaks: number[][];
  silences: SilenceInterval[];
};

export type AnalysisServiceOptions = {
  runner?: AnalysisRunner;
  ttlMs?: number;
  maxEntries?: number;
  /** Créneaux ffmpeg simultanés autorisés (défaut 3) ; au-delà : 429. */
  maxConcurrent?: number;
};

export type AnalysisService = {
  /** Analyse (ou sert depuis le cache) la fenêtre `[from, to]` du média `id`. */
  analyze(id: string, file: string, from: number, to: number, knownDurationSec?: number): Promise<AnalysisResult>;
  /** Nombre d'entrées en cache (tests). */
  cacheSize(): number;
  /** Nombre d'analyses en vol (tests : doit retomber à zéro). */
  pending(): number;
};

/**
 * Construit le service d'analyse : cache mémoire clé par identifiant + fenêtre
 * quantifiée, TTL borné, taille plafonnée (éviction du plus ancien). Un second
 * appel identique dans le TTL NE relance PAS ffmpeg.
 */
export function createAnalysisService(opts: AnalysisServiceOptions = {}): AnalysisService {
  const runner = opts.runner ?? defaultAnalysisRunner;
  const ttlMs = opts.ttlMs ?? ANALYSIS_CACHE_TTL_MS;
  const maxEntries = opts.maxEntries ?? ANALYSIS_CACHE_MAX_ENTRIES;
  const maxConcurrent = Math.max(1, opts.maxConcurrent ?? ANALYSIS_MAX_CONCURRENT);
  const cache = new Map<string, { result: AnalysisResult; expiresAt: number }>();
  /**
   * Analyses EN VOL, clé par identifiant + fenêtre : N demandes identiques
   * simultanées partagent la MÊME promesse (et donc un seul ffmpeg), y compris
   * lorsqu'elle rejette. L'entrée disparaît au dénouement : un échec n'est jamais
   * mémorisé.
   */
  const inFlight = new Map<string, Promise<AnalysisResult>>();
  /** Créneaux ffmpeg occupés : borne l'occupation (jamais de file d'attente). */
  let running = 0;

  function remember(key: string, result: AnalysisResult, now: number): void {
    cache.delete(key);
    cache.set(key, { result, expiresAt: now + ttlMs });
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  return {
    analyze(id, file, from, to, knownDurationSec = 0): Promise<AnalysisResult> {
      const q = quantizeWindow(from, to);
      const key = `${id}|${q.from}|${q.len}`;
      const now = Date.now();
      const hit = cache.get(key);
      if (hit) {
        if (hit.expiresAt > now) return Promise.resolve(hit.result);
        cache.delete(key);
      }

      // Coalescence AVANT le plafond : rejoindre une analyse déjà en vol
      // n'occupe aucun créneau supplémentaire.
      const runningTask = inFlight.get(key);
      if (runningTask) return runningTask;

      if (running >= maxConcurrent) {
        return Promise.reject(new AnalysisError('busy', ANALYSIS_BUSY_MESSAGE));
      }
      running++;

      const task = (async (): Promise<AnalysisResult> => {
        try {
          let output: AnalysisRunnerOutput;
          try {
            output = await runner(file, q.from, q.len);
          } catch (err) {
            if (err instanceof AnalysisError) throw err;
            throw toAnalysisError(err);
          }

          const { pcm, stderr } = output;
          const announced = parseMediaDurationSec(stderr);
          const durationSec = announced !== null ? announced : knownDurationSec > 0 ? knownDurationSec : 0;

          // Fenêtre effective : tronquée à la durée du média, et JAMAIS inversée
          // (une demande entièrement au-delà de la fin devient `from === to`).
          let toEff = q.from + q.len;
          if (durationSec > 0) {
            if (toEff > durationSec) toEff = durationSec;
            if (toEff < q.from) toEff = q.from;
          }
          const effLen = Math.max(0, toEff - q.from);

          const peaks = effLen > 0 ? computePeaks(pcm, PEAK_POINTS) : [];
          const silences =
            effLen > 0 ? parseSilences(stderr, q.from, effLen).filter((s) => s.startSec <= round2(toEff)) : [];

          const result: AnalysisResult = {
            from: q.from,
            to: round2(toEff),
            durationSec: round2(durationSec),
            peaks,
            silences,
          };
          remember(key, result, Date.now());
          return result;
        } finally {
          running = Math.max(0, running - 1);
          inFlight.delete(key);
        }
      })();

      inFlight.set(key, task);
      return task;
    },
    cacheSize() {
      return cache.size;
    },
    /** Nombre d'analyses EN VOL (tests : le compteur doit retomber à zéro). */
    pending() {
      return running;
    },
  };
}
