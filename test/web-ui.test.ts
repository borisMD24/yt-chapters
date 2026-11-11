// Tests HTTP de l'interface (page + routes locales), via `app.inject` :
// - la page rend les libellés français attendus ;
// - /local/media liste les médias d'un MEDIA_DIR temporaire et ignore le reste ;
// - /local/jobs refuse un chemin hors MEDIA_DIR ou inexistant ;
// - cycle de vie d'un job via HTTP (pipeline injecté) et annulation ;
// - /local/history (forme) et non-régression des routes existantes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { JobPipeline } from '../src/jobs.ts';

// --- environnement isolé, posé AVANT d'importer l'app (DB_PATH lu à l'import) ---
const mediaDir = mkdtempSync(join(tmpdir(), 'ytc-ui-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ytc-ui-db-'));
const elsewhere = mkdtempSync(join(tmpdir(), 'ytc-ui-hors-'));

writeFileSync(join(mediaDir, 'reportage.mp3'), Buffer.alloc(1_500_000));
writeFileSync(join(mediaDir, 'entretien.MP4'), Buffer.alloc(500_000));
writeFileSync(join(mediaDir, 'notes.txt'), 'ceci n\'est pas un média');
writeFileSync(join(mediaDir, 'sous-titres.srt'), 'ceci non plus');

process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'ui.db');
process.env.OPENROUTER_API_KEY = 'sk-test-should-never-leak';

// Schéma minimal identique à src/db/schema.ts (le test ne doit pas dépendre de
// drizzle-kit) : on crée les tables dans la base temporaire avant les requêtes.
{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      channel TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0,
      transcript_lang TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE TABLE IF NOT EXISTS transcript_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_sec REAL NOT NULL,
      end_sec REAL NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
      start_sec INTEGER NOT NULL,
      title TEXT NOT NULL,
      source TEXT NOT NULL,
      validated INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
  raw.close();
}

const FAKE_VIDEO_ID = 'local:deadbeefdeadbeef';

const fakePipeline: JobPipeline = async (_input, { onProgress, signal }) => {
  onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
  onProgress({ phase: 'chunking', doneChunks: 2, totalChunks: 2 });
  onProgress({ phase: 'transcribing', doneChunks: 1, totalChunks: 2 });
  onProgress({ phase: 'transcribing', doneChunks: 2, totalChunks: 2 });
  onProgress({ phase: 'chaptering', doneChunks: 0, totalChunks: 0 });
  onProgress({ phase: 'persisting', doneChunks: 0, totalChunks: 0 });
  if (signal.aborted) throw new Error('interrompu');
  return {
    videoId: FAKE_VIDEO_ID,
    chapters: [
      { startSec: 0, title: 'Introduction' },
      { startSec: 60, title: 'Suite' },
      { startSec: 120, title: 'Fin' },
    ],
    text: '0:00 Introduction\n1:00 Suite\n2:00 Fin',
    warnings: [],
    durationSec: 180,
    transcript: [{ startSec: 0, text: 'bonjour tout le monde' }],
  };
};

let appPromise: Promise<FastifyInstance> | null = null;
async function getApp(): Promise<FastifyInstance> {
  appPromise ??= import('../src/app.ts').then((m) => m.createApp({ pipeline: fakePipeline, logger: false }));
  return appPromise;
}

async function waitJob(app: FastifyInstance, id: string) {
  for (let i = 0; i < 300; i++) {
    const res = await app.inject({ method: 'GET', url: `/local/jobs/${id}` });
    const job = res.json() as { status: string };
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('le job ne s\'est pas terminé à temps');
}

test('GET / sert la page HTML avec les libellés français clés', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  const html = res.body;
  assert.match(html, /<html lang="fr">/);
  for (const label of [
    'Choisir un fichier',
    'Ou saisir un chemin',
    'Générer les chapitres',
    'Options avancées',
    'Annuler',
    'Copier pour YouTube',
    'Télécharger .txt',
    'Derniers chapitrages',
    'Détails techniques',
    'Voir la transcription',
    'Réessayer',
  ]) {
    assert.ok(html.includes(label), `libellé manquant : ${label}`);
  }
  assert.ok(!/https?:\/\/(?!www\.youtube)/.test(html.replace(/OpenRouter/g, '')), 'aucune ressource externe attendue');
});

test('GET /local/media liste les médias triés et ignore les autres fichiers', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/local/media' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { dir: string; files: { name: string; path: string; sizeMB: number }[]; hint?: string };
  assert.equal(body.dir, resolve(mediaDir));
  assert.deepEqual(
    body.files.map((f) => f.name),
    ['entretien.MP4', 'reportage.mp3'],
  );
  assert.equal(body.files[1].path, join(mediaDir, 'reportage.mp3'));
  assert.equal(body.files[1].sizeMB, 1.5);
  assert.equal(body.hint, undefined);
});

test('GET /local/media signale clairement un dossier manquant', async () => {
  const app = await getApp();
  const previous = process.env.MEDIA_DIR;
  process.env.MEDIA_DIR = join(elsewhere, 'dossier-absent');
  try {
    const res = await app.inject({ method: 'GET', url: '/local/media' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { files: unknown[]; hint?: string };
    assert.deepEqual(body.files, []);
    assert.ok(body.hint && body.hint.includes('MEDIA_DIR'));
  } finally {
    process.env.MEDIA_DIR = previous;
  }
});

test('POST /local/jobs refuse un chemin hors MEDIA_DIR (400) et un fichier absent (404)', async () => {
  const app = await getApp();

  const outside = await app.inject({
    method: 'POST',
    url: '/local/jobs',
    payload: { path: join(elsewhere, 'ailleurs.mp3') },
  });
  assert.equal(outside.statusCode, 400);

  const missing = await app.inject({
    method: 'POST',
    url: '/local/jobs',
    payload: { path: join(mediaDir, 'introuvable.mp3') },
  });
  assert.equal(missing.statusCode, 404);

  const badBody = await app.inject({ method: 'POST', url: '/local/jobs', payload: {} });
  assert.equal(badBody.statusCode, 400);
});

test('cycle de vie d\'un job via HTTP : 202, progression, done, sans fuite de clé', async () => {
  const app = await getApp();
  const created = await app.inject({
    method: 'POST',
    url: '/local/jobs',
    payload: { path: join(mediaDir, 'reportage.mp3'), chunkSec: 60, lang: 'fr' },
  });
  assert.equal(created.statusCode, 202);
  const { jobId } = created.json() as { jobId: string };
  assert.ok(jobId.length > 0);

  const job = (await waitJob(app, jobId)) as {
    status: string;
    phase: string;
    message: string;
    totalChunks: number;
    result?: { text: string; chapters: unknown[]; transcript?: unknown[] };
  };
  assert.equal(job.status, 'done');
  assert.equal(job.phase, 'done');
  assert.equal(job.message, 'Chapitres prêts.');
  assert.equal(job.totalChunks, 2);
  assert.equal(job.result?.text, '0:00 Introduction\n1:00 Suite\n2:00 Fin');
  assert.equal(job.result?.chapters.length, 3);

  const raw = JSON.stringify(job);
  assert.ok(!raw.includes('sk-test-should-never-leak'), 'la clé ne doit jamais apparaître');

  const cancelledAfterDone = await app.inject({ method: 'DELETE', url: `/local/jobs/${jobId}` });
  assert.equal(cancelledAfterDone.statusCode, 200);
  assert.equal((cancelledAfterDone.json() as { status: string }).status, 'done');

  const unknown = await app.inject({ method: 'GET', url: '/local/jobs/inconnu' });
  assert.equal(unknown.statusCode, 404);
});

test('DELETE /local/jobs/:id annule un job en cours', async () => {
  const slow: JobPipeline = async (_input, { signal }) => {
    await new Promise<void>((_resolve, reject) => {
      const t = setTimeout(() => reject(new Error('trop long')), 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('interrompu'));
      });
    });
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const app = (await import('../src/app.ts')).createApp({ pipeline: slow, logger: false });
  try {
    const created = await app.inject({
      method: 'POST',
      url: '/local/jobs',
      payload: { path: join(mediaDir, 'reportage.mp3') },
    });
    const { jobId } = created.json() as { jobId: string };
    await new Promise((r) => setTimeout(r, 30));
    const del = await app.inject({ method: 'DELETE', url: `/local/jobs/${jobId}` });
    assert.equal(del.statusCode, 200);
    const job = (await waitJob(app, jobId)) as { status: string; message: string };
    assert.equal(job.status, 'cancelled');
    assert.equal(job.message, 'Annulé.');
  } finally {
    await app.close();
  }
});

test('GET /local/history expose la forme attendue et /videos/:id/export reste correct', async () => {
  const app = await getApp();
  const { persistLocalChapters } = await import('../src/local-chapters.ts');
  persistLocalChapters({
    videoId: 'local:0123456789abcdef',
    title: 'filmer-le-terrain.mp3',
    durationSec: 180,
    segments: [],
    chapters: [
      { startSec: 0, title: 'Introduction' },
      { startSec: 60, title: 'Suite' },
      { startSec: 120, title: 'Fin' },
    ],
    text: '0:00 Introduction\n1:00 Suite\n2:00 Fin',
    warnings: [],
  });

  const res = await app.inject({ method: 'GET', url: '/local/history' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { items: { videoId: string; title: string; chapterCount: number; date: string }[] };
  const item = body.items.find((i) => i.videoId === 'local:0123456789abcdef');
  assert.ok(item, 'la génération persistée doit apparaître');
  assert.equal(item!.title, 'filmer-le-terrain.mp3');
  assert.equal(item!.chapterCount, 3);
  assert.ok(!Number.isNaN(Date.parse(item!.date)), 'date ISO attendue');

  const exported = await app.inject({ method: 'GET', url: '/videos/local:0123456789abcdef/export' });
  assert.equal(exported.statusCode, 200);
  const payload = exported.json() as { text: string; warnings: string[] };
  assert.equal(payload.text, '0:00 Introduction\n1:00 Suite\n2:00 Fin');
});

test('non-régression : GET /videos et POST /local/chapters gardent leur comportement', async () => {
  const app = await getApp();
  const videos = await app.inject({ method: 'GET', url: '/videos' });
  assert.equal(videos.statusCode, 200);
  assert.ok(Array.isArray(videos.json()));

  // Corps invalide => 400 (validation zod conservée), sans toucher au réseau.
  const invalid = await app.inject({ method: 'POST', url: '/local/chapters', payload: {} });
  assert.equal(invalid.statusCode, 400);
});
