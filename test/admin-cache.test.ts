// Tests HTTP du cache d'envoi côté administration : chiffres exposés, rétention
// au démarrage, et « Vider le cache » (boucle locale uniquement).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const root = mkdtempSync(join(tmpdir(), 'ckr-acache-'));
const cacheDir = join(root, 'cache');
mkdirSync(cacheDir, { recursive: true });
process.env.MEDIA_DIR = join(root, 'media');
mkdirSync(process.env.MEDIA_DIR, { recursive: true });
process.env.UPLOAD_CACHE_DIR = cacheDir;
process.env.DB_PATH = join(root, 'cache.db');

writeFileSync(join(cacheDir, 'a'.repeat(40) + '.mp3'), Buffer.alloc(1000, 1));
writeFileSync(join(cacheDir, 'b'.repeat(40) + '.mp3'), Buffer.alloc(2000, 2));

{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.close();
}

let appPromise: Promise<FastifyInstance> | null = null;
async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const mod = await import('../src/app.ts');
    appPromise = Promise.resolve(
      mod.createApp({
        pipeline: async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }),
        logger: false,
        toolChecker: async () => ({ ok: true, version: '6.1.1' }),
        preflight: false,
        sweepStaleUploads: false,
      }),
    );
  }
  return appPromise;
}

async function waitUntil(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('GET /admin/settings expose les chiffres du cache et la rétention', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    uploadCache: { dir: string; files: number; bytes: number };
    uploadRetentionDays: number;
  };
  assert.equal(body.uploadCache.dir, cacheDir);
  assert.equal(body.uploadCache.files, 2);
  assert.equal(body.uploadCache.bytes, 3000);
  assert.equal(body.uploadRetentionDays, 7);
});

test('« Vider le cache » est refusé hors boucle locale (403) et ne touche à rien', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/admin/upload-cache/clear', remoteAddress: '203.0.113.5' });
  assert.equal(res.statusCode, 403);
  assert.equal(readdirSync(cacheDir).length, 2, 'le cache est intact');
});

test('« Vider le cache » vide le cache et rend les chiffres avant/après', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'POST', url: '/admin/upload-cache/clear', remoteAddress: '127.0.0.1' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    before: { files: number; bytes: number };
    after: { files: number; bytes: number };
  };
  assert.equal(body.before.files, 2);
  assert.equal(body.before.bytes, 3000);
  assert.equal(body.after.files, 0);
  assert.equal(body.after.bytes, 0);
  assert.deepEqual(readdirSync(cacheDir), []);
});

test('la page d’administration affiche les chiffres du cache et vide le cache', async () => {
  const settings = {
    openrouterKey: { configured: false, source: 'none', reason: 'missing' },
    ffmpeg: { ok: true },
    ffprobe: { ok: true },
    mediaDir: 'X',
    mediaDirExists: true,
    uploadMaxMb: 2048,
    uploadCache: { dir: cacheDir, files: 2, bytes: 3000 },
    uploadRetentionDays: 7,
    dbPath: 'x',
  };
  let cleared = 0;
  const routes = async (url: string, init?: FetchCall['init']) => {
    if (url === '/admin/settings') return { ok: true, status: 200, json: async () => settings };
    if (url === '/admin/upload-cache/clear' && init?.method === 'POST') {
      cleared++;
      return { ok: true, status: 200, json: async () => ({ before: { files: 2, bytes: 3000 }, after: { files: 0, bytes: 0 } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes, { file: new URL('../src/web/admin.html', import.meta.url) });
  await settle();

  assert.match(page.el('upload-cache').textContent, /2 fichiers/);
  assert.match(page.el('upload-cache').textContent, /7 jours/);
  assert.ok(page.el('clear-cache').__on.click?.length, 'le bouton « Vider le cache » doit être branché');

  page.fire('clear-cache', 'click');
  await settle();
  assert.equal(cleared, 1, 'le vidage est demandé au serveur');
  assert.match(page.el('key-message-text').textContent, /Cache vidé : 2 fichier/);
});

test('le démarrage purge un envoi plus vieux que la rétention et épargne le récent', async () => {
  const fresh = join(cacheDir, 'c'.repeat(40) + '.mp3');
  const stale = join(cacheDir, 'd'.repeat(40) + '.mp3');
  writeFileSync(fresh, Buffer.alloc(10, 1));
  writeFileSync(stale, Buffer.alloc(10, 2));
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  utimesSync(stale, longAgo, longAgo);

  const mod = await import('../src/app.ts');
  const app = mod.createApp({
    pipeline: async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }),
    logger: false,
    preflight: false,
  });
  try {
    await waitUntil(() => !readdirSync(cacheDir).includes(stale.split(/[\\/]/).pop()!));
    const names = readdirSync(cacheDir);
    assert.ok(!names.includes(stale.split(/[\\/]/).pop()!), 'l’envoi périmé est purgé');
    assert.ok(names.includes(fresh.split(/[\\/]/).pop()!), 'le récent est épargné');
  } finally {
    await app.close();
  }
});
