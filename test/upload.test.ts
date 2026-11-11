// Tests de l'envoi de fichier (streaming, sans dépendance ni appel API) :
// nom assaini, extension contrôlée, plafond d'octets, impossibilité de sortir
// du dossier temporaire, identifiant stable par contenu et nettoyage du
// dossier temporaire à l'état terminal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { JobInput, JobPipeline } from '../src/jobs.ts';

const dbDir = mkdtempSync(join(tmpdir(), 'ckr-up-db-'));
const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-up-media-'));
process.env.DB_PATH = join(dbDir, 'up.db');
process.env.MEDIA_DIR = mediaDir;

// Schéma minimal (identique à src/db/schema.ts) pour le test de réutilisation
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

/** Dossiers d'upload laissés par l'application (doit rester vide). */
const uploadDirs = () => readdirSync(tmpdir()).filter((f) => f.startsWith('ckr-upload-'));
const UPLOAD_DIRS_AT_START = uploadDirs().length;

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

const sha1prefix = (buf: Buffer) => 'local:up-' + createHash('sha1').update(buf).digest('hex').slice(0, 12);

test('un fichier envoyé est streamé, assaini, traité puis son dossier temporaire supprimé', async () => {
  const app = await getApp();
  const payload = Buffer.alloc(1024, 7);

  const res = await upload(payload, 'reportage final.mp3');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  assert.ok(jobId.length > 0);

  const job = await waitJob(app, jobId);
  assert.equal(job.status, 'done');

  const last = seen.at(-1)!;
  assert.equal(basename(last.path), 'reportage final.mp3', 'le nom assaini doit être conservé');
  assert.ok(dirname(last.path).includes('ckr-upload-'), 'le fichier doit vivre dans un dossier temporaire privé');
  assert.equal(last.size, payload.length);
  assert.equal(last.videoId, sha1prefix(payload), 'identifiant dérivé du contenu');
  assert.equal(existsSync(dirname(last.path)), false, 'le dossier temporaire doit être supprimé après le job');
});

test('un flux (Readable) est accepté tel quel, sans tampon intermédiaire', async () => {
  const payload = Buffer.alloc(64 * 1024, 3);
  const stream = Readable.from([payload.subarray(0, 32 * 1024), payload.subarray(32 * 1024)]);

  const res = await upload(stream, 'entretien-de-terrain.m4a');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);

  const last = seen.at(-1)!;
  assert.equal(basename(last.path), 'entretien-de-terrain.m4a');
  assert.equal(last.size, payload.length);
  assert.ok(!existsSync(dirname(last.path)));
});

test('un corps de plus de 1 Mio n’est pas borné par la limite par défaut de Fastify', async () => {
  const payload = Buffer.alloc(Math.floor(1.5 * 1024 * 1024), 5);
  const res = await upload(payload, 'gros-reportage.mp4');
  assert.equal(res.statusCode, 202, 'la limite interne de Fastify (1 Mio) ne doit pas s’appliquer');
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);
  assert.equal(seen.at(-1)!.size, payload.length);
  assert.ok(!existsSync(dirname(seen.at(-1)!.path)));
});

test('le nom est décodé (espaces et accents) et réduit au nom de base', async () => {
  const name = "entretien d'été (2).m4a";
  const res = await upload(Buffer.alloc(512, 1), name);
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);
  assert.equal(basename(seen.at(-1)!.path), name);
});

test('« ../evil.mp3 » ne peut pas sortir du dossier temporaire', async () => {
  const res = await upload(Buffer.alloc(256, 2), '../evil.mp3');
  assert.equal(res.statusCode, 202);
  const { jobId } = res.json() as { jobId: string };
  await waitJob(await getApp(), jobId);

  const last = seen.at(-1)!;
  assert.equal(basename(last.path), 'evil.mp3');
  assert.ok(dirname(last.path).includes('ckr-upload-'), 'le fichier doit rester dans le dossier temporaire');
  assert.ok(!existsSync(join(tmpdir(), 'evil.mp3')), 'aucun fichier ne doit être écrit hors du dossier temporaire');
});

test('un nom qui se réduit à rien est refusé (400)', async () => {
  const res = await upload(Buffer.alloc(16, 4), '<>:"|?*');
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /nom/i);
});

test('une extension non supportée est refusée (415) sans rien laisser traîner', async () => {
  const before = uploadDirs().length;
  const res = await upload(Buffer.alloc(64, 9), 'notes.txt');
  assert.equal(res.statusCode, 415);
  assert.match((res.json() as { error: string }).error, /format/i);
  assert.equal(uploadDirs().length, before, 'aucun dossier temporaire ne doit rester');
});

test('l’en-tête x-filename manquant donne 400', async () => {
  const res = await upload(Buffer.alloc(64, 9), undefined);
  assert.equal(res.statusCode, 400);
});

test('un fichier au-delà du plafond donne 413 et le temporaire est supprimé', async () => {
  const app = await getApp();
  const before = uploadDirs().length;
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
  assert.equal(uploadDirs().length, before, 'le dossier temporaire doit être nettoyé après un dépassement');
});

test('deux envois du même fichier partagent le même identifiant (une seule ligne d’historique)', async () => {
  const { persistLocalChapters } = await import('../src/local-chapters.ts');
  const persisting: JobPipeline = async (input: JobInput) => {
    persistLocalChapters({
      videoId: input.videoId!,
      title: 'envoye.mp3',
      durationSec: 1,
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

    const raw = new Database(process.env.DB_PATH!);
    const rows = raw.prepare('SELECT count(*) AS c FROM videos WHERE id = ?').get(videoId) as { c: number };
    raw.close();
    assert.equal(rows.c, 1, 'le second envoi doit réutiliser la même ligne, pas en créer une nouvelle');
  } finally {
    await app.close();
  }
});

test('aucun dossier temporaire d’upload ne subsiste à la fin de la série', () => {
  assert.equal(uploadDirs().length, UPLOAD_DIRS_AT_START, `dossiers restants : ${uploadDirs().join(', ')}`);
});
