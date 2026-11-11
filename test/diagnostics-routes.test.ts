// Tests HTTP du diagnostic : endpoint de santé (avec outils simulés), trace
// serveur d'un échec, garde-fou sur la durée des morceaux et refus d'un envoi vide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { JobFailure, JobPipeline } from '../src/jobs.ts';
import { MEDIA_UNREADABLE_MESSAGE } from '../src/media-check.ts';

// --- environnement isolé, posé AVANT d'importer l'app ---
const privateRoot = mkdtempSync(join(tmpdir(), 'ckr-diag-files-'));
process.env.TEMP = privateRoot;
process.env.TMP = privateRoot;
process.env.TMPDIR = privateRoot;
const testTmp = tmpdir();

const mediaDir = mkdtempSync(join(testTmp, 'ckr-diag-media-'));
const dbDir = mkdtempSync(join(testTmp, 'ckr-diag-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'diag.db');
delete process.env.UPLOAD_MAX_MB;

writeFileSync(join(mediaDir, 'ok.mp3'), Buffer.alloc(2048, 1));
writeFileSync(join(mediaDir, 'vide.mp4'), Buffer.alloc(0));

{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
    CREATE TABLE IF NOT EXISTS transcript_segments (id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, start_sec REAL NOT NULL,
      end_sec REAL NOT NULL, text TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE, start_sec INTEGER NOT NULL,
      title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  `);
  raw.close();
}

const uploadDirs = () => readdirSync(testTmp).filter((f) => f.startsWith('ckr-upload-'));
const UPLOAD_DIRS_AT_START = uploadDirs().length;

const done: Awaited<ReturnType<JobPipeline>> = {
  videoId: 'local:diag',
  chapters: [],
  text: '0:00 Intro',
  warnings: [],
  durationSec: 1,
};

async function makeApp(extra: Parameters<typeof import('../src/app.ts').createApp>[0] = {}): Promise<FastifyInstance> {
  const { createApp } = await import('../src/app.ts');
  return createApp({ pipeline: async () => done, logger: false, ...extra });
}

async function waitJob(app: FastifyInstance, id: string) {
  for (let i = 0; i < 300; i++) {
    const res = await app.inject({ method: 'GET', url: `/local/jobs/${id}` });
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job non terminé à temps');
}

const okChecker = async () => ({ ok: true, version: '6.1.1' });

test('GET /local/health expose la forme attendue avec les outils disponibles', async () => {
  const app = await makeApp({ toolChecker: okChecker });
  try {
    const res = await app.inject({ method: 'GET', url: '/local/health' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as {
      ffmpeg: { ok: boolean; version?: string };
      ffprobe: { ok: boolean; version?: string };
      mediaDir: string;
      mediaDirExists: boolean;
      uploadMaxMb: number;
    };
    assert.deepEqual(body.ffmpeg, { ok: true, version: '6.1.1' });
    assert.deepEqual(body.ffprobe, { ok: true, version: '6.1.1' });
    assert.equal(body.mediaDir, resolve(mediaDir));
    assert.equal(body.mediaDirExists, true);
    assert.equal(body.uploadMaxMb, 2048);
  } finally {
    await app.close();
  }
});

test('GET /local/health signale un ffprobe manquant (sans champ version)', async () => {
  const app = await makeApp({
    toolChecker: async (tool) => (tool === 'ffprobe' ? { ok: false } : { ok: true, version: '6.1.1' }),
  });
  try {
    const body = (await app.inject({ method: 'GET', url: '/local/health' })).json() as {
      ffmpeg: { ok: boolean };
      ffprobe: { ok: boolean; version?: string };
    };
    assert.equal(body.ffmpeg.ok, true);
    assert.equal(body.ffprobe.ok, false);
    assert.equal('version' in body.ffprobe, false);
  } finally {
    await app.close();
  }
});

test('GET /local/health suit UPLOAD_MAX_MB et un MEDIA_DIR absent', async () => {
  const previous = process.env.MEDIA_DIR;
  process.env.MEDIA_DIR = join(mediaDir, 'dossier-absent');
  process.env.UPLOAD_MAX_MB = '512';
  const app = await makeApp({ toolChecker: okChecker });
  try {
    const body = (await app.inject({ method: 'GET', url: '/local/health' })).json() as {
      mediaDirExists: boolean;
      uploadMaxMb: number;
    };
    assert.equal(body.mediaDirExists, false);
    assert.equal(body.uploadMaxMb, 512);
  } finally {
    delete process.env.UPLOAD_MAX_MB;
    process.env.MEDIA_DIR = previous;
    await app.close();
  }
});

test('POST /local/jobs refuse chunkSec < 30 (400, message français) et accepte 30', async () => {
  const app = await makeApp();
  try {
    const tooShort = await app.inject({
      method: 'POST',
      url: '/local/jobs',
      payload: { path: join(mediaDir, 'ok.mp3'), chunkSec: 1 },
    });
    assert.equal(tooShort.statusCode, 400);
    assert.equal((tooShort.json() as { error: string }).error, 'Durée des morceaux invalide : indiquez au moins 30 secondes.');

    const zero = await app.inject({
      method: 'POST',
      url: '/local/jobs',
      payload: { path: join(mediaDir, 'ok.mp3'), chunkSec: 0 },
    });
    assert.equal(zero.statusCode, 400);
    assert.equal((zero.json() as { error: string }).error, 'Durée des morceaux invalide : indiquez au moins 30 secondes.');

    const ok = await app.inject({
      method: 'POST',
      url: '/local/jobs',
      payload: { path: join(mediaDir, 'ok.mp3'), chunkSec: 30 },
    });
    assert.equal(ok.statusCode, 202);
    await waitJob(app, (ok.json() as { jobId: string }).jobId);
  } finally {
    await app.close();
  }
});

test('POST /local/jobs/upload refuse chunkSec < 30 (400, message français)', async () => {
  const app = await makeApp();
  const before = uploadDirs().length;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/local/jobs/upload?chunkSec=5',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('clip.mp3') },
      payload: Buffer.alloc(1024, 1),
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, 'Durée des morceaux invalide : indiquez au moins 30 secondes.');
    assert.equal(uploadDirs().length, before, 'aucun dossier temporaire ne doit rester');
  } finally {
    await app.close();
  }
});

test('un envoi de 0 octet est refusé (400, message français) sans rien laisser traîner', async () => {
  const app = await makeApp();
  const before = uploadDirs().length;
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/local/jobs/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent('vide.mp4') },
      payload: Buffer.alloc(0),
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, MEDIA_UNREADABLE_MESSAGE);
    assert.equal(uploadDirs().length, before, 'le dossier temporaire doit être supprimé');
  } finally {
    await app.close();
  }
});

test('un fichier de 0 octet de MEDIA_DIR est refusé (400, message français)', async () => {
  const app = await makeApp();
  try {
    const res = await app.inject({
      method: 'POST',
      url: '/local/jobs',
      payload: { path: join(mediaDir, 'vide.mp4') },
    });
    assert.equal(res.statusCode, 400);
    assert.equal((res.json() as { error: string }).error, MEDIA_UNREADABLE_MESSAGE);
  } finally {
    await app.close();
  }
});

test('un échec de job trace l’erreur BRUTE côté serveur et n’expose au client qu’un détail nettoyé et tronqué', async () => {
  const raw =
    'ffmpeg exited with code 1: C:\\Users\\boris\\Vidéos\\clip.mp4: Output file does not contain any stream ' +
    'x'.repeat(600);
  const traces: JobFailure[] = [];
  const app = await makeApp({
    pipeline: async () => {
      throw new Error(raw);
    },
    jobLogger: (f) => traces.push(f),
  });
  try {
    const created = await app.inject({ method: 'POST', url: '/local/jobs', payload: { path: join(mediaDir, 'ok.mp3') } });
    assert.equal(created.statusCode, 202);
    const jobId = (created.json() as { jobId: string }).jobId;
    const job = (await waitJob(app, jobId)) as { status: string; error?: string; message: string };

    assert.equal(job.status, 'error');
    assert.equal(traces.length, 1, 'une trace serveur est attendue');
    assert.equal(traces[0].jobId, jobId);
    assert.equal(traces[0].phase, 'chunking');
    assert.ok(String((traces[0].error as Error).message).includes('C:\\Users\\boris'), 'chemin brut côté serveur');

    assert.ok(job.error && job.error.length <= 500, `détail client tronqué (${job.error?.length})`);
    assert.ok(!job.error!.includes('C:\\Users'), 'aucun chemin absolu côté client');
    assert.ok(!JSON.stringify(job).includes('C:\\Users'), 'aucun chemin absolu dans la charge utile');
    assert.ok(job.message.length > 0);
  } finally {
    await app.close();
  }
});

test('aucun dossier temporaire d’envoi ne subsiste à la fin de la série', () => {
  assert.equal(uploadDirs().length, UPLOAD_DIRS_AT_START, `dossiers restants : ${uploadDirs().join(', ')}`);
});
