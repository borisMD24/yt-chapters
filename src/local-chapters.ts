// Pipeline "chapitrage local" : média local -> chunks mp3 -> transcript Whisper
// (OpenRouter) -> chapitres (LLM OpenRouter). Le transcript reste EN MÉMOIRE :
// il n'est jamais écrit dans `transcript_segments` (le comportement YouTube
// existant de /videos/:id/transcript n'est pas touché).
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { chunkToMp3 } from './audio';
import { transcribeFile, stitchSegments, type ChunkTranscript } from './transcribe';
import { buildWarnings, chaptersToText, normalize, proposeChapters, type Proposed } from './chapters';
import type { Segment } from './youtube';

export type LocalChaptersOptions = {
  chunkSec?: number;
  lang?: string;
  maxChunks?: number;
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

export async function generateLocalChapters(
  input: string,
  opts: LocalChaptersOptions = {},
): Promise<LocalChaptersResult> {
  const abs = resolve(input);
  const videoId = localVideoId(abs);

  const { chunks, cleanup } = await chunkToMp3(abs, { chunkSec: opts.chunkSec, maxChunks: opts.maxChunks });
  try {
    if (!chunks.length) throw new Error('aucun chunk produit');

    // Durée couverte = somme des durées réelles des chunks (offsets mesurés).
    const durationSec = chunks.reduce((acc, c) => acc + c.durationSec, 0);

    const transcripts: ChunkTranscript[] = [];
    for (const c of chunks) {
      const res = await transcribeFile(c.path, {
        chunkDurationSec: c.durationSec,
        language: opts.lang,
        format: 'mp3',
      });
      transcripts.push({ startSec: c.startSec, segments: res.segments });
    }

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
