// Tests HTTP de `GET /media/:id/analysis` : validation de fenêtre (400 FR),
// refus d'identifiant (403/404 FR, mêmes règles que `/media/:id`), forme et
// taille des pics, durées tronquées, cache (aucun second ffmpeg) et délai.
// Le lanceur ffmpeg est INJECTÉ : aucun processus, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { AnalysisError, ANALYSIS_BUSY_MESSAGE, ANALYSIS_TIMEOUT_MESSAGE, type AnalysisRunner } from '../src/media-analysis.ts';

const root = mkdtempSync(join(tmpdir(), 'ckr-ana-'));
const mediaDir = join(root, 'media');
const cacheDir = join(root, 'cache');
const outside = join(root, 'hors');
for (const dir of [mediaDir, cacheDir, outside]) mkdirSync(dir, { recursive: true });

process.env.MEDIA_DIR = mediaDir;
process.env.UPLOAD_CACHE_DIR = cacheDir;
process.env.DB_PATH = join(root, 'analysis.db');

{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.exec(`CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.close();
}

const MEDIA_ID = 'local:feedfacecafe01';
const mediaFile = join(mediaDir, 'emission.mp3');
writeFileSync(mediaFile, Buffer.alloc(4096, 7));
writeFileSync(join(mediaDir, 'notes.txt'), 'pas un média');
mkdirSync(join(mediaDir, 'dossier.mp3'));
const outsideFile = join(outside, 'evil.mp3');
writeFileSync(outsideFile, 'dehors');

const DEFAULT_STDERR = [
  'Duration: 00:10:00.00, start: 0.0, bitrate: 8 kb/s',
  '[silencedetect @ 0x1] silence_start: 12.5',
  '[silencedetect @ 0x1] silence_end: 14.02 | silence_duration: 1.52',
].join('\n');

let calls: { file: string; from: number; len: number }[] = [];
let behaviour: 'ok' | 'timeout' | 'short' | 'fail' | 'busy' = 'ok';

function pcmSeconds(seconds: number): Buffer {
  const samples = Math.round(seconds * 8000);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((i % 100) - 50) * 400, i * 2);
  return b;
}

const runner: AnalysisRunner = async (file, from, len) => {
  calls.push({ file, from, len });
  if (behaviour === 'timeout') throw new AnalysisError('timeout', ANALYSIS_TIMEOUT_MESSAGE);
  if (behaviour === 'busy') throw new AnalysisError('busy', ANALYSIS_BUSY_MESSAGE);
  if (behaviour === 'fail') throw new Error('boom');
  if (behaviour === 'short') {
    return { pcm: pcmSeconds(len), stderr: 'Duration: 00:00:10.00, start: 0.0\n[silencedetect @ 0x1] silence_start: 2' };
  }
  return { pcm: pcmSeconds(len), stderr: DEFAULT_STDERR };
};

let appPromise: Promise<FastifyInstance> | null = null;
async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const mod = await import('../src/app.ts');
    const app = mod.createApp({
      pipeline: async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }),
      logger: false,
      preflight: false,
      sweepStaleUploads: false,
      analysisRunner: runner,
    });
    const raw = new Database(process.env.DB_PATH!);
    const stmt = raw.prepare('INSERT INTO videos (id, title, media_path) VALUES (?, ?, ?)');
    stmt.run(MEDIA_ID, 'emission.mp3', mediaFile);
    stmt.run('local:dehors', 'evil.mp3', outsideFile);
    stmt.run('local:txt', 'notes.txt', join(mediaDir, 'notes.txt'));
    stmt.run('local:dossier', 'dossier', join(mediaDir, 'dossier.mp3'));
    raw.close();
    appPromise = Promise.resolve(app);
  }
  return appPromise;
}

test('GET /media/:id/analysis renvoie pics, silences absolus et durée', async () => {
  const app = await getApp();
  behaviour = 'ok';
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=60` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { from: number; to: number; durationSec: number; peaks: number[][]; silences: { startSec: number; endSec: number }[] };
  assert.equal(body.from, 0);
  assert.equal(body.to, 60);
  assert.equal(body.durationSec, 600);
  assert.equal(body.peaks.length, 600, '≈ 600 points pour la fenêtre');
  for (const [mn, mx] of body.peaks) assert.ok(mn >= -1 && mx <= 1 && mn <= mx);
  assert.deepEqual(body.silences, [{ startSec: 12.5, endSec: 14.02 }]);
});

test('GET /media/:id/analysis refuse une fenêtre invalide (400, message FR)', async () => {
  const app = await getApp();
  for (const q of ['from=-1&to=10', 'from=10&to=5', 'from=0&to=0', 'from=abc&to=10']) {
    const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?${q}` });
    assert.equal(res.statusCode, 400, q);
    assert.match((res.json() as { error: string }).error, /invalide/i, q);
  }
  const tooLong = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=500` });
  assert.equal(tooLong.statusCode, 400);
  assert.match((tooLong.json() as { error: string }).error, /trop longue/i);
});

test('GET /media/:id/analysis applique les MÊMES refus d’identifiant que /media/:id', async () => {
  const app = await getApp();
  const unknown = await app.inject({ method: 'GET', url: '/media/local:inconnu/analysis?from=0&to=10' });
  assert.equal(unknown.statusCode, 404);
  assert.match((unknown.json() as { error: string }).error, /introuvable/i);

  const forbidden = await app.inject({ method: 'GET', url: '/media/local:dehors/analysis?from=0&to=10' });
  assert.equal(forbidden.statusCode, 403);
  assert.match((forbidden.json() as { error: string }).error, /autorisés/i);

  const notMedia = await app.inject({ method: 'GET', url: '/media/local:txt/analysis?from=0&to=10' });
  assert.equal(notMedia.statusCode, 403);

  const dir = await app.inject({ method: 'GET', url: '/media/local:dossier/analysis?from=0&to=10' });
  assert.equal(dir.statusCode, 404);
});

test('un second appel identique dans le TTL NE relance PAS ffmpeg (cache)', async () => {
  const app = await getApp();
  behaviour = 'ok';
  const before = calls.length;
  await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=30` });
  const after1 = calls.length;
  await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=30` });
  const after2 = calls.length;
  assert.equal(after1 - before, 1, 'premier appel = un ffmpeg');
  assert.equal(after2 - after1, 0, 'second appel identique = aucun ffmpeg');
});

test('un délai dépassé répond 504 avec un message FR', async () => {
  const app = await getApp();
  behaviour = 'timeout';
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=20` });
  assert.equal(res.statusCode, 504);
  assert.match((res.json() as { error: string }).error, /délai/i);
  behaviour = 'ok';
});

test('le plafond de concurrence atteint répond 429 avec un message FR', async () => {
  const app = await getApp();
  behaviour = 'busy';
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=0&to=25` });
  assert.equal(res.statusCode, 429);
  assert.match((res.json() as { error: string }).error, /simultan/i);
  behaviour = 'ok';
});

test('« to » au-delà de la durée est tronquée (pas d’erreur)', async () => {
  const app = await getApp();
  behaviour = 'short';
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}/analysis?from=5&to=15` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { from: number; to: number; durationSec: number };
  assert.equal(body.to, 10);
  assert.equal(body.durationSec, 10);
  behaviour = 'ok';
});
