// Tests de l'envoi de fichier (streaming, sans dépendance ni appel API) :
// nom assaini, extension contrôlée, plafond d'octets, impossibilité d'écrire
// hors du cache, identifiant stable par contenu et — NOUVEAU CONTRAT — mise en
// cache durable nommée par l'empreinte (`<sha1>.<ext>`), déduplication, et
// absence de tout fichier temporaire à la fin.
//
// L'ancien invariant « le fichier d'envoi est supprimé avant l'état terminal »
// est REMPLACÉ par le contrat de rétention : le média est conservé pour que
// l'éditeur de bornes (`/edit`) puisse être ouvert sans réenvoyer le fichier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { JobInput, JobPipeline } from '../src/jobs.ts';

// Dossier temporaire PRIVÉ pour ce fichier de tests : les fichiers de test
// tournent en parallèle dans des processus séparés, donc compter les fichiers
// dans un dossier partagé serait instable.
const privateRoot = mkdtempSync(join(tmpdir(), 'ckr-files-'));
process.env.TEMP = privateRoot;
process.env.TMP = privateRoot;
process.env.TMPDIR = privateRoot;
const testTmp = tmpdir();

const dbDir = mkdtempSync(join(testTmp, 'ckr-up-db-'));
const mediaDir = mkdtempSync(join(testTmp, 'ckr-up-media-'));
// Cache d'envoi PROPRE à ce fichier (UPLOAD_CACHE_DIR est relu à chaque appel).
const cacheDir = mkdtempSync(join(testTmp, 'ckr-up-cache-'));
process.env.DB_PATH = join(dbDir, 'up.db');
process.env.MEDIA_DIR = mediaDir;
process.env.UPLOAD_CACHE_DIR = cacheDir;

// Schéma minimal (identique à src/db/schema.ts, sans `media_path` : la colonne
// est ajoutée au démarrage par l'auto-réparation) pour le test de réutilisation
// de l'historique.
{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_sec REAL NOT NULL, end_sec REAL NOT NULL, text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
      validated INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  raw.close();
}

/** Fichiers du cache d'envoi (noms seuls). */
const cacheFiles = () => readdirSync(cacheDir).sort();

const seen: { path: string; videoId?: string; size: number }[] = [];

const fakePipeline: JobPipeline = async (input: JobInput) => {
  seen.push({ path: input.path, videoId: input.videoId, size: statSync(input.path).size });
  return {
    videoId: input.videoId ?? 'local:fake',
    chapters: [],
    text: '0:00 Intro',
    warnings: [],
    durationSec: 1,
  };
};

let appPromise: Promise<FastifyInstance> | null = null;
const getApp = async (): Promise<FastifyInstance> =>
  (appPromise ??= import('../src/app.ts').then((m) => m.createApp({ pipeline: fakePipeline, logger: false })));

async function waitJob(app: FastifyInstance, id: string) {
  for (let i = 0; i < 300; i++) {
    const res = await app.inject({ method: 'GET', url: `/local/jobs/${id}` });
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job non terminé à temps');
}

const upload = (payload: Buffer | Readable, filename: string | undefined) =>
  getApp().then((app) =>
    app.inject({
      method: 'POST',
      url: '/local/jobs/upload',
      headers: {
        'content-type': 'application/octet-stream',
        ...(filename === undefined ? {} : { 'x-filename': encodeURIComponent(filename) }),
      },
      payload,
    }),
  );

const sha1 = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');
const sha1prefix = (buf: Buffer) => 'local:up-' + sha1(buf).slice(0, 12);

test('un fichier envoyé est streamé, puis CONSERVÉ dans le cache sous son empreinte', async () => {
  const app = await getApp();
  const payload = Buffer.alloc(1024, 7);

  const res = await upload(payload, 'reportage final.mp3');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  assert.ok(jobId.length > 0);

  const job = await waitJob(app, jobId);
  assert.equal(job.status, 'done');

  const last = seen.at(-1)!;
  assert.equal(last.path, join(cacheDir, `${sha1(payload)}.mp3`), 'nom = empreinte du contenu + extension');
  assert.equal(last.size, payload.length);
  assert.equal(last.videoId, sha1prefix(payload), 'identifiant dérivé du contenu');
  // NOUVEAU CONTRAT : le fichier survit à l'état terminal (rétention).
  assert.equal(existsSync(last.path), true, 'le média reste disponible pour l’éditeur de bornes');
  assert.deepEqual(cacheFiles(), [`${sha1(payload)}.mp3`]);
});

test('un flux (Readable) est accepté tel quel et mis en cache', async () => {
  const payload = Buffer.alloc(64 * 1024, 3);
  const stream = Readable.from([payload.subarray(0, 32 * 1024), payload.subarray(32 * 1024)]);

  const res = await upload(stream, 'entretien-de-terrain.m4a');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);

  const last = seen.at(-1)!;
  assert.equal(last.path, join(cacheDir, `${sha1(payload)}.m4a`));
  assert.equal(last.size, payload.length);
  assert.equal(existsSync(last.path), true);
});

test('un corps de plus de 1 Mio n’est pas borné par la limite par défaut de Fastify', async () => {
  const payload = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 5);
  const res = await upload(payload, 'gros-reportage.mp4');
  assert.equal(res.statusCode, 202, 'la limite interne de Fastify (1 Mio) ne doit pas s’appliquer');
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);
  assert.equal(seen.at(-1)!.size, payload.length);
  assert.equal(existsSync(seen.at(-1)!.path), true);
});

test('le nom est décodé (espaces et accents) et sert d’extension au fichier du cache', async () => {
  const name = "entretien d'été (2).m4a";
  const payload = Buffer.alloc(512, 1);
  const res = await upload(payload, name);
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);
  assert.equal(seen.at(-1)!.path, join(cacheDir, `${sha1(payload)}.m4a`));
});

test('« ../evil.mp3 » ne peut pas sortir du cache d’envoi', async () => {
  const payload = Buffer.alloc(256, 2);
  const res = await upload(payload, '../evil.mp3');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);

  const last = seen.at(-1)!;
  assert.equal(last.path, join(cacheDir, `${sha1(payload)}.mp3`), 'le fichier reste dans le cache');
  assert.ok(basename(last.path).startsWith(sha1(payload)), 'aucune trace du nom fourni');
  assert.ok(!existsSync(join(testTmp, 'evil.mp3')), 'aucun fichier écrit hors du cache');
  assert.ok(!existsSync(join(privateRoot, 'evil.mp3')));
});

test('un nom qui se réduit à rien est refusé (400)', async () => {
  const res = await upload(Buffer.alloc(16, 4), '<>:"|?*');
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /nom/i);
});

test('une extension non supportée est refusée (415) sans rien écrire dans le cache', async () => {
  const before = cacheFiles().length;
  const res = await upload(Buffer.alloc(64, 9), 'notes.txt');
  assert.equal(res.statusCode, 415);
  assert.match((res.json() as { error: string }).error, /format/i);
  assert.equal(cacheFiles().length, before, 'aucun fichier ne doit être ajouté');
});

test('l’en-tête x-filename manquant donne 400', async () => {
  const res = await upload(Buffer.alloc(64, 9), undefined);
  assert.equal(res.statusCode, 400);
});

test('un fichier au-delà du plafond donne 413 sans résidu dans le cache', async () => {
  const app = await getApp();
  const before = cacheFiles().length;
  const previous = process.env.UPLOAD_MAX_MB;
  process.env.UPLOAD_MAX_MB = '0.001'; // ~1 Kio
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/local/jobs/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('trop-gros.mp3') },
      payload: Buffer.alloc(8192, 6),
    });
    assert.equal(res.statusCode, 413);
    assert.match((res.json() as { error: string }).error, /trop volumineux/i);
  } finally {
    if (previous === undefined) delete process.env.UPLOAD_MAX_MB;
    else process.env.UPLOAD_MAX_MB = previous;
  }
  assert.equal(cacheFiles().length, before, 'ni fichier définitif ni fichier temporaire');
});

test('deux envois du même fichier partagent le même identifiant ET un seul fichier en cache', async () => {
  const { persistLocalChapters } = await import('../src/local-chapters.ts');
  const persisting: JobPipeline = async (input: JobInput) => {
    persistLocalChapters({
      videoId: input.videoId!,
      title: 'envoye.mp3',
      durationSec: 1,
      mediaPath: input.path,
      segments: [],
      chapters: [{ startSec: 0, title: 'Intro' }],
      text: '0:00 Intro',
      warnings: [],
    });
    return { videoId: input.videoId!, chapters: [], text: '0:00 Intro', warnings: [], durationSec: 1 };
  };
  const app = (await import('../src/app.ts')).createApp({ pipeline: persisting, logger: false });
  const payload = Buffer.from('contenu identique pour les deux envois');
  const videoId = sha1prefix(payload);
  try {
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/local/jobs/upload',
        headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('envoye.mp3') },
        payload,
      });
      assert.equal(res.statusCode, 202);
      await waitJob(app, (res.json() as { jobId: string }).jobId);
    }

    assert.equal(
      cacheFiles().filter((f) => f === `${sha1(payload)}.mp3`).length,
      1,
      'un seul fichier en cache pour des octets identiques',
    );

    const raw = new Database(process.env.DB_PATH!);
    const rows = raw.prepare('SELECT count(*) AS c FROM videos WHERE id = ?').get(videoId) as { c: number };
    const path = raw.prepare('SELECT media_path AS p FROM videos WHERE id = ?').get(videoId) as { p: string };
    raw.close();
    assert.equal(rows.c, 1, 'le second envoi doit réutiliser la même ligne, pas en créer une nouvelle');
    assert.equal(path.p, join(cacheDir, `${sha1(payload)}.mp3`), 'le chemin du média est persisté');
  } finally {
    await app.close();
  }
});

test('aucun fichier TEMPORAIRE d’envoi ne subsiste dans le cache à la fin de la série', () => {
  const leftovers = cacheFiles().filter((f) => f.startsWith('ckr-part-'));
  assert.deepEqual(leftovers, [], `fichiers temporaires restants : ${leftovers.join(', ')}`);
  for (const f of cacheFiles()) {
    assert.match(f, /^[0-9a-f]{40}\.[a-z0-9]+$/, `nom de cache inattendu : ${f}`);
  }
});
