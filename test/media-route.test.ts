// Tests HTTP de la route média : en-têtes, plages (206/416), HEAD, et refus
// de tout identifiant qui ne résout pas à un fichier média autorisé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(join(tmpdir(), 'ckr-med-'));
const mediaDir = join(root, 'media');
const cacheDir = join(root, 'cache');
const outside = join(root, 'hors');
for (const dir of [mediaDir, cacheDir, outside]) mkdirSync(dir, { recursive: true });

process.env.MEDIA_DIR = mediaDir;
process.env.UPLOAD_CACHE_DIR = cacheDir;
process.env.DB_PATH = join(root, 'media.db');

// Table `videos` SANS `media_path` : la colonne doit être ajoutée au démarrage
// par l'auto-réparation, et la suite continue de fonctionner.
{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.exec(`CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.close();
}

const SIZE = 5000;
const payload = Buffer.alloc(SIZE);
for (let i = 0; i < SIZE; i++) payload[i] = i % 251;

const MEDIA_ID = 'local:0123456789abcdef';
const mediaFile = join(mediaDir, 'reportage.mp3');
writeFileSync(mediaFile, payload);

// Fichiers de refus.
writeFileSync(join(mediaDir, 'notes.txt'), 'pas un média');
mkdirSync(join(mediaDir, 'dossier.mp3'));
const outsideFile = join(outside, 'evil.mp3');
writeFileSync(outsideFile, 'dehors');

// Fichier du cache d'envoi, sans ligne en base (job pas encore persisté).
const cacheBytes = Buffer.alloc(3000, 42);
const cacheSha1 = createHash('sha1').update(cacheBytes).digest('hex');
writeFileSync(join(cacheDir, `${cacheSha1}.mp3`), cacheBytes);
const UPLOAD_ID = `local:up-${cacheSha1.slice(0, 12)}`;

let appPromise: Promise<FastifyInstance> | null = null;
async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const mod = await import('../src/app.ts');
    const app = mod.createApp({
      pipeline: async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }),
      logger: false,
      preflight: false,
      sweepStaleUploads: false,
    });
    // Lignes de test : insérées après le démarrage (colonne media_path présente).
    const raw = new Database(process.env.DB_PATH!);
    const stmt = raw.prepare('INSERT INTO videos (id, title, media_path) VALUES (?, ?, ?)');
    stmt.run(MEDIA_ID, 'reportage.mp3', mediaFile);
    stmt.run('local:dehors', 'evil.mp3', outsideFile);
    stmt.run('local:txt', 'notes.txt', join(mediaDir, 'notes.txt'));
    stmt.run('local:dossier', 'dossier', join(mediaDir, 'dossier.mp3'));
    raw.close();
    appPromise = Promise.resolve(app);
  }
  return appPromise;
}

test('GET /media/:id sert le fichier entier (200, en-têtes corrects)', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.equal(res.rawPayload.length, SIZE);
  assert.ok(res.rawPayload.equals(payload));
});

test('GET /media/:id : Range bytes=0-1023 → 206, 1024 octets exactly + Content-Range', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}`, headers: { range: 'bytes=0-1023' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes 0-1023/${SIZE}`);
  assert.equal(Number(res.headers['content-length']), 1024);
  assert.equal(res.rawPayload.length, 1024);
  assert.ok(res.rawPayload.equals(payload.subarray(0, 1024)));
});

test('GET /media/:id : suffixe bytes=-1024 → 206, 1024 derniers octets', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}`, headers: { range: 'bytes=-1024' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], `bytes ${SIZE - 1024}-${SIZE - 1}/${SIZE}`);
  assert.equal(res.rawPayload.length, 1024);
  assert.ok(res.rawPayload.equals(payload.subarray(SIZE - 1024)));
});

test('GET /media/:id : plage insatisfaisable → 416 avec la taille', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/media/${MEDIA_ID}`, headers: { range: `bytes=${SIZE}-` } });
  assert.equal(res.statusCode, 416);
  assert.equal(res.headers['content-range'], `bytes */${SIZE}`);
});

test('GET /media/:id : plage multiple ignorée → 200 avec le fichier entier', async () => {
  const app = await getApp();
  const res = await app.inject({
    method: 'GET',
    url: `/media/${MEDIA_ID}`,
    headers: { range: 'bytes=0-9,20-29' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.rawPayload.length, SIZE);
});

test('HEAD /media/:id → en-têtes sans corps', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'HEAD', url: `/media/${MEDIA_ID}` });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.headers['content-type'], 'audio/mpeg');
  assert.equal(Number(res.headers['content-length']), SIZE);
  assert.equal(res.rawPayload.length, 0, 'aucun corps pour un HEAD');
});

test('GET /media/:id retrouve un envoi du cache par préfixe d’empreinte (plage comprise)', async () => {
  const app = await getApp();
  const full = await app.inject({ method: 'GET', url: `/media/${UPLOAD_ID}` });
  assert.equal(full.statusCode, 200);
  assert.equal(full.rawPayload.length, cacheBytes.length);
  const part = await app.inject({ method: 'GET', url: `/media/${UPLOAD_ID}`, headers: { range: 'bytes=0-99' } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.rawPayload.length, 100);
});

test('GET /media/:id refuse : hors racines (403), non-média (403), dossier (404), inconnu (404)', async () => {
  const app = await getApp();
  const forbidden = await app.inject({ method: 'GET', url: '/media/local:dehors' });
  assert.equal(forbidden.statusCode, 403);

  const notMedia = await app.inject({ method: 'GET', url: '/media/local:txt' });
  assert.equal(notMedia.statusCode, 403);

  const dir = await app.inject({ method: 'GET', url: '/media/local:dossier' });
  assert.equal(dir.statusCode, 404);

  const unknown = await app.inject({ method: 'GET', url: '/media/local:inconnu' });
  assert.equal(unknown.statusCode, 404);
  assert.match((unknown.json() as { error: string }).error, /introuvable/i);

  // Un chemin collé directement ne doit jamais servir de fichier.
  const traversal = await app.inject({ method: 'GET', url: '/media/..%2F..%2Fetc%2Fpasswd.mp3' });
  assert.equal(traversal.statusCode, 404);
});
