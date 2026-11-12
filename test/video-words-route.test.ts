// Tests HTTP de `GET /videos/:id/words` : validation de fenêtre (400 FR), vidéo
// inconnue (404 FR), ordre des mots, troncature de la fenêtre à la durée connue,
// plafond de mots avec mention de troncature, et `{ words: [] }` propre.
// Aucun ffmpeg : lecture pure de la table `media_words`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { WORDS_MAX_COUNT } from '../src/video-words.ts';
import { ensureMediaWordsTable } from '../src/db/media-words.ts';

const root = mkdtempSync(join(tmpdir(), 'ckr-words-'));
const mediaDir = join(root, 'media');
mkdirSync(mediaDir, { recursive: true });
process.env.MEDIA_DIR = mediaDir;
process.env.UPLOAD_CACHE_DIR = join(root, 'cache');
process.env.DB_PATH = join(root, 'words.db');

const A = 'local:wordroute0001';
const EMPTY = 'local:wordroute0002';
const DENSE = 'local:wordroute0003';

function createSchema(): void {
  const raw = new Database(process.env.DB_PATH!);
  raw.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, media_path TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.exec(`CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.exec(`CREATE TABLE transcript_segments (id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id TEXT NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, text TEXT NOT NULL)`);
  raw.exec(`CREATE TABLE media_words (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_ms INTEGER NOT NULL, end_ms INTEGER NOT NULL, text TEXT NOT NULL)`);

  const v = raw.prepare('INSERT INTO videos (id, title, duration_sec) VALUES (?, ?, ?)');
  v.run(A, 'A', 600);
  v.run(EMPTY, 'B', 300);
  v.run(DENSE, 'C', 600);

  const w = raw.prepare('INSERT INTO media_words (video_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)');
  const aWords: [number, number, string][] = [
    [9000, 9400, 'neuf'],
    [9400, 9800, 'quarante'],
    [9800, 10200, 'huit'],
    [100200, 100600, 'cent'],
    [595000, 595400, 'fin'],
  ];
  for (const [s, e, t] of aWords) w.run(A, s, e, t);

  // Média dense : 2 500 mots entre 0 et 100 s (plafond de mots dépassé).
  for (let i = 0; i < 2500; i++) w.run(DENSE, i * 40, i * 40 + 30, 'm' + i);
  raw.close();
}

createSchema();

let appPromise: Promise<FastifyInstance> | null = null;
async function getApp(): Promise<FastifyInstance> {
  if (!appPromise) {
    const mod = await import('../src/app.ts');
    appPromise = Promise.resolve(
      mod.createApp({ pipeline: async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }), logger: false, preflight: false, sweepStaleUploads: false }),
    );
  }
  return appPromise;
}

type Body = { from: number; to: number; truncated: boolean; words: { startSec: number; endSec: number; word: string }[] };

test('GET /videos/:id/words renvoie les mots de la fenêtre, triés par début', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=0&to=120` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Body;
  assert.equal(body.from, 0);
  assert.equal(body.to, 120);
  assert.equal(body.truncated, false);
  assert.deepEqual(body.words, [
    { startSec: 9, endSec: 9.4, word: 'neuf' },
    { startSec: 9.4, endSec: 9.8, word: 'quarante' },
    { startSec: 9.8, endSec: 10.2, word: 'huit' },
    { startSec: 100.2, endSec: 100.6, word: 'cent' },
  ]);
});

test('GET /videos/:id/words refuse une fenêtre invalide (400, message FR)', async () => {
  const app = await getApp();
  for (const q of ['from=-1&to=10', 'from=10&to=5', 'from=0&to=0', 'from=abc&to=10', 'from=0&to=Infinity']) {
    const res = await app.inject({ method: 'GET', url: `/videos/${A}/words?${q}` });
    assert.equal(res.statusCode, 400, q);
    assert.match((res.json() as { error: string }).error, /invalide/i, q);
  }
  const tooLong = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=0&to=121` });
  assert.equal(tooLong.statusCode, 400);
  assert.match((tooLong.json() as { error: string }).error, /trop longue/i);
});

test('GET /videos/:id/words : vidéo inconnue → 404 FR', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/videos/local:jamaisvu/words?from=0&to=10' });
  assert.equal(res.statusCode, 404);
  assert.match((res.json() as { error: string }).error, /introuvable/i);
});

test('une fenêtre sans mot renvoie proprement { words: [] }', async () => {
  const app = await getApp();
  const none = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=30&to=60` });
  assert.equal(none.statusCode, 200);
  assert.deepEqual((none.json() as Body).words, []);

  const emptyMedia = await app.inject({ method: 'GET', url: `/videos/${EMPTY}/words?from=0&to=30` });
  assert.equal(emptyMedia.statusCode, 200);
  assert.deepEqual((emptyMedia.json() as Body).words, []);
});

test('« to » au-delà de la durée connue est tronquée (jamais d’erreur)', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=590&to=650` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Body;
  assert.equal(body.to, 600);
  assert.deepEqual(body.words, [{ startSec: 595, endSec: 595.4, word: 'fin' }]);

  // Fenêtre ENTIÈREMENT après la fin : jamais inversée, réponse vide propre.
  const after = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=610&to=650` });
  assert.equal(after.statusCode, 200);
  const afterBody = after.json() as Body;
  assert.deepEqual(afterBody.words, []);
  assert.equal(afterBody.to, 600);
});

test('le nombre de mots est plafonné, avec mention de troncature', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/videos/${DENSE}/words?from=0&to=100` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as Body;
  assert.equal(body.words.length, WORDS_MAX_COUNT);
  assert.equal(body.truncated, true);
  assert.equal(body.words[0].word, 'm0');
  assert.equal(body.words[WORDS_MAX_COUNT - 1].word, 'm' + (WORDS_MAX_COUNT - 1));
});

test('GET /videos/:id/edit indique la présence de mots (hasWords)', async () => {
  const app = await getApp();
  const withWords = await app.inject({ method: 'GET', url: `/videos/${A}/edit` });
  assert.equal(withWords.statusCode, 200);
  assert.equal((withWords.json() as { hasWords: boolean }).hasWords, true);

  const withoutWords = await app.inject({ method: 'GET', url: `/videos/${EMPTY}/edit` });
  assert.equal(withoutWords.statusCode, 200);
  assert.equal((withoutWords.json() as { hasWords: boolean }).hasWords, false);
});

// Ce test SUPPRIME `media_words` ; il la RESTAURE (vide) à la fin pour ne
// dépendre d'aucun ordre d'exécution ni laisser la base partagée amputée.
test('table media_words ABSENTE : dégradation honnête (200 / hasWords false), jamais 500', async () => {
  const raw = new Database(process.env.DB_PATH!);
  raw.exec('DROP TABLE media_words');
  raw.close();

  const app = await getApp();

  const words = await app.inject({ method: 'GET', url: `/videos/${A}/words?from=0&to=120` });
  assert.equal(words.statusCode, 200);
  const body = words.json() as Body;
  assert.deepEqual(body.words, []);
  assert.equal(body.truncated, false);
  assert.equal(body.from, 0);
  assert.equal(body.to, 120);

  const edit = await app.inject({ method: 'GET', url: `/videos/${A}/edit` });
  assert.equal(edit.statusCode, 200);
  assert.equal((edit.json() as { hasWords: boolean }).hasWords, false);

  // L'absence de table ne masque pas les autres cas : vidéo inconnue → 404.
  const unknown = await app.inject({ method: 'GET', url: '/videos/local:jamaisvu/words?from=0&to=10' });
  assert.equal(unknown.statusCode, 404);

  // Restauration : la table (et son index) existent de nouveau, vides.
  const restore = new Database(process.env.DB_PATH!);
  assert.equal(ensureMediaWordsTable(restore), true);
  restore.close();
});
