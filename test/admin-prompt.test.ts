// Tests de l'éditeur de consignes du chapitrage (prompt LLM) côté administration :
// routes `/admin/prompt` (lecture ouverte, écriture réservée à la boucle locale)
// et section de la page `/admin`. Entièrement hors ligne.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { bootPage, settle } from './web-harness.ts';

// --- environnement isolé, posé AVANT d'importer quoi que ce soit qui touche la base ---
const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-prompt-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ckr-prompt-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'prompt.db');
delete process.env.OPENROUTER_API_KEY;

// Schéma minimal SANS `app_settings` : c'est le démarrage qui doit la créer.
{
  const raw = new Database(process.env.DB_PATH);
  raw.exec(`
    CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
      duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()));
  `);
  raw.close();
}

type PromptModule = typeof import('../src/chapter-prompt.ts');
let promptModule: PromptModule | null = null;
const promptMod = async (): Promise<PromptModule> => (promptModule ??= await import('../src/chapter-prompt.ts'));

const appPromise: Promise<FastifyInstance> = import('../src/app.ts').then((m) =>
  m.createApp({
    logger: false,
    toolChecker: async () => ({ ok: true, version: '6.1.1' }),
    preflight: false,
    sweepStaleUploads: false,
  }),
);
const getApp = () => appPromise;
const reset = async () => (await promptMod()).clearChapterPrompt();

const CUSTOM = 'Consignes personnalisées pour mes vidéos : un chapitre par idée forte, en français.';

// ---------- lecture ----------

test('GET /admin/prompt renvoie les consignes par défaut quand rien n’est enregistré', async () => {
  const app = await getApp();
  const m = await promptMod();
  await reset();

  const res = await app.inject({ method: 'GET', url: '/admin/prompt' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as { text: string; default: string; source: string; customized: boolean; updatedAt?: string };
  assert.equal(body.source, 'default');
  assert.equal(body.customized, false);
  assert.equal(body.text, m.DEFAULT_CHAPTER_PROMPT);
  assert.equal(body.default, m.DEFAULT_CHAPTER_PROMPT);
  assert.equal(body.updatedAt, undefined);
});

// ---------- aller-retour ----------

test('PUT /admin/prompt enregistre (boucle locale), GET relit, DELETE réinitialise', async () => {
  const app = await getApp();
  await reset();

  const put = await app.inject({
    method: 'PUT',
    url: '/admin/prompt',
    payload: { text: CUSTOM },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(put.statusCode, 200);
  const putBody = put.json() as { chapterPrompt: { text: string; source: string; customized: boolean } };
  assert.equal(putBody.chapterPrompt.source, 'db');
  assert.equal(putBody.chapterPrompt.customized, true);
  assert.equal(putBody.chapterPrompt.text, CUSTOM);

  const get = await app.inject({ method: 'GET', url: '/admin/prompt' });
  const getBody = get.json() as { text: string; source: string; customized: boolean };
  assert.equal(getBody.text, CUSTOM);
  assert.equal(getBody.source, 'db');

  const del = await app.inject({ method: 'DELETE', url: '/admin/prompt', remoteAddress: '127.0.0.1' });
  assert.equal(del.statusCode, 200);
  const delBody = del.json() as { chapterPrompt: { source: string; customized: boolean } };
  assert.equal(delBody.chapterPrompt.source, 'default');
  assert.equal(delBody.chapterPrompt.customized, false);
});

// ---------- validation ----------

test('PUT /admin/prompt refuse vide / trop court en français, sans rien stocker', async () => {
  const app = await getApp();
  const m = await promptMod();
  await reset();

  for (const [bad, message] of [
    ['', m.CHAPTER_PROMPT_EMPTY_MESSAGE],
    ['   ', m.CHAPTER_PROMPT_EMPTY_MESSAGE],
    ['court', m.CHAPTER_PROMPT_TOO_SHORT_MESSAGE],
  ] as const) {
    const res = await app.inject({
      method: 'PUT',
      url: '/admin/prompt',
      payload: { text: bad },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal((res.json() as { error: string }).error, message, JSON.stringify(bad));
  }
  assert.equal(m.resolveChapterPrompt().source, 'default', 'aucune valeur refusée ne doit être stockée');
});

// ---------- boucle locale obligatoire ----------

test('écriture et réinitialisation refusées (403) hors boucle locale ; lecture ouverte', async () => {
  const app = await getApp();
  const remote = { remoteAddress: '203.0.113.7' } as const;

  for (const [method, url] of [
    ['PUT', '/admin/prompt'],
    ['DELETE', '/admin/prompt'],
  ] as const) {
    const res = await app.inject({
      method,
      url,
      payload: method === 'PUT' ? { text: CUSTOM } : undefined,
      ...remote,
    });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.match((res.json() as { error: string }).error, /que depuis cet ordinateur/);
  }
  assert.equal((await promptMod()).resolveChapterPrompt().source, 'default', 'un client distant ne doit rien écrire');

  const read = await app.inject({ method: 'GET', url: '/admin/prompt', ...remote });
  assert.equal(read.statusCode, 200);

  // Boucle locale explicite (IPv4, IPv6) : autorisée.
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const ok = await app.inject({ method: 'PUT', url: '/admin/prompt', payload: { text: CUSTOM }, remoteAddress });
    assert.equal(ok.statusCode, 200, remoteAddress);
    await reset();
  }
});

// ---------- page ----------

test('GET /admin sert la section d’édition des consignes (sans persistance locale)', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(res.statusCode, 200);
  assert.ok(res.body.includes('Consignes du chapitrage'), 'titre de section manquant');
  for (const id of ['prompt-input', 'save-prompt', 'reset-prompt', 'reload-prompt', 'prompt-badge']) {
    assert.ok(res.body.includes('id="' + id + '"'), `élément manquant : ${id}`);
  }
  assert.match(res.body, /<textarea[^>]*id="prompt-input"/);
  assert.ok(!/localStorage/.test(res.body), 'aucune persistance locale ne doit être utilisée');
});

test('la page d’administration rend les consignes actives', async () => {
  const routes = async (url: string) => {
    if (url === '/admin/settings') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          openrouterKey: { configured: false, source: 'none', reason: 'missing' },
          ffmpeg: { ok: true },
          ffprobe: { ok: true },
          mediaDir: 'C:\\Médias',
          mediaDirExists: true,
          uploadMaxMb: 2048,
          dbPath: 'data/x.db',
        }),
      };
    }
    if (url === '/admin/prompt') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          text: 'MES CONSIGNES PERSONNALISÉES',
          default: 'DÉFAUT',
          source: 'db',
          customized: true,
          updatedAt: '2026-01-02T03:04:05.000Z',
        }),
      };
    }
    if (url === '/admin/credits') {
      return { ok: true, status: 200, json: async () => ({}) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes, { file: new URL('../src/web/admin.html', import.meta.url) });
  await settle();

  assert.equal(page.el('prompt-input').value, 'MES CONSIGNES PERSONNALISÉES');
  assert.match(page.el('prompt-badge-text').textContent, /Personnalisées/);
  assert.match(page.el('prompt-source').textContent, /base/);
  assert.equal(page.el('prompt-message-text').textContent, '', 'aucun message d’erreur ne doit être affiché');
});
