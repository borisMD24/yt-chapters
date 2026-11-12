// Tests des crédits OpenRouter : lecture (usage, limite, restant, expiration),
// cache 60 s, rafraîchissement forcé, dégradation en français, avertissement de
// crédit presque épuisé — et surtout : JAMAIS de clé dans une réponse.
//
// Entièrement hors ligne : `fetch` est TOUJOURS injecté (fournisseur unitaire
// ou `creditsFetch` de l'application). Aucun appel réseau réel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import type { ResolvedOpenRouterKey } from '../src/openrouter-key.ts';
import { bootPage, settle } from './web-harness.ts';

const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-credits-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ckr-credits-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'credits.db');
delete process.env.OPENROUTER_API_KEY;

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

/** Clé plausible (jamais une vraie clé). */
const KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);

type CreditsModule = typeof import('../src/openrouter-credits.ts');
let mod: CreditsModule | null = null;
const credits = async (): Promise<CreditsModule> => (mod ??= await import('../src/openrouter-credits.ts'));

/** Interdit toute fuite : la clé, ni même un fragment de 8 caractères. */
function assertNoLeak(secret: string, payload: unknown, label: string): void {
  const json = JSON.stringify(payload);
  assert.ok(!json.includes(secret), `${label} : la clé ne doit jamais apparaître`);
  for (let i = 0; i + 8 <= secret.length; i++) {
    const fragment = secret.slice(i, i + 8);
    assert.ok(!json.includes(fragment), `${label} : fragment « ${fragment} » divulgué`);
  }
}

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Horloge contrôlée : avance à la demande pour traverser le cache. */
function makeClock(startMs = 1_700_000_000_000) {
  let value = startMs;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

const dbKey = { key: KEY, source: 'db' as const, status: { ok: true } };
const noKey = { source: 'none' as const, status: { ok: false, reason: 'missing' as const } };

// ---------- 1. mise en forme du corps OpenRouter ----------

test('mapCreditsPayload lit usage/limite/restant/expiration et calcule le restant manquant', async () => {
  const { mapCreditsPayload } = await credits();
  assert.deepEqual(
    mapCreditsPayload({ data: { usage: 1.5, limit: 10, limit_remaining: 8.5, expires_at: '2027-01-01T00:00:00Z' } }),
    { usage: 1.5, limit: 10, limit_remaining: 8.5, expires_at: '2027-01-01T00:00:00Z' },
  );
  // `limit_remaining: null` (aucune limite) + limite et usage connus → restant calculé.
  assert.deepEqual(mapCreditsPayload({ data: { usage: 4, limit: 10, limit_remaining: null } }), {
    usage: 4,
    limit: 10,
    limit_remaining: 6,
  });
  // Rien d'exploitable : aucun champ inventé.
  assert.deepEqual(mapCreditsPayload({ data: { limit: null, expires_at: null } }), {});
  assert.deepEqual(mapCreditsPayload(null), {});
});

// ---------- 2. fournisseur : chiffres, cache, rafraîchissement ----------

test('le fournisseur renvoie les chiffres, met en cache 60 s, et force sur demande', async () => {
  const { createCreditsProvider } = await credits();
  const clock = makeClock();
  let calls = 0;
  const provider = createCreditsProvider({
    resolve: () => dbKey,
    now: clock.now,
    ttlMs: 60_000,
    fetchImpl: (async () => {
      calls++;
      return jsonResponse({ data: { usage: 12.5, limit: 250, limit_remaining: 237.5, expires_at: '2027-01-01T00:00:00Z' } });
    }) as typeof fetch,
  });

  const first = await provider.get();
  assert.equal(calls, 1);
  assert.equal(first.ok, true);
  assert.equal(first.configured, true);
  assert.equal(first.cached, false);
  assert.equal(first.usage, 12.5);
  assert.equal(first.limit, 250);
  assert.equal(first.limit_remaining, 237.5);
  assert.equal(first.expires_at, '2027-01-01T00:00:00Z');
  assert.equal(first.fetchedAt, new Date(clock.now()).toISOString());
  assert.equal(first.warning, null);
  assert.match(first.summary, /237,50 \$/);
  assertNoLeak(KEY, first, 'instantané crédits');

  // Deuxième appel dans la fenêtre : aucun nouvel appel réseau.
  const second = await provider.get();
  assert.equal(calls, 1, 'le cache doit éviter un second appel');
  assert.equal(second.cached, true);
  assert.equal(second.limit_remaining, 237.5);

  // Après expiration du cache : nouvel appel.
  clock.advance(60_001);
  const third = await provider.get();
  assert.equal(calls, 2);
  assert.equal(third.cached, false);

  // Rafraîchissement forcé : appel même dans la fenêtre.
  const forced = await provider.get(true);
  assert.equal(calls, 3);
  assert.equal(forced.cached, false);
  assertNoLeak(KEY, forced, 'instantané rafraîchi');
});

// ---------- 3. aucune clé → aucun appel ----------

test('sans clé configurée : aucun appel réseau, message français', async () => {
  const { createCreditsProvider, CREDITS_MISSING_KEY_MESSAGE } = await credits();
  let calls = 0;
  const provider = createCreditsProvider({
    resolve: () => noKey,
    fetchImpl: (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof fetch,
  });

  const snapshot = await provider.get();
  assert.equal(calls, 0, 'aucune requête ne doit partir sans clé');
  assert.equal(snapshot.configured, false);
  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.summary, CREDITS_MISSING_KEY_MESSAGE);
  assert.equal(snapshot.warning, null);

  // Clé restée à un exemple : même refus, message adapté.
  const placeholder = createCreditsProvider({
    resolve: () => ({ source: 'db', status: { ok: false, reason: 'placeholder' } }),
    fetchImpl: (async () => {
      throw new Error('ne doit jamais être appelé');
    }) as typeof fetch,
  });
  const ph = await placeholder.get();
  assert.equal(ph.configured, false);
  assert.match(ph.summary, /exemple/);
});

// ---------- 4. erreurs réseau / HTTP : dégradation en français ----------

test('réseau injoignable et refus HTTP : message français, jamais d’exception', async () => {
  const { createCreditsProvider, CREDITS_UNREACHABLE_MESSAGE, CREDITS_REFUSED_KEY_MESSAGE } = await credits();

  const down = createCreditsProvider({
    resolve: () => dbKey,
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch,
  });
  const downSnapshot = await down.get();
  assert.equal(downSnapshot.ok, false);
  assert.equal(downSnapshot.configured, true);
  assert.equal(downSnapshot.summary, CREDITS_UNREACHABLE_MESSAGE);
  assert.equal(downSnapshot.warning, null);
  assertNoLeak(KEY, downSnapshot, 'crédits injoignables');

  const refused = createCreditsProvider({
    resolve: () => dbKey,
    fetchImpl: (async () => new Response('', { status: 401 })) as typeof fetch,
  });
  const refusedSnapshot = await refused.get();
  assert.equal(refusedSnapshot.ok, false);
  assert.equal(refusedSnapshot.summary, CREDITS_REFUSED_KEY_MESSAGE);
  assertNoLeak(KEY, refusedSnapshot, 'crédits refusés');

  const weird = createCreditsProvider({
    resolve: () => dbKey,
    fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
  });
  const weirdSnapshot = await weird.get();
  assert.equal(weirdSnapshot.ok, false);
  assert.match(weirdSnapshot.summary, /code 500/);
});

// ---------- 5. avertissement de crédit presque épuisé ----------

test('l’avertissement ne s’affiche que pour un restant connu et sous le seuil', async () => {
  const { lowCreditWarning, LOW_CREDIT_THRESHOLD_USD } = await credits();
  const base = { fetchedAt: new Date().toISOString(), cached: false, summary: '', warning: null };

  assert.equal(LOW_CREDIT_THRESHOLD_USD, 1);
  const low = lowCreditWarning({ ...base, ok: true, configured: true, source: 'db', limit_remaining: 0.42 });
  assert.ok(low, 'sous le seuil : un avertissement est attendu');
  assert.match(low!, /0,42 \$/);
  assert.match(low!, /openrouter\.ai/);

  assert.equal(lowCreditWarning({ ...base, ok: true, configured: true, source: 'db', limit_remaining: 5 }), null);
  assert.equal(
    lowCreditWarning({ ...base, ok: true, configured: true, source: 'db', limit_remaining: 1 }),
    null,
    'le seuil lui-même n’alerte pas',
  );
  assert.equal(
    lowCreditWarning({ ...base, ok: true, configured: true, source: 'db' }),
    null,
    'restant inconnu : aucune alerte',
  );
  assert.equal(lowCreditWarning({ ...base, ok: false, configured: true, source: 'db' }), null);
  assert.equal(lowCreditWarning({ ...base, ok: false, configured: false, source: 'none' }), null);
});

// ---------- 6. routes HTTP ----------

async function makeApp(options: { fetchImpl: typeof fetch; resolver?: () => ResolvedOpenRouterKey }): Promise<FastifyInstance> {
  const { createCreditsProvider } = await credits();
  const provider = createCreditsProvider({
    fetchImpl: options.fetchImpl,
    resolve: options.resolver ?? (() => dbKey),
  });
  const { createApp } = await import('../src/app.ts');
  return createApp({
    logger: false,
    preflight: false,
    sweepStaleUploads: false,
    toolChecker: async () => ({ ok: true, version: 'test' }),
    credits: provider,
  });
}

test('GET /admin/credits sert les chiffres, POST /admin/credits/refresh force la relecture', async () => {
  let calls = 0;
  const app = await makeApp({
    fetchImpl: (async () => {
      calls++;
      return jsonResponse({ data: { usage: 1.5, limit: 10, limit_remaining: 8.5 } });
    }) as typeof fetch,
  });
  try {
    const first = await app.inject({ method: 'GET', url: '/admin/credits' });
    assert.equal(first.statusCode, 200);
    const body = first.json() as Record<string, unknown>;
    assert.equal(body.ok, true);
    assert.equal(body.usage, 1.5);
    assert.equal(body.limit, 10);
    assert.equal(body.limit_remaining, 8.5);
    assert.equal(typeof body.fetchedAt, 'string');
    assert.equal(body.cached, false);
    assert.match(String(body.summary), /8,50 \$/);
    assertNoLeak(KEY, body, 'GET /admin/credits');

    const cached = await app.inject({ method: 'GET', url: '/admin/credits' });
    assert.equal(calls, 1, 'la seconde lecture reste dans le cache');
    assert.equal((cached.json() as { cached: boolean }).cached, true);

    const refreshed = await app.inject({ method: 'POST', url: '/admin/credits/refresh', remoteAddress: '127.0.0.1' });
    assert.equal(refreshed.statusCode, 200);
    assert.equal(calls, 2, 'le rafraîchissement doit réellement relire');
    assert.equal((refreshed.json() as { cached: boolean }).cached, false);

    // Rafraîchissement distant : refusé (boucle locale uniquement).
    const remote = await app.inject({ method: 'POST', url: '/admin/credits/refresh', remoteAddress: '203.0.113.9' });
    assert.equal(remote.statusCode, 403);
    assert.equal(calls, 2, 'aucun appel réseau pour un client distant');

    // LECTURE des chiffres financiers : elle aussi réservée à la boucle locale.
    // Le refus est en français et ne déclenche AUCUN appel réseau.
    const remoteRead = await app.inject({ method: 'GET', url: '/admin/credits', remoteAddress: '203.0.113.9' });
    assert.equal(remoteRead.statusCode, 403);
    assert.match((remoteRead.json() as { error: string }).error, /que depuis cet ordinateur/);
    assert.equal(calls, 2, 'un client distant ne provoque aucun appel réseau');
    assert.ok(!JSON.stringify(remoteRead.json()).includes('limit_remaining'), 'aucune donnée de compte dans le refus');
  } finally {
    await app.close();
  }
});

test('sans clé, /admin/credits ne fait AUCUN appel réseau et /local/credits reste neutre', async () => {
  let calls = 0;
  const app = await makeApp({
    resolver: () => ({ source: 'none', status: { ok: false, reason: 'missing' } }),
    fetchImpl: (async () => {
      calls++;
      return jsonResponse({});
    }) as typeof fetch,
  });
  try {
    const creditsRes = await app.inject({ method: 'GET', url: '/admin/credits' });
    assert.equal(creditsRes.statusCode, 200);
    const body = creditsRes.json() as { configured: boolean; ok: boolean; summary: string };
    assert.equal(body.configured, false);
    assert.equal(body.ok, false);
    assert.match(body.summary, /Aucune clé OpenRouter/);

    const page = await app.inject({ method: 'GET', url: '/local/credits' });
    assert.equal(page.statusCode, 200);
    assert.deepEqual(page.json(), { configured: false, ok: false, warning: null });
    assert.equal(calls, 0, 'aucun appel réseau sans clé');
  } finally {
    await app.close();
  }
});

test('la page principale ne reçoit que l’avertissement, jamais un montant', async () => {
  const app = await makeApp({
    fetchImpl: (async () => jsonResponse({ data: { usage: 249.6, limit: 250, limit_remaining: 0.4 } })) as typeof fetch,
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/local/credits' });
    const body = res.json() as { configured: boolean; ok: boolean; warning: string | null };
    assert.equal(body.configured, true);
    assert.ok(body.warning);
    assert.match(body.warning!, /0,40 \$/);
    // Aucun montant exposé : un pair du réseau local n'apprend qu'un booléen.
    assert.ok(!('limit_remaining' in body), 'aucun montant ne doit sortir par /local/credits');
    assert.ok(!('usage' in body) && !('limit' in body));
    assertNoLeak(KEY, body, 'GET /local/credits');
  } finally {
    await app.close();
  }
});

test('GET /local/credits reste accessible en lecture, mais sans montant', async () => {
  const app = await makeApp({
    fetchImpl: (async () => jsonResponse({ data: { usage: 1, limit: 10, limit_remaining: 9 } })) as typeof fetch,
  });
  try {
    // Un pair du réseau local obtient 200, mais seulement l'état booléen.
    const res = await app.inject({ method: 'GET', url: '/local/credits', remoteAddress: '203.0.113.9' });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.json(), { configured: true, ok: true, warning: null });
  } finally {
    await app.close();
  }
});

test('GET /admin/settings expose le dossier des journaux', async () => {
  const app = await makeApp({ fetchImpl: (async () => jsonResponse({})) as typeof fetch });
  try {
    const res = await app.inject({ method: 'GET', url: '/admin/settings' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { logsDir?: string };
    assert.ok(body.logsDir && body.logsDir.endsWith('logs'), `logsDir attendu, reçu : ${body.logsDir}`);
  } finally {
    await app.close();
  }
});

// ---------- 7. pages ----------

test('la page d’administration rend le panneau des crédits et permet de le rafraîchir', async () => {
  const routes = async (url: string, init?: { method?: string }) => {
    if (url === '/admin/settings') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          openrouterKey: { configured: true, source: 'db', hint: 'sk-or-…c3d4' },
          ffmpeg: { ok: true, version: '6.1.1' },
          ffprobe: { ok: true, version: '6.1.1' },
          mediaDir: 'C:\\Vidéos',
          mediaDirExists: true,
          uploadMaxMb: 512,
          dbPath: 'data/chapters.db',
          logsDir: 'C:\\projet\\logs',
        }),
      };
    }
    if (url === '/admin/credits') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          configured: true,
          source: 'db',
          usage: 12.4,
          limit: 250,
          limit_remaining: 237.6,
          expires_at: '2027-01-01T00:00:00Z',
          fetchedAt: '2026-01-02T03:04:05.000Z',
          cached: false,
          summary: 'Il vous reste 237,60 $ sur 250 $.',
          warning: null,
        }),
      };
    }
    if (url === '/admin/credits/refresh' && init?.method === 'POST') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          configured: true,
          source: 'db',
          usage: 12.5,
          limit: 250,
          limit_remaining: 237.5,
          fetchedAt: '2026-01-02T03:05:00.000Z',
          cached: false,
          summary: 'Il vous reste 237,50 $ sur 250 $.',
          warning: null,
        }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  };

  const page = bootPage(routes, { file: new URL('../src/web/admin.html', import.meta.url) });
  await settle();

  assert.match(page.el('credits-summary').textContent, /Il vous reste 237,60 \$ sur 250 \$/);
  assert.equal(page.el('credits-usage').textContent, '12,40 $');
  assert.equal(page.el('credits-limit').textContent, '250 $');
  assert.equal(page.el('credits-remaining').textContent, '237,60 $');
  assert.match(page.el('credits-fetched').textContent, /2026/);
  assert.equal(page.el('logs-dir').textContent, 'C:\\projet\\logs');
  assert.ok(!JSON.stringify(page.els.get('credits-summary')).includes('sk-or-'));

  page.fire('credits-refresh', 'click');
  await settle();
  assert.ok(
    page.calls.some((c) => c.url === '/admin/credits/refresh' && c.init?.method === 'POST'),
    'le bouton Rafraîchir doit forcer une relecture',
  );
  assert.match(page.el('credits-summary').textContent, /237,50 \$/);
});

test('la page d’administration annonce le panneau des crédits (HTML statique)', async () => {
  const app = await makeApp({ fetchImpl: (async () => jsonResponse({})) as typeof fetch });
  try {
    const res = await app.inject({ method: 'GET', url: '/admin' });
    assert.equal(res.statusCode, 200);
    for (const label of [
      'Crédits OpenRouter',
      'Utilisation',
      'Limite',
      'Restant',
      'Expiration',
      'Dernière lecture',
      'Rafraîchir',
    ]) {
      assert.ok(res.body.includes(label), `libellé manquant : ${label}`);
    }
    assert.match(res.body, /id="credits-refresh"/);
    assert.match(res.body, /id="logs-dir"/);
  } finally {
    await app.close();
  }
});

test('la page principale affiche (et masque) l’avertissement de crédit discret', async () => {
  const withWarning = bootPage(async (url: string) => {
    if (url === '/local/credits') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          configured: true,
          ok: true,
          warning: 'Crédit OpenRouter presque épuisé : il vous reste 0,40 $.',
        }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  });
  await settle();
  assert.equal(withWarning.el('credit-banner').hidden, false, 'l’avertissement doit être visible');
  assert.match(withWarning.el('credit-text').textContent, /presque épuisé/);

  const without = bootPage(async (url: string) => {
    if (url === '/local/credits') {
      return { ok: true, status: 200, json: async () => ({ configured: true, ok: true, warning: null }) };
    }
    throw new Error('URL inattendue : ' + url);
  });
  await settle();
  assert.equal(without.el('credit-banner').hidden, true, 'aucun avertissement si le crédit est suffisant');
  assert.equal(without.el('credit-text').textContent, '');

  // Route indisponible : la page reste utilisable (aucune exception, bandeau caché).
  const broken = bootPage(async () => {
    throw new Error('réseau coupé');
  });
  await settle();
  assert.equal(broken.el('credit-banner').hidden, true);
});
