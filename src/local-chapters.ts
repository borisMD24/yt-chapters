// Pipeline "chapitrage local" : média local -> chunks mp3 -> transcript Whisper
// (OpenRouter) -> chapitres (LLM OpenRouter). Le transcript reste EN MÉMOIRE :
// il n'est jamais écrit dans `transcript_segments` (le comportement YouTube
// existant de /videos/:id/transcript n'est pas touché).
import { createHash } from 'node:crypto';
import { basename, resolve } from 'node:path';
import { and, eq } from 'drizzle-orm';
import { chunkToMp3 } from './audio';
import { transcribeFile, stitchSegments, stitchWords, type ChunkTranscript, type Word } from './transcribe';
import {
  buildWarnings,
  chaptersToText,
  normalize,
  proposeChapters,
  type ChaptersCompleter,
  type Proposed,
  MIN_GAP,
} from './chapters';
import type { Segment } from './youtube';
import { db } from './db';
import { chapters as chaptersTable, videos } from './db/schema';

export type LocalChaptersOptions = {
  chunkSec?: number;
  lang?: string;
  maxChunks?: number;
  /**
   * Espacement minimal (secondes) entre deux chapitres consécutifs, propre au
   * pipeline local (défaut : `CHAPTER_MIN_GAP_SEC`, sinon 180 s). Les chapitres
   * trop rapprochés sont écartés, sans être ni déplacés ni fusionnés.
   */
  minGapSec?: number;
  /**
   * Identifiant de vidéo à utiliser au lieu de l'id dérivé du chemin (envoi de
   * fichier : `local:up-<sha1 du contenu>`), afin que deux envois du même
   * fichier réutilisent la même ligne d'historique.
   */
  videoId?: string;
  /**
   * Progression optionnelle (défaut : silencieux, comportement inchangé).
   * `chunking` est émis avant puis après le passage ffmpeg (nombre de morceaux
   * connu au retour de `chunkToMp3`), `transcribing` AVANT chaque appel STT
   * (puis après chaque morceau réussi), puis `chaptering` avant l'appel au LLM.
   */
  onProgress?: (e: { phase: 'chunking' | 'transcribing' | 'chaptering'; doneChunks: number; totalChunks: number }) => void;
  /** Annulation coopérative : vérifiée entre les morceaux. */
  signal?: AbortSignal;
  /**
   * Couture de test (défaut : vrai client STT `transcribeFile`) : permet de
   * piloter le pipeline sans réseau ni coût.
   */
  transcribe?: typeof transcribeFile;
  /** Couture de test (défaut : appel LLM OpenRouter via `proposeChapters`). */
  complete?: ChaptersCompleter;
};

export type LocalChaptersResult = {
  videoId: string;
  title: string;
  durationSec: number;
  /**
   * Chemin ABSOLU du média analysé (fichier du cache d'envoi ou fichier de
   * MEDIA_DIR) : persisté dans `videos.media_path` pour servir la route média et
   * l'éditeur de bornes.
   */
  mediaPath: string;
  /** Transcript en mémoire (offsets absolus), non persisté. */
  segments: Segment[];
  /** Mots horodatés en mémoire (offsets absolus), non persistés. */
  words: Word[];
  chapters: Proposed[];
  text: string;
  warnings: string[];
};

/** Identifiant de vidéo synthétique stable : local:<sha1 du chemin absolu sur 16 hex>. */
export function localVideoId(path: string): string {
  const hash = createHash('sha1').update(resolve(path)).digest('hex').slice(0, 16);
  return `local:${hash}`;
}

/** Écart minimal par défaut entre deux chapitres d'un média local (3 minutes). */
export const DEFAULT_CHAPTER_MIN_GAP_SEC = 180;

/**
 * Résout l'écart minimal d'un chapitrage local, défensivement :
 * `CHAPTER_MIN_GAP_SEC` (180 s par défaut), jamais une valeur non finie ou
 * négative, et jamais moins que le minimum YouTube (10 s).
 */
export function resolveChapterMinGapSec(value?: number): number {
  const fromEnv = process.env.CHAPTER_MIN_GAP_SEC;
  const candidate = value ?? (fromEnv === undefined || fromEnv.trim() === '' ? NaN : Number(fromEnv));
  const parsed = Number(candidate);
  const gap = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_CHAPTER_MIN_GAP_SEC;
  return Math.max(MIN_GAP, Math.round(gap));
}

/**
 * Filtre glouton d'espacement : on garde le premier chapitre, puis chaque
 * chapitre seulement s'il commence au moins `minGapSec` après le dernier
 * conservé. Aucune invention, fusion ni renumérotation : les horodatages et
 * les titres du modèle sont conservés tels quels.
 *
 * Propre au pipeline local : le chemin YouTube partagé (`normalize`) n'est pas
 * concerné, car le modèle ignore la consigne de densité du prompt (12 chapitres
 * pour 10 minutes observés) et une description YouTube est limitée en taille.
 */
export function applyChapterSpacing(chapters: Proposed[], minGapSec: number): Proposed[] {
  const kept: Proposed[] = [];
  for (const chapter of chapters) {
    const last = kept[kept.length - 1];
    if (!last || chapter.startSec - last.startSec >= minGapSec) kept.push(chapter);
  }
  return kept;
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
  const videoId = opts.videoId && opts.videoId.trim() ? opts.videoId : localVideoId(abs);
  const report = opts.onProgress ?? (() => {});
  const transcribe = opts.transcribe ?? transcribeFile;

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
      // Annonce la transcription AVANT l'appel STT : sans cela, un échec du
      // tout premier appel était attribué au découpage (la phase ne basculait
      // qu'après le premier morceau réussi). `doneChunks` reste le nombre de
      // morceaux DÉJÀ terminés, donc la progression ne recule jamais.
      report({ phase: 'transcribing', doneChunks: transcripts.length, totalChunks: chunks.length });
      const res = await transcribe(c.path, {
        chunkDurationSec: c.durationSec,
        language: opts.lang,
        format: 'mp3',
      });
      transcripts.push({ startSec: c.startSec, segments: res.segments, words: res.words });
      report({ phase: 'transcribing', doneChunks: transcripts.length, totalChunks: chunks.length });
    }

    if (opts.signal?.aborted) throw abortError();
    report({ phase: 'chaptering', doneChunks: 0, totalChunks: 0 });

    const segments = stitchSegments(transcripts);
    // Précision par mot seulement si TOUS les chunks en fournissent : un chunk
    // sans mots serait sinon absent du transcript lisible (perte de texte muette).
    const words = transcripts.every((t) => (t.words?.length ?? 0) > 0) ? stitchWords(transcripts) : [];
    const title = basename(abs);
    // Densité contrôlée ici (et seulement ici) : le modèle ne respecte pas la
    // consigne « un chapitre toutes les 3 à 8 minutes ».
    const proposed = await proposeChapters({ title, durationSec, words }, segments, { complete: opts.complete });
    const chapters = applyChapterSpacing(proposed, resolveChapterMinGapSec(opts.minGapSec));

    return {
      videoId,
      title,
      durationSec,
      mediaPath: abs,
      segments,
      words,
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
 * `local:<sha1>`, chemin du média compris) et les chapitres générés
 * (`source = llm`) dans une transaction. Les chapitres LLM non validés
 * précédents sont remplacés, comme `/videos/:id/chapters/generate`.
 * Implémentation unique partagée par la route `/local/chapters` et le registre
 * de jobs.
 */
export function persistLocalChapters(result: LocalChaptersResult): void {
  db.transaction((tx) => {
    tx.insert(videos)
      .values({
        id: result.videoId,
        title: result.title,
        channel: null,
        durationSec: Math.round(result.durationSec),
        mediaPath: result.mediaPath,
      })
      .onConflictDoUpdate({
        target: videos.id,
        set: {
          title: result.title,
          durationSec: Math.round(result.durationSec),
          ...(result.mediaPath ? { mediaPath: result.mediaPath } : {}),
        },
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
        .values(
          result.chapters.map((c) => ({
            videoId: result.videoId,
            // Secondes ENTIÈRES : YouTube n'accepte que cela -> arrondi au plus proche.
            startSec: Math.round(c.startSec),
            title: c.title,
            source: 'llm' as const,
          })),
        )
        .run();
    }
  });
}
