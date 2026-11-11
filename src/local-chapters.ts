// Pipeline "chapitrage local" : média local -> chunks mp3 -> transcript Whisper
// (OpenRouter) -> chapitres (LLM OpenRouter). Le transcript reste EN MÉMOIRE :
// il n'est jamais écrit dans `transcript_segments` (le comportement YouTube
// existant de /videos/:id/transcript n'est pas touché).
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { chunkToMp3 } from './audio';
import { transcribeFile, stitchSegments, type ChunkTranscript } from './transcribe';
import { buildWarnings, chaptersToText, normalize, proposeChapters, type Proposed } from './chapters';
import type { Segment } from './youtube';
import { db } from './db';
import { chapters as chaptersTable, videos } from './db/schema';

export type LocalChaptersOptions = {
  chunkSec?: number;
  lang?: string;
  maxChunks?: number;
  /**
   * Progression optionnelle (défaut : silencieux, comportement inchangé).
   * `chunking` est émis avant puis après le passage ffmpeg (nombre de morceaux
   * connu au retour de `chunkToMp3`), `transcribing` après chaque morceau,
   * puis `chaptering` avant l'appel au LLM.
   */
  onProgress?: (e: { phase: 'chunking' | 'transcribing' | 'chaptering'; doneChunks: number; totalChunks: number }) => void;
  /** Annulation coopérative : vérifiée entre les morceaux. */
  signal?: AbortSignal;
};

export type LocalChaptersResult = {
  videoId: string;
  title: string;
  durationSec: number;
  /** Transcript en mémoire (offsets absolus), non persisté. */
  segments: Segment[];
  chapters: Proposed[];
  text: string;
  warnings: string[];
};

/** Identifiant de vidéo synthétique stable : local:<sha1 du chemin absolu sur 16 hex>. */
export function localVideoId(path: string): string {
  const hash = createHash('sha1').update(resolve(path)).digest('hex').slice(0, 16);
  return `local:${hash}`;
}

/** Erreur posée quand un job est annulé en cours de route. */
function abortError(): Error {
  const err = new Error('traitement annulé');
  err.name = 'AbortError';
  return err;
}

export async function generateLocalChapters(
  input: string,
  opts: LocalChaptersOptions = {},
): Promise<LocalChaptersResult> {
  const abs = resolve(input);
  const videoId = localVideoId(abs);
  const report = opts.onProgress ?? (() => {});

  if (opts.signal?.aborted) throw abortError();
  report({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
  const { chunks, cleanup } = await chunkToMp3(abs, { chunkSec: opts.chunkSec, maxChunks: opts.maxChunks });
  try {
    if (!chunks.length) throw new Error('aucun chunk produit');
    report({ phase: 'chunking', doneChunks: chunks.length, totalChunks: chunks.length });

    // Durée couverte = somme des durées réelles des chunks (offsets mesurés).
    const durationSec = chunks.reduce((acc, c) => acc + c.durationSec, 0);

    const transcripts: ChunkTranscript[] = [];
    for (const c of chunks) {
      if (opts.signal?.aborted) throw abortError();
      const res = await transcribeFile(c.path, {
        chunkDurationSec: c.durationSec,
        language: opts.lang,
        format: 'mp3',
      });
      transcripts.push({ startSec: c.startSec, segments: res.segments });
      report({ phase: 'transcribing', doneChunks: transcripts.length, totalChunks: chunks.length });
    }

    if (opts.signal?.aborted) throw abortError();
    report({ phase: 'chaptering', doneChunks: 0, totalChunks: 0 });

    const segments = stitchSegments(transcripts);
    const title = basename(abs);
    const chapters = await proposeChapters({ title, durationSec }, segments);

    return {
      videoId,
      title,
      durationSec,
      segments,
      chapters,
      text: chaptersToText(chapters),
      warnings: buildWarnings(chapters),
    };
  } finally {
    await cleanup();
  }
}

/**
 * Persiste le résultat d'un chapitrage local : une ligne `videos` (id synthétique
 * `local:<sha1>`) et les chapitres générés (`source = llm`) dans une transaction.
 * Les chapitres LLM non validés précédents sont remplacés, comme
 * `/videos/:id/chapters/generate`. Implémentation unique partagée par la route
 * `/local/chapters` et le registre de jobs.
 */
export function persistLocalChapters(result: LocalChaptersResult): void {
  db.transaction((tx) => {
    tx.insert(videos)
      .values({
        id: result.videoId,
        title: result.title,
        channel: null,
        durationSec: Math.round(result.durationSec),
      })
      .onConflictDoUpdate({
        target: videos.id,
        set: { title: result.title, durationSec: Math.round(result.durationSec) },
      })
      .run();

    tx.delete(chaptersTable)
      .where(
        and(
          eq(chaptersTable.videoId, result.videoId),
          eq(chaptersTable.source, 'llm'),
          eq(chaptersTable.validated, false),
        ),
      )
      .run();
    if (result.chapters.length) {
      tx.insert(chaptersTable)
        .values(result.chapters.map((c) => ({ videoId: result.videoId, ...c, source: 'llm' as const })))
        .run();
    }
  });
}
