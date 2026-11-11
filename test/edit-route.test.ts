// Tests de `GET /videos/:id/edit` : charge utile de l'éditeur de bornes, avec
// une VRAIE sonde ffprobe sur deux fichiers synthétiques (lavfi) — un média
// audio seul, un média avec piste vidéo + audio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';

const root = mkdtempSync(join(tmpdir(), 'ckr-edit-'));
const mediaDir = join(root, 'media');
mkdirSync(mediaDir, { recursive: true });

process.env.MEDIA_DIR = mediaDir;
process.env.UPLOAD_CACHE_DIR = join(root, 'cache');
process.env.DB_PATH = join(root, 'edit.db');

const audioFile = join(mediaDir, 'audio-seul.mp3');
const videoFile = join(mediaDir, 'avec-video.mp4');

// Fichiers synthétiques réels (aucun réseau, aucun coût) : ffmpeg est requis par
// l'application elle-même, son absence ferait déjà échouer la suite ailleurs.
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', audioFile]);
execFileSync('ffmpeg', [
  '-hide_banner',
  '-loglevel',
  'error',
  '-y',
  '-f',
  'lavfi',
  '-i',
  'testsrc=duration=2:size=64x64:rate=10',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:duration=2',
  '-c:v',
  'mpeg4',
  '-c:a',
  'aac',
  '-shortest',
  videoFile,
]);

{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.exec(`CREATE TABLE chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  raw.close();
}

const WITH_VIDEO = 'local:avecvideofile01';
const AUDIO_ONLY = 'local:audioseulfile2';

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
    const raw = new Database(process.env.DB_PATH!);
    const v = raw.prepare('INSERT INTO videos (id, title, media_path, duration_sec) VALUES (?, ?, ?, ?)');
    v.run(WITH_VIDEO, 'avec vidéo', videoFile, 2);
    v.run(AUDIO_ONLY, 'audio seul', audioFile, 3);
    const c = raw.prepare('INSERT INTO chapters (video_id, start_sec, title, source, validated) VALUES (?, ?, ?, ?, ?)');
    c.run(WITH_VIDEO, 120, 'Fin', 'llm', 0);
    c.run(WITH_VIDEO, 0, 'Introduction', 'llm', 1);
    c.run(WITH_VIDEO, 60, 'Suite', 'manual', 1);
    raw.close();
    appPromise = Promise.resolve(app);
  }
  return appPromise;
}

test('hasVideo = true pour un fichier avec piste vidéo + audio', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/videos/${WITH_VIDEO}/edit` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    videoId: string;
    title: string;
    durationSec: number;
    hasVideo: boolean;
    mediaUrl: string | null;
    chapters: { id: number; startSec: number; title: string; source: string; validated: boolean }[];
  };
  assert.equal(body.videoId, WITH_VIDEO);
  assert.equal(body.title, 'avec vidéo');
  assert.equal(body.durationSec, 2);
  assert.equal(body.hasVideo, true);
  assert.equal(body.mediaUrl, `/media/${encodeURIComponent(WITH_VIDEO)}`);
  assert.deepEqual(
    body.chapters.map((c) => [c.startSec, c.title, c.source, c.validated]),
    [
      [0, 'Introduction', 'llm', true],
      [60, 'Suite', 'manual', true],
      [120, 'Fin', 'llm', false],
    ],
    'chapitres ordonnés par horodatage, ids présents',
  );
  assert.ok(body.chapters.every((c) => typeof c.id === 'number' && c.id > 0));
});

test('hasVideo = false pour un fichier audio seul', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: `/videos/${AUDIO_ONLY}/edit` });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { hasVideo: boolean; mediaUrl: string | null; chapters: unknown[] };
  assert.equal(body.hasVideo, false);
  assert.equal(body.mediaUrl, `/media/${encodeURIComponent(AUDIO_ONLY)}`);
  assert.deepEqual(body.chapters, []);
});

test('un identifiant inconnu donne 404 avec un message français', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/videos/local:jamaisvu/edit' });
  assert.equal(res.statusCode, 404);
  assert.match((res.json() as { error: string }).error, /introuvable/i);
});
