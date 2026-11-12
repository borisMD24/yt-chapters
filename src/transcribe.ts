// Client STT OpenRouter (endpoint /audio/transcriptions, Whisper large v3 turbo)
// et recollage horodaté des chunks. On utilise `fetch` brut (pas le SDK openai)
// car cet endpoint n'est pas exposé par le SDK.
//
// Précision : les horodatages NATIFS de Whisper sont au niveau SEGMENT et
// grossiers (souvent arrondis à la seconde). Le levier documenté pour la
// précision est la GRANULARITÉ : on demande donc `timestamp_granularities` par
// mot (sub-100 ms mesuré), avec une échelle de repli si le provider routé
// refuse la combinaison demandée.
import { readFile } from 'node:fs/promises';
import { resolveOpenRouterKey } from './openrouter-key';
import { groupWordsIntoSentences, type Word } from './words';
import type { Segment } from './youtube';

export type { Word };

export const DEFAULT_BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const STT_MODEL = process.env.STT_MODEL ?? 'openai/whisper-large-v3-turbo';

export type TranscribeOpts = {
  bytes: Uint8Array;
  /** Durée du chunk, utilisée pour le repli "single segment". */
  chunkDurationSec: number;
  format?: string;
  language?: string;
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  /** Seam injectable pour les tests (mocked fetch). */
  fetchImpl?: typeof fetch;
  /** Seam injectable pour le backoff (tests sans attente réelle). */
  sleep?: (ms: number) => Promise<void>;
  maxRetries?: number;
};

export type TranscribeResult = { segments: Segment[]; words: Word[]; fallback: boolean };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const normText = (t: string) => t.replace(/\s+/g, ' ').trim();

type RawWord = { word?: string; start?: number; end?: number };
type VerboseJson = {
  segments?: { start?: number; end?: number; text?: string }[];
  words?: RawWord[];
  text?: string;
};

/** Granularités de temps demandées, du plus précis au repli le moins précis. */
type Rung = { responseFormat: 'verbose_json' | 'json'; granularities?: string[] };

/**
 * Échelle de repli : d'abord la combinaison la plus riche, puis `word` seul,
 * puis le `verbose_json` historique, enfin le `json` simple. On ne descend d'un
 * cran que si le provider ROUTÉ refuse explicitement (4xx). Le budget de
 * réessais par cran (429/5xx, backoff) reste celui d'avant.
 */
const LADDER: readonly Rung[] = [
  { responseFormat: 'verbose_json', granularities: ['word', 'segment'] },
  { responseFormat: 'verbose_json', granularities: ['word'] },
  { responseFormat: 'verbose_json' },
  { responseFormat: 'json' },
];

/**
 * Statuts qui signifient « ce provider n'accepte pas ces paramètres » : SEULS
 * ceux-là font avancer l'échelle de repli. Tout le reste (auth, crédit, timeout,
 * charge, 429/5xx déjà épuisés) doit remonter sans autre appel : changer de
 * format ne corrigerait rien et ne ferait que multiplier les aller-retours STT.
 */
const FORMAT_REFUSAL_STATUSES = new Set([400, 404, 415, 422]);

/** Mots horodatés (offsets relatifs au chunk ; l'offset de chunk est ajouté au recollage). */
function parseWords(raw?: RawWord[]): Word[] {
  return (raw ?? [])
    .map((w) => ({
      word: normText(String(w.word ?? '')),
      startSec: Number(w.start ?? 0),
      endSec: Number(w.end ?? 0),
    }))
    .filter((w) => w.word.length > 0 && Number.isFinite(w.startSec) && Number.isFinite(w.endSec));
}

/** Segments grossiers dérivés des mots, quand le provider ne renvoie que `words`. */
export function deriveSegmentsFromWords(words: Word[]): Segment[] {
  return groupWordsIntoSentences(words)
    .map((l) => ({ startSec: l.startSec, endSec: l.endSec, text: l.text }))
    .filter((s) => s.text.length > 0);
}

function parseSegments(raw?: { start?: number; end?: number; text?: string }[]): Segment[] {
  return (raw ?? [])
    .map((s) => ({
      startSec: Number(s.start ?? 0),
      endSec: Number(s.end ?? 0),
      text: normText(s.text ?? ''),
    }))
    .filter((s) => s.text.length > 0);
}

function parseVerbose(
  j: VerboseJson,
  chunkDurationSec: number,
): { segments: Segment[]; words: Word[] } {
  const words = parseWords(j.words);
  let segs = parseSegments(j.segments);
  // Le provider peut ne renvoyer QUE les mots : on dérive des segments grossiers
  // pour que le reste du pipeline (transcript, repli, affichage) continue de marcher.
  if (!segs.length && words.length) segs = deriveSegmentsFromWords(words);
  if (segs.length) return { segments: segs, words };
  const t = normText(j.text ?? '');
  return { segments: t ? [{ startSec: 0, endSec: chunkDurationSec, text: t }] : [], words };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return '';
  }
}

/** Transcrit un chunk audio via OpenRouter, avec repli json si verbose_json est refusé. */
export async function transcribeChunk(o: TranscribeOpts): Promise<TranscribeResult> {
  // Clé explicite (seam de test) ou clé effective (base d'abord, puis `.env`) :
  // une valeur restée à l'exemple est traitée comme absente, donc l'échec arrive
  // AVANT tout appel réseau, avec un message actionnable plutôt qu'un 401 ambigu.
  const apiKey = o.apiKey ?? resolveOpenRouterKey().key;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY manquante');
  const baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = o.model ?? STT_MODEL;
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? 3;
  const format = o.format ?? 'mp3';
  const data = Buffer.from(o.bytes).toString('base64'); // base64 brut, sans préfixe data:

  const attempt = (rung: Rung) => {
    const body: Record<string, unknown> = {
      model,
      input_audio: { data, format },
      response_format: rung.responseFormat,
    };
    if (rung.granularities) body.timestamp_granularities = rung.granularities;
    if (o.language) body.language = o.language;
    return doFetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  // Réessaie avec backoff exponentiel sur 429/5xx ; renvoie les autres statuts tels quels.
  const postWithRetry = async (rung: Rung): Promise<Response> => {
    for (let i = 0; i <= maxRetries; i++) {
      const res = await attempt(rung);
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      if (i < maxRetries) await sleep(500 * 2 ** i);
      else return res;
    }
    throw new Error('unreachable');
  };

  // Échelle de repli : on ne descend d'un cran QUE si le provider refuse
  // explicitement les paramètres (liste blanche : 400/404/415/422). Tout autre
  // statut — auth/crédit (401/402/403), timeout (408), charge (413), 429/5xx
  // déjà épuisés par `postWithRetry` — remonte immédiatement, sans autre appel.
  // Une erreur réseau lève dans `postWithRetry` et se propage telle quelle.
  let lastError = '';
  for (const rung of LADDER) {
    const res = await postWithRetry(rung);
    if (res.ok) {
      if (rung.responseFormat === 'json') {
        const { text } = (await res.json()) as { text?: string };
        const clean = normText(text ?? '');
        return {
          segments: clean ? [{ startSec: 0, endSec: o.chunkDurationSec, text: clean }] : [],
          words: [],
          fallback: true,
        };
      }
      const { segments, words } = parseVerbose((await res.json()) as VerboseJson, o.chunkDurationSec);
      return { segments, words, fallback: false };
    }
    lastError = `${res.status}: ${await safeText(res)}`;
    if (!FORMAT_REFUSAL_STATUSES.has(res.status)) {
      throw new Error(`OpenRouter STT ${lastError}`);
    }
  }
  throw new Error(`OpenRouter STT ${lastError}`);
}

/** Lit un fichier mp3 et le transcrit (wrapper pratique pour le pipeline). */
export async function transcribeFile(
  file: string,
  o: Omit<TranscribeOpts, 'bytes'>,
): Promise<TranscribeResult> {
  return transcribeChunk({ ...o, bytes: await readFile(file) });
}

export type ChunkTranscript = { startSec: number; segments: Segment[]; words?: Word[] };

/** Recale chaque segment sur l'offset absolu de son chunk, puis trie par début. */
export function stitchSegments(chunks: ChunkTranscript[]): Segment[] {
  const out: Segment[] = [];
  for (const c of chunks) {
    for (const s of c.segments) {
      out.push({ startSec: c.startSec + s.startSec, endSec: c.startSec + s.endSec, text: s.text });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}

/**
 * Recale chaque mot sur l'offset ABSOLU de son chunk (offset ajouté), puis trie
 * par début. Les mots restent en mémoire : ils ne sont jamais persistés.
 */
export function stitchWords(chunks: ChunkTranscript[]): Word[] {
  const out: Word[] = [];
  for (const c of chunks) {
    for (const w of c.words ?? []) {
      out.push({ startSec: c.startSec + w.startSec, endSec: c.startSec + w.endSec, word: w.word });
    }
  }
  return out.sort((a, b) => a.startSec - b.startSec);
}
