// Tests de la clé OpenRouter stockée en base + section d'administration.
//
// Entièrement hors ligne : aucun appel OpenRouter réel (le `fetch` du test de
// clé et celui du SDK sont remplacés), ffmpeg jamais invoqué (pipeline et
// `transcribeChunk` sont appelés directement). L'invariant central vérifié ici
// est qu'aucun fragment de 8 caractères ou plus de la clé n'apparaît dans une
// réponse HTTP, un état de job ou une trace serveur.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { bootPage, settle } from './web-harness.ts';
import {
  createJobRegistry,
  OPENROUTER_KEY_MISSING_MESSAGE,
  type JobFailure,
  type JobPipeline,
} from '../src/jobs.ts';

// --- environnement isolé, posé AVANT d'importer quoi que ce soit qui touche la base ---
// (aucun import statique ci-dessus ne remonte à `src/db` : l'app et les modules de
// clé sont chargés dynamiquement plus bas, une fois DB_PATH fixé).
const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-admin-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ckr-admin-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'admin.db');
delete process.env.OPENROUTER_API_KEY;
delete process.env.UPLOAD_MAX_MB;

writeFileSync(join(mediaDir, 'clip.mp3'), Buffer.alloc(4096, 1));

// Schéma minimal identique à src/db/schema.ts, SANS la table `app_settings` :
// c'est le démarrage qui doit la créer (auto-réparation), puis la lecture la
// recréer si elle a disparu.
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

/** Deux clés plausibles distinctes (jamais de vraies clés). */
const KEY_A = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);
const KEY_B = 'sk-or-v1-' + 'f9e8d7c6'.repeat(8);

const adminHtml = readFileSync(new URL('../src/web/admin.html', import.meta.url), 'utf8');

type KeyModule = typeof import('../src/openrouter-key.ts');
let keyModule: KeyModule | null = null;
const key = async (): Promise<KeyModule> => (keyModule ??= await import('../src/openrouter-key.ts'));

const done = {
  videoId: 'local:admin',
  chapters: [{ startSec: 0, title: 'Introduction' }],
  text: '0:00 Introduction',
  warnings: [] as string[],
  durationSec: 1,
};

let currentPipeline: JobPipeline = async () => done;
let currentKeyTestFetch: typeof fetch = async () => new Response('', { status: 500 });
const traces: JobFailure[] = [];

const appPromise: Promise<FastifyInstance> = import('../src/app.ts').then((m) =>
  m.createApp({
    pipeline: (input, ctx) => currentPipeline(input, ctx),
    logger: false,
    toolChecker: async () => ({ ok: true, version: '6.1.1' }),
    keyTestFetch: (input, init) => currentKeyTestFetch(input, init),
    jobLogger: (failure) => traces.push(failure),
    preflight: false,
    sweepStaleUploads: false,
  }),
);
const getApp = () => appPromise;

/** État neutre : rien en base, rien dans l'environnement. */
async function resetKey(): Promise<void> {
  (await key()).clearOpenRouterKey();
  delete process.env.OPENROUTER_API_KEY;
}

async function withEnvKey<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const previous = process.env.OPENROUTER_API_KEY;
  if (value === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
}

// ---------- anti-fuite ----------

/** Tous les fragments de `size` caractères d'une chaîne. */
function fragments(text: string, size = 8): string[] {
  const out: string[] = [];
  for (let i = 0; i + size <= text.length; i++) out.push(text.slice(i, i + size));
  return out;
}

/** La clé ne doit apparaître ni en entier, ni même par fragments de ≥ 8 caractères. */
function assertNoLeak(secret: string, payload: unknown, label: string): void {
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(secret), `${label} : la clé complète ne doit jamais apparaître`);
  for (const fragment of fragments(secret)) {
    assert.ok(!json.includes(fragment), `${label} : fragment de clé « ${fragment} » divulgué`);
  }
}

async function waitJob(app: FastifyInstance, id: string) {
  for (let i = 0; i < 300; i++) {
    const job = (await app.inject({ method: 'GET', url: `/local/jobs/${id}` })).json() as { status: string };
    if (job.status === 'done' || job.status === 'error' || job.status === 'cancelled') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('job non terminé à temps');
}

// ---------- 1. stockage et auto-réparation ----------

test('la table des réglages est créée au démarrage malgré un db:push oublié', async () => {
  await key(); // déclenche le chargement de src/db (et sa création idempotente)
  const raw = new Database(process.env.DB_PATH, { readonly: true });
  try {
    const row = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_settings'")
      .get() as { name?: string } | undefined;
    assert.equal(row?.name, 'app_settings');
  } finally {
    raw.close();
  }
});

test('aller-retour de la clé en base : résolue avec la source « db »', async () => {
  await resetKey();
  const mod = await key();
  assert.equal(mod.storeOpenRouterKey(KEY_A), true);
  const resolved = mod.resolveOpenRouterKey();
  assert.equal(resolved.source, 'db');
  assert.equal(resolved.key, KEY_A);
  assert.deepEqual(resolved.status, { ok: true });

  mod.clearOpenRouterKey();
  assert.equal(mod.resolveOpenRouterKey().source, 'none');
});

test('GET /admin/settings : masque sans fuite, état et environnement exposés', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();
  mod.storeOpenRouterKey(KEY_A);

  const res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.equal(res.statusCode, 200);
  const body = res.json() as {
    openrouterKey: { configured: boolean; source: string; hint?: string; updatedAt?: string };
    ffmpeg: { ok: boolean; version?: string };
    ffprobe: { ok: boolean };
    mediaDir: string;
    mediaDirExists: boolean;
    uploadMaxMb: number;
    dbPath: string;
  };
  assert.equal(body.openrouterKey.configured, true);
  assert.equal(body.openrouterKey.source, 'db');
  assert.equal(body.openrouterKey.hint, 'sk-or-…' + KEY_A.slice(-4));
  assert.ok(!body.openrouterKey.hint!.includes('a1b2c3d4'), 'le masque ne doit pas exposer le corps de la clé');
  assert.ok(body.openrouterKey.updatedAt && !Number.isNaN(Date.parse(body.openrouterKey.updatedAt)));
  assert.deepEqual(body.ffmpeg, { ok: true, version: '6.1.1' });
  assert.equal(body.mediaDir, resolve(mediaDir));
  assert.equal(body.mediaDirExists, true);
  assert.equal(body.uploadMaxMb, 2048);
  assert.equal(body.dbPath, resolve(process.env.DB_PATH!));
  assertNoLeak(KEY_A, body, 'GET /admin/settings');
  mod.clearOpenRouterKey();
});

test('PUT /admin/openrouter-key : masque sans fuite, puis DELETE retombe sur « none »', async () => {
  const app = await getApp();
  await resetKey();
  const put = await app.inject({
    method: 'PUT',
    url: '/admin/openrouter-key',
    payload: { key: KEY_B },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(put.statusCode, 200);
  const putBody = put.json() as { openrouterKey: { configured: boolean; source: string; hint?: string } };
  assert.equal(putBody.openrouterKey.configured, true);
  assert.equal(putBody.openrouterKey.source, 'db');
  assert.equal(putBody.openrouterKey.hint, 'sk-or-…' + KEY_B.slice(-4));
  assertNoLeak(KEY_B, putBody, 'PUT /admin/openrouter-key');

  const del = await app.inject({ method: 'DELETE', url: '/admin/openrouter-key', remoteAddress: '127.0.0.1' });
  assert.equal(del.statusCode, 200);
  const delBody = del.json() as { openrouterKey: { configured: boolean; source: string } };
  assert.deepEqual(delBody.openrouterKey, { configured: false, source: 'none', reason: 'missing' });
});

// ---------- 2. validation des saisies ----------

test('PUT refuse vide / trop courte / exemple avec le message français attendu', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();
  for (const bad of ['', '   ', 'sk-', 'sk-...', 'sk-votre-cle-openrouter-ici', 'trop-court']) {
    const res = await app.inject({ method: 'PUT', url: '/admin/openrouter-key', payload: { key: bad }, remoteAddress: '127.0.0.1' });
    assert.equal(res.statusCode, 400, JSON.stringify(bad));
    assert.equal((res.json() as { error: string }).error, mod.OPENROUTER_KEY_INVALID_MESSAGE, JSON.stringify(bad));
  }
  assert.equal(mod.resolveOpenRouterKey().source, 'none', 'aucune valeur refusée ne doit être stockée');
});

test('GET /admin/settings dégrade proprement quand la table des réglages a disparu', async () => {
  const app = await getApp();
  await resetKey();
  const raw = new Database(process.env.DB_PATH);
  raw.exec('DROP TABLE app_settings');
  raw.close();

  const res = await app.inject({ method: 'GET', url: '/admin/settings' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual((res.json() as { openrouterKey: unknown }).openrouterKey, {
    configured: false,
    source: 'none',
    reason: 'missing',
  });

  // La lecture a recréé la table : une écriture fonctionne de nouveau.
  const put = await app.inject({
    method: 'PUT',
    url: '/admin/openrouter-key',
    payload: { key: KEY_A },
    remoteAddress: '127.0.0.1',
  });
  assert.equal(put.statusCode, 200);
  await resetKey();
});

// ---------- 3. loopback obligatoire ----------

test('écritures et test de clé refusés (403) hors boucle locale ; lecture toujours ouverte', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();
  const remote = { remoteAddress: '203.0.113.5' } as const;

  for (const [method, url] of [
    ['PUT', '/admin/openrouter-key'],
    ['DELETE', '/admin/openrouter-key'],
    ['POST', '/admin/openrouter-key/test'],
  ] as const) {
    const res = await app.inject({ method, url, payload: method === 'PUT' ? { key: KEY_A } : undefined, ...remote });
    assert.equal(res.statusCode, 403, `${method} ${url}`);
    assert.match((res.json() as { error: string }).error, /que depuis cet ordinateur/);
  }
  assert.equal(mod.resolveOpenRouterKey().source, 'none', 'un client distant ne doit rien pouvoir écrire');

  const read = await app.inject({ method: 'GET', url: '/admin/settings', ...remote });
  assert.equal(read.statusCode, 200);
  assert.equal((read.json() as { openrouterKey: { source: string } }).openrouterKey.source, 'none');

  // Boucle locale explicite (IPv4, IPv6) : autorisée.
  for (const remoteAddress of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    const ok = await app.inject({
      method: 'PUT',
      url: '/admin/openrouter-key',
      payload: { key: KEY_A },
      remoteAddress,
    });
    assert.equal(ok.statusCode, 200, remoteAddress);
    await resetKey();
  }
});

test('POST /admin/openrouter-key/test : aucune clé configurée → 400 en français', async () => {
  const app = await getApp();
  await resetKey();
  const res = await app.inject({ method: 'POST', url: '/admin/openrouter-key/test', remoteAddress: '127.0.0.1' });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Aucune clé OpenRouter/);
});

// ---------- 4. précédence base > environnement ----------

test('précédence : la base gagne sur le .env, le .env seul fonctionne, rien → « none »', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();

  // Base + env → base.
  mod.storeOpenRouterKey(KEY_A);
  await withEnvKey(KEY_B, async () => {
    assert.deepEqual(mod.resolveOpenRouterKey(), { key: KEY_A, source: 'db', status: { ok: true } });
    const body = (await app.inject({ url: '/admin/settings' })).json() as { openrouterKey: { source: string; hint?: string } };
    assert.equal(body.openrouterKey.source, 'db');
    assert.equal(body.openrouterKey.hint, 'sk-or-…' + KEY_A.slice(-4));
  });
  mod.clearOpenRouterKey();

  // Env seul.
  await withEnvKey(KEY_B, async () => {
    assert.deepEqual(mod.resolveOpenRouterKey(), { key: KEY_B, source: 'env', status: { ok: true } });
    const body = (await app.inject({ url: '/admin/settings' })).json() as { openrouterKey: { source: string; configured: boolean } };
    assert.equal(body.openrouterKey.source, 'env');
    assert.equal(body.openrouterKey.configured, true);
  });

  // Rien nulle part → none + raison « missing ».
  assert.deepEqual(mod.resolveOpenRouterKey(), { source: 'none', status: { ok: false, reason: 'missing' } });

  // Base restée à l'exemple et env vide → none + raison « placeholder ».
  mod.storeOpenRouterKey('sk-...');
  assert.deepEqual(mod.resolveOpenRouterKey(), { source: 'none', status: { ok: false, reason: 'placeholder' } });
  mod.clearOpenRouterKey();
});

// ---------- 5. chemin de transcription (job) ----------

test('un job avec une clé en base échoue sur le mapping 401 (pas « clé manquante »)', async () => {
  const app = await getApp();
  const mod = await key();
  const { transcribeChunk } = await import('../src/transcribe.ts');
  await resetKey();
  mod.storeOpenRouterKey(KEY_A);

  let calls = 0;
  const stub401 = (async () => {
    calls++;
    return new Response('Missing Authentication header', { status: 401 });
  }) as typeof fetch;
  currentPipeline = async () => {
    await transcribeChunk({ bytes: Buffer.from('x'), chunkDurationSec: 1, fetchImpl: stub401 });
    return done;
  };

  const created = await app.inject({ method: 'POST', url: '/local/jobs', payload: { path: join(mediaDir, 'clip.mp3') } });
  assert.equal(created.statusCode, 202);
  const job = (await waitJob(app, (created.json() as { jobId: string }).jobId)) as {
    status: string;
    message: string;
    error?: string;
  };
  assert.equal(job.status, 'error');
  assert.equal(job.message, OPENROUTER_KEY_MISSING_MESSAGE);
  assert.ok(calls > 0, 'la clé en base doit avoir permis d’atteindre le réseau (stub)');
  assert.match(job.error ?? '', /401/, 'le détail doit porter la cause réelle (401)');
  assertNoLeak(KEY_A, { job, traces }, 'job 401');
  await resetKey();
});

test('sans aucune clé : le job échoue AVANT tout appel réseau', async () => {
  const app = await getApp();
  await resetKey();
  const { transcribeChunk } = await import('../src/transcribe.ts');

  let calls = 0;
  const stub = (async () => {
    calls++;
    return new Response('requête inattendue', { status: 500 });
  }) as typeof fetch;
  currentPipeline = async () => {
    await transcribeChunk({ bytes: Buffer.from('x'), chunkDurationSec: 1, fetchImpl: stub });
    return done;
  };

  const created = await app.inject({ method: 'POST', url: '/local/jobs', payload: { path: join(mediaDir, 'clip.mp3') } });
  const job = (await waitJob(app, (created.json() as { jobId: string }).jobId)) as {
    status: string;
    message: string;
    error?: string;
  };
  assert.equal(job.status, 'error');
  assert.equal(job.message, OPENROUTER_KEY_MISSING_MESSAGE);
  assert.match(job.error ?? '', /OPENROUTER_API_KEY manquante/);
  assert.equal(calls, 0, 'aucune requête réseau ne doit partir sans clé');
  currentPipeline = async () => done;
});

// ---------- 6. test de clé (verdicts) ----------

test('POST /admin/openrouter-key/test : ok, refus d’inférence, 402, 429 et injoignable', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();
  mod.storeOpenRouterKey(KEY_A);

  // NB : ces verdicts ont changé volontairement — l'endpoint ne se contente plus
  // de `GET /key` (qui disait « valide » pour une clé d'administration) mais
  // sonde aussi l'inférence. Les cas provisioning / inference-refused / expired
  // sont couverts en détail dans `test/key-probe.test.ts`.
  const cases: { name: string; fetch: typeof fetch; verdict: string; ok: boolean; expect?: (body: any) => void }[] = [
    {
      name: 'valide',
      fetch: (async () =>
        new Response(JSON.stringify({ data: { usage: 1.5, limit: 10, limit_remaining: 8.5 } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })) as typeof fetch,
      verdict: 'ok',
      ok: true,
      expect: (body) => {
        assert.equal(body.usage, 1.5);
        assert.equal(body.limit, 10);
        assert.equal(body.remaining, 8.5);
      },
    },
    { name: 'refusée', fetch: (async () => new Response('', { status: 401 })) as typeof fetch, verdict: 'inference-refused', ok: false },
    {
      name: 'crédit insuffisant',
      fetch: (async () => new Response('', { status: 402 })) as typeof fetch,
      verdict: 'no-credit',
      ok: false,
    },
    { name: 'débit limité', fetch: (async () => new Response('', { status: 429 })) as typeof fetch, verdict: 'rate-limited', ok: false },
    {
      name: 'injoignable',
      fetch: (async () => {
        throw new Error('ECONNREFUSED');
      }) as typeof fetch,
      verdict: 'unreachable',
      ok: false,
    },
  ];

  for (const c of cases) {
    currentKeyTestFetch = c.fetch;
    const res = await app.inject({ method: 'POST', url: '/admin/openrouter-key/test', remoteAddress: '127.0.0.1' });
    assert.equal(res.statusCode, 200, c.name);
    const body = res.json() as { ok: boolean; verdict: string; message: string };
    assert.equal(body.verdict, c.verdict, c.name);
    assert.equal(body.ok, c.ok, c.name);
    assert.ok(body.message.length > 0 && /[a-zà-ÿ]/i.test(body.message), `message français attendu (${c.name})`);
    c.expect?.(body);
    assertNoLeak(KEY_A, body, `test ${c.name}`);
  }
  await resetKey();
});

// ---------- 7. pas de client périmé après mise à jour ----------

test('une clé changée depuis l’administration est utilisée par le chapitrage suivant', async () => {
  const app = await getApp();
  const mod = await key();
  const { proposeChapters } = await import('../src/chapters.ts');
  await resetKey();

  const authHeaders: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string> | Headers;
    const auth =
      typeof (headers as Headers).get === 'function'
        ? (headers as Headers).get('authorization')
        : ((Object.entries(headers as Record<string, string>).find(([k]) => k.toLowerCase() === 'authorization')?.[1] as string | undefined) ?? null);
    if (auth) authHeaders.push(auth);
    return new Response(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'test',
        choices: [{ index: 0, message: { role: 'assistant', content: '{"chapters":[]}' }, finish_reason: 'stop' }],
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  try {
    mod.storeOpenRouterKey(KEY_A);
    await proposeChapters({ title: 'T', durationSec: 600 }, [{ startSec: 0, text: 'bonjour' }]);
    assert.equal(authHeaders[0], `Bearer ${KEY_A}`);

    // Mise à jour via les endpoints d'administration (comme le ferait la page).
    const put = await app.inject({
      method: 'PUT',
      url: '/admin/openrouter-key',
      payload: { key: KEY_B },
      remoteAddress: '127.0.0.1',
    });
    assert.equal(put.statusCode, 200);

    await proposeChapters({ title: 'T', durationSec: 600 }, [{ startSec: 0, text: 'bonjour' }]);
    assert.equal(authHeaders[authHeaders.length - 1], `Bearer ${KEY_B}`, 'le client ne doit pas garder l’ancienne clé');
    assert.deepEqual(authHeaders, [`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
  } finally {
    globalThis.fetch = originalFetch;
    await resetKey();
  }
});

// ---------- 8. pages ----------

test('GET /admin sert une page d’administration complète et accessible', async () => {
  const app = await getApp();
  const res = await app.inject({ method: 'GET', url: '/admin' });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'] as string, /text\/html/);
  assert.ok(res.body.includes('<html lang="fr">'));
  for (const label of ['Enregistrer', 'Supprimer la clé', 'Tester la clé', 'Actualiser']) {
    assert.ok(res.body.includes(label), `action manquante : ${label}`);
  }
  assert.match(res.body, /type="password"/);
  assert.match(res.body, /autocomplete="off"/);
  assert.match(res.body, /<label[^>]*for="key-input"/);
  assert.ok(!/localStorage/.test(res.body), 'aucune persistance locale ne doit être utilisée');
  assert.match(res.body, /en clair/i);
  assert.match(res.body, /ne partagez pas|ne le partagez pas|ne partagez pas ce fichier/i);
  assert.match(res.body, /id="db-path"/);
});

test('la page d’administration rend le masque, l’état et les outils', async () => {
  const routes = async (url: string) => {
    if (url === '/admin/settings') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          openrouterKey: { configured: true, source: 'db', hint: 'sk-or-…c3d4', updatedAt: '2026-01-02T03:04:05.000Z' },
          ffmpeg: { ok: true, version: '6.1.1' },
          ffprobe: { ok: true, version: '6.1.1' },
          mediaDir: 'C:\\Vidéos',
          mediaDirExists: false,
          uploadMaxMb: 512,
          dbPath: 'data/chapters.db',
        }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes, { file: new URL('../src/web/admin.html', import.meta.url) });
  await settle();

  assert.match(page.el('status-badge-text').textContent, /Configurée/);
  assert.match(page.el('key-hint').textContent, /sk-or-…c3d4/);
  assert.match(page.el('key-source').textContent, /Base de données/);
  assert.match(page.el('tools-text').textContent, /disponibles/);
  assert.equal(page.el('media-warn').hidden, false, 'le dossier manquant doit être signalé');
  assert.match(page.el('media-warn-text').textContent, /introuvable/);
  assert.equal(page.el('upload-max').textContent, '512 Mo');
  assert.equal(page.el('db-path').textContent, 'data/chapters.db');
  assert.ok(!JSON.stringify(page.els.get('key-hint')).includes('a1b2c3d4'));
});

test('le bandeau de la page principale disparaît dès qu’une clé est en base', async () => {
  const app = await getApp();
  const mod = await key();
  await resetKey();
  mod.storeOpenRouterKey(KEY_A);

  const health = (await app.inject({ url: '/local/health' })).json() as { openrouterKey: unknown };
  assert.deepEqual(health.openrouterKey, { ok: true });

  const page = bootPage(
    async (url: string) => {
      if (url === '/local/health') return { ok: true, status: 200, json: async () => health };
      throw new Error('URL inattendue : ' + url);
    },
  );
  await settle();
  assert.equal(page.el('health-banner').hidden, true, 'aucun bandeau quand la base porte une clé');

  // La page principale expose bien le lien discret vers l'administration.
  const main = await app.inject({ method: 'GET', url: '/' });
  assert.match(main.body, /href="\/admin"/);
  assert.ok(main.body.includes('Administration'));
  await resetKey();
});

test('aucune trace serveur de la clé pour l’ensemble des actions', async () => {
  assert.equal(traces.length > 0, true, 'au moins un échec de job doit avoir été tracé');
  assertNoLeak(KEY_A, traces, 'traces serveur');
  assertNoLeak(KEY_B, traces, 'traces serveur');
});

// Garde-fou : la table existe toujours à la fin (le dernier test l'a rejouée).
test('la table des réglages est toujours opérationnelle en fin de série', async () => {
  const mod = await key();
  assert.equal(mod.storeOpenRouterKey(KEY_A), true);
  assert.equal(mod.resolveOpenRouterKey().source, 'db');
  await resetKey();
});

// Le registre de jobs doit rester utilisable (régression évitée) : on vérifie
// simplement qu'un pipeline neutre s'exécute encore.
test('un job neutre reste possible après les tests d’administration', async () => {
  const registry = createJobRegistry(async () => done);
  const job = registry.createJob({ path: join(mediaDir, 'clip.mp3') });
  for (let i = 0; i < 200 && registry.getJob(job.id)!.status !== 'done'; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.equal(registry.getJob(job.id)!.status, 'done');
});
