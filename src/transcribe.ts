// Client STT OpenRouter (endpoint /audio/transcriptions, Whisper large v3 turbo)
// et recollage horodaté des chunks. On utilise `fetch` brut (pas le SDK openai)
// car cet endpoint n'est pas exposé par le SDK.
import { readFile } from 'node:fs/promises';
import type { Segment } from './youtube';

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

export type TranscribeResult = { segments: Segment[]; fallback: boolean };

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const normText = (t: string) => t.replace(/\s+/g, ' ').trim();

type VerboseJson = {
  segments?: { start?: number; end?: number; text?: string }[];
  text?: string;
};

function parseVerbose(j: VerboseJson, chunkDurationSec: number): Segment[] {
  const segs = (j.segments ?? [])
    .map((s) => ({
      startSec: Number(s.start ?? 0),
      endSec: Number(s.end ?? 0),
      text: normText(s.text ?? ''),
    }))
    .filter((s) => s.text.length > 0);
  if (segs.length) return segs;
  const t = normText(j.text ?? '');
  return t ? [{ startSec: 0, endSec: chunkDurationSec, text: t }] : [];
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
  const apiKey = o.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY manquante');
  const baseUrl = (o.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
  const model = o.model ?? STT_MODEL;
  const doFetch = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? defaultSleep;
  const maxRetries = o.maxRetries ?? 3;
  const format = o.format ?? 'mp3';
  const data = Buffer.from(o.bytes).toString('base64'); // base64 brut, sans préfixe data:

  const attempt = (responseFormat: 'verbose_json' | 'json') => {
    const body: Record<string, unknown> = {
      model,
      input_audio: { data, format },
      response_format: responseFormat,
    };
    if (o.language) body.language = o.language;
    return doFetch(`${baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  };

  // Réessaie avec backoff exponentiel sur 429/5xx ; renvoie les autres statuts tels quels.
  const postWithRetry = async (fmt: 'verbose_json' | 'json'): Promise<Response> => {
    for (let i = 0; i <= maxRetries; i++) {
      const res = await attempt(fmt);
      if (res.ok || (res.status !== 429 && res.status < 500)) return res;
      if (i < maxRetries) await sleep(500 * 2 ** i);
      else return res;
    }
    throw new Error('unreachable');
  };

  const first = await postWithRetry('verbose_json');
  if (first.ok) {
    return { segments: parseVerbose((await first.json()) as VerboseJson, o.chunkDurationSec), fallback: false };
  }
  if (first.status === 429 || first.status >= 500) {
    throw new Error(`OpenRouter STT ${first.status}: ${await safeText(first)}`);
  }

  // 4xx : le provider routé refuse verbose_json -> repli sur json simple.
  const second = await postWithRetry('json');
  if (!second.ok) throw new Error(`OpenRouter STT ${second.status}: ${await safeText(second)}`);
  const { text } = (await second.json()) as { text?: string };
  const clean = normText(text ?? '');
  return {
    segments: clean ? [{ startSec: 0, endSec: o.chunkDurationSec, text: clean }] : [],
    fallback: true,
  };
}

/** Lit un fichier mp3 et le transcrit (wrapper pratique pour le pipeline). */
export async function transcribeFile(
  file: string,
  o: Omit<TranscribeOpts, 'bytes'>,
): Promise<TranscribeResult> {
  return transcribeChunk({ ...o, bytes: await readFile(file) });
}

export type ChunkTranscript = { startSec: number; segments: Segment[] };

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
