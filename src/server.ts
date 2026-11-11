import Fastify from 'fastify';
import { z } from 'zod';
import { and, asc, eq } from 'drizzle-orm';
import { db } from './db';
import { videos, segments, chapters } from './db/schema';
import { fetchMeta, fetchTranscript, listChannelVideos } from './youtube';
import { proposeChapters, buildWarnings, chaptersToText } from './chapters';
import { generateLocalChapters } from './local-chapters';

const app = Fastify({ logger: true });

app.setErrorHandler((err, _req, reply) => {
  if (err instanceof z.ZodError) return reply.code(400).send({ error: err.flatten() });
  app.log.error(err);
  return reply.code(500).send({ error: err instanceof Error ? err.message : 'internal error' });
});

const idParam = z.object({ id: z.string().min(1) });
const numId = z.object({ id: z.coerce.number().int() });

// ---------- helpers ----------

async function ensureTranscript(videoId: string) {
  const read = () =>
    db
      .select()
      .from(segments)
      .where(eq(segments.videoId, videoId))
      .orderBy(asc(segments.startSec))
      .all();

  const existing = read();
  if (existing.length) return existing;

  const tr = await fetchTranscript(videoId);
  if (!tr) return null;

  db.transaction((tx) => {
    for (let i = 0; i < tr.segments.length; i += 500) {
      tx.insert(segments)
        .values(tr.segments.slice(i, i + 500).map((s) => ({ videoId, ...s })))
        .run();
    }
    tx.update(videos).set({ transcriptLang: tr.lang }).where(eq(videos.id, videoId)).run();
  });
  return read();
}

function upsertVideo(m: { id: string; title: string; channel: string | null; durationSec: number }) {
  db.insert(videos)
    .values(m)
    .onConflictDoUpdate({
      target: videos.id,
      set: {
        title: m.title,
        channel: m.channel,
        ...(m.durationSec > 0 ? { durationSec: m.durationSec } : {}),
      },
    })
    .run();
}

// ---------- videos ----------

app.post('/videos', async (req, reply) => {
  const { url } = z.object({ url: z.string().min(1) }).parse(req.body);
  const meta = await fetchMeta(url);
  upsertVideo(meta);
  return reply.code(201).send(meta);
});

// Importe toutes les vidéos d'une chaîne (ex: https://www.youtube.com/@toi/videos)
app.post('/channel/sync', async (req) => {
  const { channelUrl } = z.object({ channelUrl: z.string().url() }).parse(req.body);
  const list = await listChannelVideos(channelUrl);
  db.transaction(() => list.forEach(upsertVideo));
  return { imported: list.length };
});

app.get('/videos', async () => db.select().from(videos).all());

app.get('/videos/:id', async (req, reply) => {
  const { id } = idParam.parse(req.params);
  const video = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!video) return reply.code(404).send({ error: 'video not found' });
  const chs = db
    .select()
    .from(chapters)
    .where(eq(chapters.videoId, id))
    .orderBy(asc(chapters.startSec))
    .all();
  return { ...video, chapters: chs };
});

app.get('/videos/:id/transcript', async (req, reply) => {
  const { id } = idParam.parse(req.params);
  const segs = await ensureTranscript(id);
  if (!segs) return reply.code(422).send({ error: 'no transcript available' });
  return segs;
});

// ---------- chapters ----------

// L'IA propose : remplace les chapitres LLM non validés, garde le reste
app.post('/videos/:id/chapters/generate', async (req, reply) => {
  const { id } = idParam.parse(req.params);
  let video = db.select().from(videos).where(eq(videos.id, id)).get();
  if (!video) return reply.code(404).send({ error: 'video not found' });

  if (video.durationSec === 0) {
    upsertVideo(await fetchMeta(id));
    video = db.select().from(videos).where(eq(videos.id, id)).get()!;
  }

  const segs = await ensureTranscript(id);
  if (!segs) return reply.code(422).send({ error: 'no transcript available' });

  const proposed = await proposeChapters(video, segs);

  db.transaction((tx) => {
    tx.delete(chapters)
      .where(and(eq(chapters.videoId, id), eq(chapters.source, 'llm'), eq(chapters.validated, false)))
      .run();
    if (proposed.length) {
      tx.insert(chapters)
        .values(proposed.map((c) => ({ videoId: id, ...c, source: 'llm' as const })))
        .run();
    }
  });

  return db
    .select()
    .from(chapters)
    .where(eq(chapters.videoId, id))
    .orderBy(asc(chapters.startSec))
    .all();
});

// Ajout manuel (considéré comme validé)
app.post('/videos/:id/chapters', async (req, reply) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ startSec: z.number().int().min(0), title: z.string().min(1).max(100) })
    .parse(req.body);
  const row = db
    .insert(chapters)
    .values({ videoId: id, ...body, source: 'manual', validated: true })
    .returning()
    .get();
  return reply.code(201).send(row);
});

// Correction : toute modif valide le chapitre sauf si précisé
app.patch('/chapters/:id', async (req, reply) => {
  const { id } = numId.parse(req.params);
  const body = z
    .object({
      startSec: z.number().int().min(0).optional(),
      title: z.string().min(1).max(100).optional(),
      validated: z.boolean().optional(),
    })
    .parse(req.body);
  const row = db
    .update(chapters)
    .set({ ...body, validated: body.validated ?? true })
    .where(eq(chapters.id, id))
    .returning()
    .get();
  if (!row) return reply.code(404).send({ error: 'chapter not found' });
  return row;
});

app.delete('/chapters/:id', async (req, reply) => {
  const { id } = numId.parse(req.params);
  db.delete(chapters).where(eq(chapters.id, id)).run();
  return reply.code(204).send();
});

// Valide d'un coup tous les chapitres proposés par l'IA
app.post('/videos/:id/chapters/validate-all', async (req) => {
  const { id } = idParam.parse(req.params);
  db.update(chapters).set({ validated: true }).where(eq(chapters.videoId, id)).run();
  return { ok: true };
});

// Export au format description YouTube
app.get('/videos/:id/export', async (req) => {
  const { id } = idParam.parse(req.params);
  const chs = db
    .select()
    .from(chapters)
    .where(eq(chapters.videoId, id))
    .orderBy(asc(chapters.startSec))
    .all();

  const warnings = buildWarnings(chs, { includePending: true });
  return { text: chaptersToText(chs), warnings };
});

// ---------- local media ----------

// Chapitrage d'un média LOCAL (vidéo ou audio) : découpe ffmpeg -> STT OpenRouter
// -> chapitres LLM. Le transcript reste en mémoire (pas d'écriture dans transcript_segments).
app.post('/local/chapters', async (req) => {
  const body = z
    .object({
      path: z.string().min(1),
      chunkSec: z.number().int().positive().optional(),
      lang: z.string().min(2).optional(),
      maxChunks: z.number().int().positive().optional(),
    })
    .parse(req.body);

  const result = await generateLocalChapters(body.path, {
    chunkSec: body.chunkSec,
    lang: body.lang,
    maxChunks: body.maxChunks,
  });

  // Persiste la vidéo (id synthétique) et les chapitres générés, dans une transaction.
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

    // Remplace les chapitres LLM non validés, comme /videos/:id/chapters/generate.
    tx.delete(chapters)
      .where(
        and(eq(chapters.videoId, result.videoId), eq(chapters.source, 'llm'), eq(chapters.validated, false)),
      )
      .run();
    if (result.chapters.length) {
      tx.insert(chapters)
        .values(result.chapters.map((c) => ({ videoId: result.videoId, ...c, source: 'llm' as const })))
        .run();
    }
  });

  return { chapters: result.chapters, text: result.text, warnings: result.warnings };
});

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' });
