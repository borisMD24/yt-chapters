// Construction de l'application Fastify (routes HTTP + page HTML servie).
// `createApp` renvoie l'instance sans écouter : `src/server.ts` est le point
// d'entrée qui appelle `listen`. Le pipeline de chapitrage local est injectable
// (`options.pipeline`) pour les tests, sans toucher aux routes existantes.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, basename, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { and, asc, desc, eq, like, sql } from 'drizzle-orm';
import { db, dbPath } from './db';
import { videos, segments, chapters } from './db/schema';
import { fetchMeta, fetchTranscript, listChannelVideos } from './youtube';
import { proposeChapters, buildWarnings, chaptersToText, LLM_MODEL } from './chapters';
import { generateLocalChapters, persistLocalChapters } from './local-chapters';
import { createJobRegistry, type JobFailureLogger, type JobInput, type JobPipeline } from './jobs';
import {
  MEDIA_EXTENSIONS,
  UploadError,
  clearUploadCache,
  findCacheFileByHash,
  isPartialUploadName,
  saveUpload,
  sweepStaleUploads,
  sweepUploadCache,
  uploadCacheDir,
  uploadCacheStats,
  uploadRetentionDays,
} from './upload';
import {
  MEDIA_NOT_FOUND_MESSAGE,
  isInsideDir,
  mediaContentType,
  parseSingleRange,
  resolveMediaFile,
} from './media-files';
import {
  checkTools,
  defaultToolChecker,
  MEDIA_UNREADABLE_MESSAGE,
  probeHasVideo,
  type ToolChecker,
} from './media-check';
import {
  OPENROUTER_KEY_INVALID_MESSAGE,
  clearOpenRouterKey,
  openRouterKeyReport,
  openRouterKeyStatus,
  resolveOpenRouterKey,
  storeOpenRouterKey,
} from './openrouter-key';
import { testOpenRouterKey } from './openrouter-key-test';
import { createCreditsProvider, type CreditsProvider } from './openrouter-credits';

// Une seule source de vérité pour les extensions acceptées (liste MEDIA_DIR
// et envoi de fichier).
export { MEDIA_EXTENSIONS } from './upload';

/**
 * Durée minimale des morceaux demandable à l'interface (secondes). Le champ de
 * la page annonce `min="30"` : on l'applique réellement côté serveur, sinon une
 * valeur pathologique (1 s) créerait des milliers de morceaux et autant d'appels
 * ffprobe.
 */
export const MIN_CHUNK_SEC_UI = 30;

/** Message d'erreur (français) d'une durée de morceau trop courte. */
export const CHUNK_SEC_TOO_SHORT_MESSAGE = `Durée des morceaux invalide : indiquez au moins ${MIN_CHUNK_SEC_UI} secondes.`;

/** Message d'erreur (français) : administration réservée à la boucle locale. */
export const ADMIN_LOOPBACK_ONLY_MESSAGE =
  "L'administration n'est possible que depuis cet ordinateur (adresse locale 127.0.0.1). Cette action a été refusée.";

/** Message d'erreur (français) : aucune clé à tester. */
export const OPENROUTER_KEY_ABSENT_MESSAGE =
  "Aucune clé OpenRouter n'est configurée : enregistrez-en une avant de la tester.";

/** Message d'erreur (français) : écriture de la clé impossible. */
export const ADMIN_STORE_FAILED_MESSAGE =
  "Impossible d'enregistrer la clé dans la base de données. Vérifiez que le dossier est accessible en écriture, puis réessayez.";

/** Message d'erreur (français) : le chapitrage demandé n'existe pas. */
export const VIDEO_NOT_FOUND_MESSAGE =
  "Ce chapitrage est introuvable. Il a peut-être été supprimé : revenez à l'accueil et rechargez la liste.";

/**
 * Vrai si l'adresse d'un client est la boucle locale. Les écritures et le test
 * de clé sont réservés à cet ordinateur ; la lecture (`GET /admin/settings`)
 * reste ouverte mais ne révèle jamais la clé.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export type AppOptions = {
  /** Pipeline de chapitrage injectable (tests) ; par défaut, le pipeline réel. */
  pipeline?: JobPipeline;
  /** Journalisation Fastify (désactivée dans les tests). */
  logger?: boolean;
  /** Nettoyage des dossiers d'envoi abandonnés au démarrage (défaut : oui). */
  sweepStaleUploads?: boolean;
  /** Vérification ffmpeg/ffprobe injectable (tests, endpoint de santé). */
  toolChecker?: ToolChecker;
  /** Trace serveur des échecs de job (tests) ; par défaut `app.log.error`. */
  jobLogger?: JobFailureLogger;
  /** Détection des outils au démarrage (défaut : oui). */
  preflight?: boolean;
  /** `fetch` injectable pour le test de clé OpenRouter (tests, jamais le réseau). */
  keyTestFetch?: typeof fetch;
  /** Fournisseur de crédits injectable (tests) ; par défaut, cache 60 s + réseau. */
  credits?: CreditsProvider;
  /** `fetch` injectable pour la lecture des crédits (tests, jamais le réseau). */
  creditsFetch?: typeof fetch;
  /** Durée de cache des crédits en millisecondes (tests). */
  creditsTtlMs?: number;
};

const idParam = z.object({ id: z.string().min(1) });
const numId = z.object({ id: z.coerce.number().int() });

// ---------- média local : dossier, liste, garde-fous ----------

const MEDIA_EXT_SET = new Set<string>(MEDIA_EXTENSIONS);

/** Dossier des médias : `MEDIA_DIR` sinon deux niveaux au-dessus du projet. */
export function mediaDir(): string {
  const fromEnv = process.env.MEDIA_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(process.cwd(), '..', '..');
}

/**
 * Dossier des journaux écrits par `Démarrer.cmd` / `scripts/launch.ps1`
 * (`logs/`, ignoré par git). Le serveur ne les écrit pas lui-même : il se
 * contente d'indiquer où ils se trouvent, à l'écran comme dans `/admin`.
 */
export function logsDir(): string {
  const fromEnv = process.env.CKR_LOGS_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(process.cwd(), 'logs');
}

/**
 * Vrai si `target` (déjà résolu) est un fichier situé dans `dir`.
 * Ré-exporté depuis `./media-files` pour ne garder qu'une seule définition.
 */
export { isInsideDir };

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function listMediaFiles(dir: string): Promise<{ name: string; path: string; sizeMB: number }[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: { name: string; path: string; sizeMB: number }[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!MEDIA_EXT_SET.has(extname(entry.name).toLowerCase())) continue;
    const full = join(dir, entry.name);
    let sizeMB: number;
    try {
      sizeMB = Math.round(((await stat(full)).size / 1e6) * 10) / 10;
    } catch {
      continue; // fichier disparu entre-temps
    }
    files.push({ name: entry.name, path: full, sizeMB });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, 'fr'));
}

// ---------- application ----------

export function createApp(options: AppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof z.ZodError) return reply.code(400).send({ error: err.flatten() });
    app.log.error(err);
    return reply.code(500).send({ error: err instanceof Error ? err.message : 'internal error' });
  });

  // Préflight : ffmpeg et ffprobe sont-ils exécutables, et à quelle version ?
  // Non bloquant et jamais fatal : le serveur démarre même sans eux, mais
  // l'absence est visible dans le terminal ET via GET /local/health.
  const toolChecker = options.toolChecker ?? defaultToolChecker;
  if (options.preflight !== false) {
    void checkTools(toolChecker).then((tools) => {
      if (!tools.ffmpeg.ok || !tools.ffprobe.ok) {
        app.log.warn(
          { ffmpeg: tools.ffmpeg, ffprobe: tools.ffprobe },
          'ffmpeg ou ffprobe introuvable : le chapitrage local ne pourra pas fonctionner.',
        );
      } else {
        app.log.info(
          { ffmpeg: tools.ffmpeg.version, ffprobe: tools.ffprobe.version },
          'Outils média détectés (ffmpeg, ffprobe).',
        );
      }
    });
  }

  // Crédits OpenRouter : instantanés en cache 60 s, jamais la clé. Un seul
  // fournisseur par application, partagé par `/admin/credits` et la page.
  const credits =
    options.credits ??
    createCreditsProvider({ fetchImpl: options.creditsFetch, ttlMs: options.creditsTtlMs });

  // Envoi de fichier : le corps brut (flux) est remis tel quel à la route, qui
  // l'écrit au fur et à mesure. Aucun tamponnage mémoire, donc aucune limite
  // implicite de Fastify : le plafond est appliqué par `saveUpload`.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));

  // Rattrapage des dossiers d'envoi laissés par un arrêt brutal (fichier
  // temporaire jamais récupéré). Non bloquant ; seuls les dossiers vraiment
  // abandonnés (plus vieux qu'une heure) sont supprimés.
  // Au même moment : rétention du CACHE d'envoi (les médias conservés pour
  // l'éditeur de bornes sont purgés au-delà de `UPLOAD_RETENTION_DAYS`).
  if (options.sweepStaleUploads !== false) {
    void sweepStaleUploads().catch(() => {});
    void sweepUploadCache().catch(() => {});
  }

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

  // ---------- page ----------

  app.get('/', async (_req, reply) => {
    const html = await readFile(new URL('./web/index.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Éditeur de bornes : page dédiée (vanilla, même style), qui charge le média
  // et les chapitres côté navigateur via `GET /videos/:id/edit`.
  app.get('/edit', async (_req, reply) => {
    const html = await readFile(new URL('./web/edit.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

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

  /**
   * Charge l'éditeur de bornes : identifiant, titre, durée, présence d'une piste
   * vidéo (sonde réelle, pour choisir `<video>` ou `<audio>`), URL du média et
   * chapitres. Lecture seule : les modifications passent par les routes
   * existantes (`PATCH /chapters/:id`, `POST /videos/:id/chapters`,
   * `DELETE /chapters/:id`).
   */
  app.get('/videos/:id/edit', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const video = db.select().from(videos).where(eq(videos.id, id)).get();
    if (!video) return reply.code(404).send({ error: VIDEO_NOT_FOUND_MESSAGE });

    const chs = db
      .select()
      .from(chapters)
      .where(eq(chapters.videoId, id))
      .orderBy(asc(chapters.startSec))
      .all();

    const candidate = await mediaCandidatePath(id);
    const resolved = candidate ? await resolveMediaFile(candidate, mediaRoots()) : null;
    const playable = !!resolved && resolved.ok;
    const hasVideo = playable ? await probeHasVideo(resolved.path) : false;

    return {
      videoId: video.id,
      title: video.title,
      durationSec: video.durationSec,
      hasVideo,
      mediaUrl: playable ? `/media/${encodeURIComponent(id)}` : null,
      chapters: chs.map((c) => ({
        id: c.id,
        startSec: c.startSec,
        title: c.title,
        source: c.source,
        validated: c.validated,
      })),
    };
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
          .values(
            proposed.map((c) => ({
              videoId: id,
              // Secondes ENTIÈRES (format YouTube) : arrondi au plus proche.
              startSec: Math.round(c.startSec),
              title: c.title,
              source: 'llm' as const,
            })),
          )
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

  // ---------- média (streaming avec plages) ----------

  /**
   * Chemin candidat pour un identifiant média : la colonne `media_path` de la
   * ligne `videos` (source chemin comme envoi), sinon — un envoi dont le
   * chapitrage n'est pas encore persisté — le fichier du cache dont le nom
   * commence par l'empreinte de l'identifiant. `null` si rien ne correspond.
   */
  async function mediaCandidatePath(id: string): Promise<string | null> {
    const row = db.select({ mediaPath: videos.mediaPath }).from(videos).where(eq(videos.id, id)).get();
    if (row?.mediaPath) return row.mediaPath;
    if (id.startsWith('local:up-')) return findCacheFileByHash(id.slice('local:up-'.length));
    return null;
  }

  /** Racines autorisées pour servir un média : cache d'envoi et MEDIA_DIR. */
  function mediaRoots(): string[] {
    return [uploadCacheDir(), mediaDir()];
  }

  /**
   * `GET|HEAD /media/:id` : sert le média avec support des plages.
   *  - `Accept-Ranges: bytes`, `Content-Length`, `Content-Type` ;
   *  - `206` + `Content-Range` pour une plage unique valide ;
   *  - `416` (avec `Content-Range` indiquant la taille) pour une plage insatisfaisable ;
   *  - plages multiples ou syntaxe inconnue : `200` avec le fichier entier
   *    (choix documenté : jamais de réponse multipart) ;
   *  - l'identifiant doit résoudre à un fichier média DANS une racine autorisée,
   *    sinon `403`/`404` en français. Aucun chemin n'est jamais accepté du client.
   */
  app.route({
    method: ['GET', 'HEAD'],
    url: '/media/:id',
    handler: async (req, reply) => {
      const { id } = idParam.parse(req.params);
      const candidate = await mediaCandidatePath(id);
      const resolved = candidate ? await resolveMediaFile(candidate, mediaRoots()) : null;
      // Un envoi INCOMPLET (`ckr-part-*`) n'est jamais servi, même si une ligne
      // en base pointait dessus : il est tronqué par définition.
      if (resolved && resolved.ok && isPartialUploadName(basename(resolved.path))) {
        return reply.code(404).send({ error: MEDIA_NOT_FOUND_MESSAGE });
      }
      if (!resolved || !resolved.ok) {
        if (!resolved) return reply.code(404).send({ error: MEDIA_NOT_FOUND_MESSAGE });
        return reply.code(resolved.status).send({ error: resolved.message });
      }

      const { path, ext, size } = resolved;
      const isHead = req.method === 'HEAD';
      const range = parseSingleRange(req.headers.range as string | undefined, size);

      if (range.kind === 'unsatisfiable') {
        return reply
          .code(416)
          .header('content-range', `bytes */${size}`)
          .send({ error: 'La plage demandée est en dehors du fichier.' });
      }

      const contentType = mediaContentType(ext);
      if (range.kind === 'partial') {
        const length = range.end - range.start + 1;
        reply
          .code(206)
          .header('accept-ranges', 'bytes')
          .header('content-type', contentType)
          .header('content-length', length)
          .header('content-range', `bytes ${range.start}-${range.end}/${size}`);
        return isHead ? reply.send() : reply.send(createReadStream(path, { start: range.start, end: range.end }));
      }

      reply
        .code(200)
        .header('accept-ranges', 'bytes')
        .header('content-type', contentType)
        .header('content-length', size);
      return isHead ? reply.send() : reply.send(createReadStream(path));
    },
  });

  // ---------- pipeline de job (local) ----------

  const realPipeline: JobPipeline = async (input, { onProgress, signal }) => {
    const result = await generateLocalChapters(input.path, {
      chunkSec: input.chunkSec,
      lang: input.lang,
      maxChunks: input.maxChunks,
      videoId: input.videoId,
      onProgress,
      signal,
    });
    onProgress({ phase: 'persisting', doneChunks: 0, totalChunks: 0 });
    persistLocalChapters(result);
    return {
      videoId: result.videoId,
      chapters: result.chapters,
      text: result.text,
      warnings: result.warnings,
      durationSec: result.durationSec,
      transcript: result.segments.map((s) => ({ startSec: s.startSec, text: s.text })),
    };
  };

  const registry = createJobRegistry(options.pipeline ?? realPipeline, {
    // Trace SERVEUR : le terminal affiche la cause BRUTE (chemins, commande
    // ffmpeg), tandis que la page ne reçoit qu'un message nettoyé et tronqué.
    logger:
      options.jobLogger ??
      ((failure) =>
        app.log.error(
          { jobId: failure.jobId, phase: failure.phase, elapsedMs: failure.elapsedMs, err: failure.error },
          `Échec du chapitrage (phase : ${failure.phase}).`,
        )),
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

    persistLocalChapters(result);

    return { chapters: result.chapters, text: result.text, warnings: result.warnings };
  });

  // Liste des médias disponibles dans MEDIA_DIR (pour la page).
  app.get('/local/media', async () => {
    const dir = mediaDir();
    const files = await listMediaFiles(dir);
    const exists = await isDirectory(dir);
    return {
      dir,
      files,
      ...(exists
        ? {}
        : {
            hint: `Le dossier « ${dir} » est introuvable. Indiquez le bon dossier avec la variable MEDIA_DIR, puis relancez le serveur.`,
          }),
    };
  });

  const jobInput = z.object({
    path: z.string().min(1),
    // Le plancher d'interface (30 s) est appliqué explicitement plus bas, avec
    // un message français : on accepte donc 0 ici pour que la valeur reçoive
    // elle aussi ce message plutôt qu'une erreur de schéma illisible.
    chunkSec: z.number().int().min(0).optional(),
    lang: z.string().min(2).optional(),
    maxChunks: z.number().int().positive().optional(),
  });

  // Options d'un envoi : passées en paramètres de requête (le corps est le fichier).
  const uploadQuery = z.object({
    chunkSec: z.coerce.number().int().min(0).optional(),
    lang: z.string().min(2).optional(),
    maxChunks: z.coerce.number().int().positive().optional(),
  });

  /** Plafond d'un envoi en Mo : `UPLOAD_MAX_MB` (défaut 2048 Mo). */
  function uploadMaxMb(): number {
    const mb = Number(process.env.UPLOAD_MAX_MB);
    return Number.isFinite(mb) && mb > 0 ? mb : 2048;
  }

  /** Plafond d'un envoi en octets. */
  function uploadMaxBytes(): number {
    return uploadMaxMb() * 1024 * 1024;
  }

  // ---------- santé (préflight visible par la page) ----------

  // ffmpeg/ffprobe sont-ils utilisables ? La page interroge cette route au
  // chargement pour prévenir AVANT de lancer un chapitrage voué à l'échec. On y
  // joint l'état de la clé de transcription (base d'abord, puis `.env` ; absente
  // ou restée à l'exemple) — la clé elle-même n'est jamais renvoyée, pas même
  // tronquée.
  app.get('/local/health', async () => {
    const tools = await checkTools(toolChecker);
    const dir = mediaDir();
    return {
      ffmpeg: { ok: tools.ffmpeg.ok, ...(tools.ffmpeg.version ? { version: tools.ffmpeg.version } : {}) },
      ffprobe: { ok: tools.ffprobe.ok, ...(tools.ffprobe.version ? { version: tools.ffprobe.version } : {}) },
      openrouterKey: resolveOpenRouterKey().status,
      mediaDir: dir,
      mediaDirExists: await isDirectory(dir),
      uploadMaxMb: uploadMaxMb(),
    };
  });

  // Démarre un job (page) : le chemin doit être un fichier de MEDIA_DIR.
  app.post('/local/jobs', async (req, reply) => {
    const body = jobInput.parse(req.body);
    if (body.chunkSec !== undefined && body.chunkSec < MIN_CHUNK_SEC_UI) {
      return reply.code(400).send({ error: CHUNK_SEC_TOO_SHORT_MESSAGE });
    }
    const dir = mediaDir();
    const target = resolve(body.path);
    if (!isInsideDir(target, dir)) {
      return reply
        .code(400)
        .send({ error: "Ce fichier ne se trouve pas dans le dossier des médias. Choisissez un fichier de la liste." });
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      return reply.code(404).send({ error: "Ce fichier est introuvable. Vérifiez qu'il n'a pas été déplacé ou renommé." });
    }
    if (!info.isFile()) {
      return reply.code(404).send({ error: "Ce chemin ne correspond pas à un fichier." });
    }
    // Un fichier vide ne peut rien donner : refus immédiat avec le message
    // actionnable, plutôt qu'un job qui échoue plus tard sur ffmpeg.
    if (info.size === 0) {
      return reply.code(400).send({ error: MEDIA_UNREADABLE_MESSAGE });
    }
    const input: JobInput = {
      path: target,
      chunkSec: body.chunkSec,
      lang: body.lang,
      maxChunks: body.maxChunks,
    };
    const job = registry.createJob(input);
    return reply.code(202).send({ jobId: job.id });
  });

  // Envoi de fichier : le corps est le fichier brut (`application/octet-stream`),
  // le nom d'origine arrive encodé dans l'en-tête `x-filename`, les options dans
  // la requête. Le fichier est écrit dans le CACHE d'envoi sous `<sha1>.<ext>` et
  // y est CONSERVÉ `UPLOAD_RETENTION_DAYS` jours (7 par défaut) : c'est ce qui
  // permet d'ouvrir l'éditeur de bornes (`/edit`) et de réécouter un passage sans
  // réenvoyer le média. Un envoi identique (mêmes octets) réutilise le fichier.
  app.post('/local/jobs/upload', async (req, reply) => {
    const query = uploadQuery.parse(req.query);

    // Le plancher est vérifié AVANT de consommer le corps : on ne lit pas
    // plusieurs gigaoctets pour refuser ensuite la requête.
    if (query.chunkSec !== undefined && query.chunkSec < MIN_CHUNK_SEC_UI) {
      return reply.code(400).send({ error: CHUNK_SEC_TOO_SHORT_MESSAGE });
    }

    const header = req.headers['x-filename'];
    const rawHeader = Array.isArray(header) ? header[0] : header;
    if (!rawHeader) {
      return reply.code(400).send({ error: 'Le nom du fichier est manquant (en-tête « x-filename »).' });
    }
    let filename: string;
    try {
      filename = decodeURIComponent(rawHeader);
    } catch {
      return reply.code(400).send({ error: "Le nom du fichier est illisible (encodage de l'en-tête invalide)." });
    }

    const body = req.body as unknown;
    if (!body || typeof (body as { pipe?: unknown }).pipe !== 'function') {
      return reply
        .code(415)
        .send({ error: 'Envoyez le fichier brut avec l\'en-tête « Content-Type: application/octet-stream ».' });
    }

    let saved;
    try {
      saved = await saveUpload(body as Readable, { filename, maxBytes: uploadMaxBytes() });
    } catch (err) {
      if (err instanceof UploadError) return reply.code(err.status).send({ error: err.message });
      // Jamais de détail technique dans la réponse (chemins, utilisateur…).
      req.log.error(err);
      return reply
        .code(500)
        .send({ error: "L'envoi du fichier a échoué. Réessayez, ou choisissez un autre fichier." });
    }

    // Aucun finaliseur d'envoi : le fichier du cache appartient désormais à la
    // rétention (balayage + « Vider le cache »), pas au cycle de vie du job.
    const job = registry.createJob({
      path: saved.path,
      videoId: `local:up-${saved.sha1.slice(0, 12)}`,
      chunkSec: query.chunkSec,
      lang: query.lang,
      maxChunks: query.maxChunks,
    });
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/local/jobs/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = registry.getJob(id);
    if (!job) return reply.code(404).send({ error: 'job introuvable' });
    return job;
  });

  app.delete('/local/jobs/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const job = registry.cancelJob(id);
    if (!job) return reply.code(404).send({ error: 'job introuvable' });
    return job;
  });

  // Derniers chapitrages locaux (pour la liste « Derniers chapitrages »).
  app.get('/local/history', async () => {
    const rows = db
      .select({
        videoId: videos.id,
        title: videos.title,
        date: videos.createdAt,
        chapterCount: sql<number>`count(${chapters.id})`,
      })
      .from(videos)
      .leftJoin(chapters, eq(chapters.videoId, videos.id))
      .where(like(videos.id, 'local:%'))
      .groupBy(videos.id)
      .orderBy(desc(videos.createdAt))
      .limit(10)
      .all();

    return {
      items: rows.map((r) => ({
        videoId: r.videoId,
        title: r.title,
        chapterCount: Number(r.chapterCount),
        // `createdAt` est un timestamp Drizzle (mode: 'timestamp') : déjà un Date.
        date: r.date.toISOString(),
      })),
    };
  });

  // ---------- administration (clé OpenRouter, outils, chemins) ----------

  /**
   * Refuse (403, message français) toute action d'administration qui ne vient
   * PAS de la boucle locale : la page reste lisible depuis le réseau, mais
   * personne d'autre ne peut lire ni modifier la clé.
   */
  function allowLocalOnly(req: FastifyRequest, reply: FastifyReply): boolean {
    if (isLoopbackAddress(req.socket.remoteAddress)) return true;
    reply.code(403).send({ error: ADMIN_LOOPBACK_ONLY_MESSAGE });
    return false;
  }

  app.get('/admin', async (_req, reply) => {
    const html = await readFile(new URL('./web/admin.html', import.meta.url), 'utf8');
    return reply.type('text/html; charset=utf-8').send(html);
  });

  // Lecture seule : ouverte, mais ne renvoie JAMAIS la clé (masque au plus).
  app.get('/admin/settings', async () => {
    const tools = await checkTools(toolChecker);
    const dir = mediaDir();
    return {
      openrouterKey: openRouterKeyReport(),
      ffmpeg: { ok: tools.ffmpeg.ok, ...(tools.ffmpeg.version ? { version: tools.ffmpeg.version } : {}) },
      ffprobe: { ok: tools.ffprobe.ok, ...(tools.ffprobe.version ? { version: tools.ffprobe.version } : {}) },
      mediaDir: dir,
      mediaDirExists: await isDirectory(dir),
      uploadMaxMb: uploadMaxMb(),
      // Cache d'envoi (rétention) : chiffres affichés par l'administration.
      uploadCache: await uploadCacheStats(),
      uploadRetentionDays: uploadRetentionDays(),
      dbPath,
      logsDir: logsDir(),
    };
  });

  // Crédits du compte OpenRouter (usage, limite, restant, expiration) : lecture
  // mise en cache 60 s. Aucune clé dans la réponse, et aucun appel réseau sans
  // clé exploitable. Ce sont des chiffres FINANCIERS du compte : la lecture est
  // donc réservée à la boucle locale (403 sinon), exactement comme la relecture.
  app.get('/admin/credits', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    return credits.get(false);
  });

  // Relecture forcée (action « Rafraîchir » de l'administration) : elle sort sur
  // le réseau, donc boucle locale uniquement.
  app.post('/admin/credits/refresh', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    return credits.get(true);
  });

  // Version minimale pour la page principale : la page n'utilise QUE
  // `warning` (avertissement discret de crédit presque épuisé). On ne divulgue
  // donc AUCUN montant à un pair du réseau local : au plus un booléen.
  app.get('/local/credits', async () => {
    const snapshot = await credits.get(false);
    return {
      configured: snapshot.configured,
      ok: snapshot.ok,
      warning: snapshot.warning,
    };
  });

  // Vide le cache d'envoi (médias conservés pour l'éditeur de bornes) et rend
  // les chiffres AVANT/APRÈS. Écriture : boucle locale uniquement.
  app.post('/admin/upload-cache/clear', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    const { before, after } = await clearUploadCache();
    return { before, after };
  });

  // Enregistre la clé. Les règles de disponibilité existantes restent l'unique
  // juge d'une clé collée (vide / trop courte / exemple → refus en français).
  app.put('/admin/openrouter-key', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    const { key } = z.object({ key: z.string() }).parse(req.body);
    const value = key.trim();
    if (!openRouterKeyStatus(value).ok) return reply.code(400).send({ error: OPENROUTER_KEY_INVALID_MESSAGE });
    if (!storeOpenRouterKey(value)) return reply.code(500).send({ error: ADMIN_STORE_FAILED_MESSAGE });
    return { openrouterKey: openRouterKeyReport() };
  });

  // Supprime la clé enregistrée : le résolveur retombe alors sur le `.env`.
  app.delete('/admin/openrouter-key', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    clearOpenRouterKey();
    return { openrouterKey: openRouterKeyReport() };
  });

  // Test de clé en DEUX temps, uniquement sur demande explicite (bouton) :
  // `GET /api/v1/key` pour l'état du compte, puis une VRAIE sonde d'inférence
  // minimale (`POST /chat/completions`, `max_tokens: 1`, jamais d'audio) avec le
  // modèle de chapitrage de l'app — seule façon de prouver que la clé peut
  // réellement transcrire/chapitrer (une clé d'administration authentifie le
  // compte mais se fait refuser l'inférence). Aucun appel si aucune clé.
  app.post('/admin/openrouter-key/test', async (req, reply) => {
    if (!allowLocalOnly(req, reply)) return;
    const resolved = resolveOpenRouterKey();
    if (!resolved.key) return reply.code(400).send({ error: OPENROUTER_KEY_ABSENT_MESSAGE });
    return testOpenRouterKey(resolved.key, { fetchImpl: options.keyTestFetch, model: LLM_MODEL });
  });

  return app;
}
