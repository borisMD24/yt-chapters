// Tests du sonde de clé OpenRouter « qui prouve l'inférence ».
//
// Défaut d'origine : `GET /api/v1/key` répond 200 pour une clé de
// provisioning/administration (elle sert à ADMINISTRER des clés) alors que
// OpenRouter refuse toute inférence (« 401 User not found. »). L'endpoint de
// test annonçait donc « valide » à tort, et la transcription échouait ensuite.
//
// Ici, tout est HORS LIGNE : les deux appels (`GET /key` puis la sonde
// `POST /chat/completions`) sont simulés par un `fetch` injecté. Aucune clé
// réelle n'est utilisée, aucun appel réseau ne part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { bootPage, settle } from './web-harness.ts';
import {
  OPENROUTER_KEY_ENDPOINT,
  OPENROUTER_INFERENCE_ENDPOINT,
  testOpenRouterKey,
} from '../src/openrouter-key-test.ts';
import { OPENROUTER_KEY_INFERENCE_REFUSED_MESSAGE, OPENROUTER_KEY_MISSING_MESSAGE, friendlyErrorMessage } from '../src/jobs.ts';

// --- environnement isolé, posé AVANT tout import qui touche la base ---
const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-probe-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ckr-probe-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'probe.db');
delete process.env.OPENROUTER_API_KEY;

/** Deux clés plausibles distinctes (jamais de vraies clés). */
const KEY_A = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);

/** Un corps de réponse 401 identique à celui observé en vrai. */
const USER_NOT_FOUND_401 = JSON.stringify({ error: { message: 'User not found.', code: 401 } });

type Call = { url: string; method: string; body?: string };

/**
 * `fetch` simulé, scriptable par URL : `account` répond à `GET /key`,
 * `probe` à `POST /chat/completions`. Les appels sont journalisés (jamais la
 * clé : on ne garde que l'URL, la méthode et le corps, qui n'en contient pas).
 */
function stubFetch(handlers: {
  account?: () => Response | Promise<Response>;
  probe?: () => Response | Promise<Response>;
}): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
    if (url === OPENROUTER_KEY_ENDPOINT) {
      if (!handlers.account) throw new Error('test : appel « compte » inattendu');
      return handlers.account();
    }
    if (url === OPENROUTER_INFERENCE_ENDPOINT) {
      if (!handlers.probe) throw new Error('test : sonde d’inférence inattendue');
      return handlers.probe();
    }
    throw new Error('test : URL inattendue ' + url);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

/** Réponse « compte » 200 avec les champs d'état d'OpenRouter. */
function account200(data: Record<string, unknown>): () => Response {
  return () => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
}

/** Réponse minimale de complétion (ne consomme rien de réel ici). */
const probe200 = () =>
  new Response(
    JSON.stringify({ id: 'c', object: 'chat.completion', choices: [{ message: { role: 'assistant', content: 'a' } }] }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** La clé (ou un fragment de ≥ 8 caractères) ne doit jamais fuiter dans le verdict. */
function assertNoLeak(result: unknown): void {
  const json = JSON.stringify(result);
  assert.ok(!json.includes(KEY_A), 'la clé complète ne doit jamais apparaître');
  for (let i = 0; i + 8 <= KEY_A.length; i++) {
    assert.ok(!json.includes(KEY_A.slice(i, i + 8)), 'fragment de clé divulgué');
  }
}

// ---------- 1. un appel « compte » 200 ne suffit plus à dire « valide » ----------

test('flags de provisioning/administration → verdict « provisioning », sonde NON lancée', async () => {
  for (const flags of [
    { is_provisioning_key: true, is_management_key: false },
    { is_provisioning_key: false, is_management_key: true },
    { is_provisioning_key: true, is_management_key: true },
  ]) {
    const { fetch, calls } = stubFetch({ account: account200({ usage: 0, limit: null, ...flags }) });
    const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch });
    assert.equal(result.ok, false, JSON.stringify(flags));
    assert.equal(result.verdict, 'provisioning', JSON.stringify(flags));
    // Message actionnable : administration + clé d'API normale + lien.
    assert.match(result.message, /administrer des clés/);
    assert.match(result.message, /ne peut pas transcrire/);
    assert.match(result.message, /clé d'API normale/i);
    assert.match(result.message, /openrouter\.ai\/settings\/keys/);
    assert.equal(calls.filter((c) => c.url === OPENROUTER_INFERENCE_ENDPOINT).length, 0, 'aucune sonde pour une clé d’administration');
    assertNoLeak(result);
  }
});

test('401 « User not found » sur la sonde (compte 200) → verdict « inference-refused »', async () => {
  const { fetch, calls } = stubFetch({
    account: account200({ usage: 0, limit: null, is_provisioning_key: false, is_management_key: false }),
    probe: () => new Response(USER_NOT_FOUND_401, { status: 401 }),
  });
  const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'inference-refused');
  // Les TROIS causes réelles mentionnées + lien vers les réglages.
  assert.match(result.message, /administrer des clés/);
  assert.match(result.message, /expir/i);
  assert.match(result.message, /révoqu/i);
  assert.match(result.message, /openrouter\.ai\/settings\/keys/);
  assert.equal(calls.length, 2, 'un appel compte + une sonde');
  assert.equal(calls[1].url, OPENROUTER_INFERENCE_ENDPOINT);
  assertNoLeak(result);
});

test('compte 401 (corps quelconque) → message neutre, sans affirmer « User not found »', async () => {
  for (const body of [USER_NOT_FOUND_401, '{"error":{"message":"No auth credentials found"}', '']) {
    const { fetch, calls } = stubFetch({ account: () => new Response(body, { status: 401 }) });
    const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch });
    assert.equal(result.ok, false, body);
    assert.equal(result.verdict, 'inference-refused', body);
    // Causes plausibles + lien, sans citer un corps qui n'a jamais été lu.
    assert.match(result.message, /clé invalide/i);
    assert.match(result.message, /expir/i);
    assert.match(result.message, /révoqu/i);
    assert.match(result.message, /openrouter\.ai\/settings\/keys/);
    assert.ok(!/user not found/i.test(result.message), 'ne pas affirmer un corps non lu');
    assert.equal(calls.length, 1, 'aucune sonde quand le compte refuse déjà la clé');
    assertNoLeak(result);
  }
});

test('la sonde est minimale : modèle de chapitrage, max_tokens 1, jamais d’audio', async () => {
  const { fetch, calls } = stubFetch({ account: account200({ usage: 1, limit: 5 }), probe: probe200 });
  const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch, model: 'modele-de-test' });
  assert.equal(result.verdict, 'ok');
  const probe = calls.find((c) => c.url === OPENROUTER_INFERENCE_ENDPOINT);
  assert.ok(probe?.body, 'la sonde doit envoyer un corps JSON');
  const body = JSON.parse(probe!.body!) as Record<string, unknown>;
  assert.equal(body.model, 'modele-de-test');
  assert.equal(body.max_tokens, 1);
  assert.ok(!JSON.stringify(body).includes('audio'), 'jamais d’audio dans la sonde');
});

// ---------- 2. expiration et autres codes HTTP ----------

test('expires_at dans le passé → verdict « expired » avec la date', async () => {
  const past = '2020-01-02T03:04:05.000Z';
  const { fetch } = stubFetch({ account: account200({ usage: 0, limit: 5, expires_at: past }), probe: probe200 });
  const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, 'expired');
  assert.equal(result.expiresAt, past);
  assert.match(result.message, /expir/i);
  assert.match(result.message, /openrouter\.ai\/settings\/keys/);
  assertNoLeak(result);
});

test('expires_at dans le futur → verdict « ok » et date renvoyée', async () => {
  const future = '2999-12-31T23:59:59.000Z';
  const { fetch } = stubFetch({
    account: account200({ usage: 1.5, limit: 10, limit_remaining: 8.5, expires_at: future }),
    probe: probe200,
  });
  const result = await testOpenRouterKey(KEY_A, { fetchImpl: fetch });
  assert.equal(result.ok, true);
  assert.equal(result.verdict, 'ok');
  assert.equal(result.expiresAt, future);
  assert.equal(result.usage, 1.5);
  assert.equal(result.limit, 10);
  assert.equal(result.remaining, 8.5);
  assertNoLeak(result);
});

test('402 → « no-credit » ; 429 → « rate-limited » (sur la sonde)', async () => {
  const credit = stubFetch({ account: account200({ usage: 0 }), probe: () => new Response('', { status: 402 }) });
  const creditResult = await testOpenRouterKey(KEY_A, { fetchImpl: credit.fetch });
  assert.equal(creditResult.verdict, 'no-credit');
  assert.equal(creditResult.ok, false);
  assert.match(creditResult.message, /[Cc]rédit/);

  const limited = stubFetch({ account: account200({ usage: 0 }), probe: () => new Response('', { status: 429 }) });
  const limitedResult = await testOpenRouterKey(KEY_A, { fetchImpl: limited.fetch });
  assert.equal(limitedResult.verdict, 'rate-limited');
  assert.equal(limitedResult.ok, false);
  assert.match(limitedResult.message, /Trop de requêtes/);
});

test('réseau injoignable (compte ou sonde) → « unreachable »', async () => {
  const downAccount = stubFetch({
    account: () => {
      throw new Error('ECONNREFUSED');
    },
  });
  const a = await testOpenRouterKey(KEY_A, { fetchImpl: downAccount.fetch });
  assert.equal(a.verdict, 'unreachable');
  assert.equal(downAccount.calls.length, 1);

  const downProbe = stubFetch({
    account: account200({ usage: 0 }),
    probe: () => {
      throw new Error('ETIMEDOUT');
    },
  });
  const b = await testOpenRouterKey(KEY_A, { fetchImpl: downProbe.fetch });
  assert.equal(b.verdict, 'unreachable');
  assert.equal(downProbe.calls.length, 2, 'le compte a répondu, seule la sonde est tombée');
});

// ---------- 3. mapping des erreurs de job ----------

test('job : un 401 « User not found » produit le message d’administration/expiration/révocation', () => {
  const message = friendlyErrorMessage(new Error(`OpenRouter STT 401: ${USER_NOT_FOUND_401}`));
  assert.equal(message, OPENROUTER_KEY_INFERENCE_REFUSED_MESSAGE);
  assert.match(message, /administrer des clés/);
  assert.match(message, /expir/i);
  assert.match(message, /révoqu/i);
  assert.match(message, /openrouter\.ai\/settings\/keys/);

  // Un 401 générique (sans « User not found ») garde le message de clé existant.
  assert.equal(friendlyErrorMessage(new Error('OpenRouter STT 401: Missing Authentication header')), OPENROUTER_KEY_MISSING_MESSAGE);
  // Et la clé ne doit jamais apparaître dans le message.
  const withKey = friendlyErrorMessage(new Error(`401 User not found. ${KEY_A}`));
  assert.ok(!withKey.includes(KEY_A));
});

// ---------- 4. route HTTP : jamais de sonde sans clé, jamais au chargement ----------

let appPromise: Promise<FastifyInstance> | null = null;
let probeCalls = 0;
const getApp = () =>
  (appPromise ??= import('../src/app.ts').then((m) =>
    m.createApp({
      pipeline: async () => ({ videoId: 'local:x', chapters: [], text: '', warnings: [], durationSec: 0 }),
      logger: false,
      toolChecker: async () => ({ ok: true }),
      preflight: false,
      sweepStaleUploads: false,
      keyTestFetch: (async () => {
        probeCalls++;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    }),
  ));

test('POST /admin/openrouter-key/test sans clé : 400 en français, AUCUN appel réseau', async () => {
  const app = await getApp();
  const { clearOpenRouterKey } = await import('../src/openrouter-key.ts');
  clearOpenRouterKey();
  delete process.env.OPENROUTER_API_KEY;

  probeCalls = 0;
  const res = await app.inject({ method: 'POST', url: '/admin/openrouter-key/test', remoteAddress: '127.0.0.1' });
  assert.equal(res.statusCode, 400);
  assert.match((res.json() as { error: string }).error, /Aucune clé OpenRouter/);
  assert.equal(probeCalls, 0, 'aucune sonde ne doit partir quand aucune clé n’est configurée');
  await app.close();
  appPromise = null;
});

test('la page d’administration ne lance JAMAIS la sonde au chargement', async () => {
  const probes: string[] = [];
  const page = bootPage(
    async (url: string, init?: { method?: string }) => {
      if (url === '/admin/settings') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ openrouterKey: { configured: true, source: 'db', hint: 'sk-or-…c3d4' }, ffmpeg: { ok: true }, ffprobe: { ok: true }, mediaDir: 'X', mediaDirExists: true, uploadMaxMb: 1, dbPath: 'x' }),
        };
      }
      if (url === '/admin/openrouter-key/test') {
        probes.push(init?.method ?? 'GET');
        return { ok: true, status: 200, json: async () => ({ ok: false, verdict: 'provisioning', message: 'Cette clé sert à administrer des clés, elle ne peut pas transcrire.', expiresAt: '2026-12-11T14:00:39.730Z' }) };
      }
      throw new Error('URL inattendue : ' + url);
    },
    { file: new URL('../src/web/admin.html', import.meta.url) },
  );
  await settle();
  assert.deepEqual(probes, [], 'le chargement de la page ne doit déclencher aucun test de clé');

  // Le bouton, lui, déclenche bien la sonde et rend le verdict (avec la date).
  page.fire('test-key', 'click');
  await settle();
  assert.deepEqual(probes, ['POST']);
  assert.match(page.el('key-message-text').textContent, /administrer des clés/);
  assert.match(page.el('key-message-text').textContent, /Expire le/);
});

test('la page affiche une ligne d’avertissement : une clé d’administration ne peut pas transcrire', async () => {
  // Vérifié sur le MARKUP : le faux DOM du harnais ne remplit pas le texte
  // statique des éléments depuis le HTML.
  const adminHtml = readFileSync(new URL('../src/web/admin.html', import.meta.url), 'utf8');
  assert.match(adminHtml, /id="key-provisioning-note"/, 'la ligne d’avertissement doit exister');
  assert.match(adminHtml, /ne peut pas transcrire/i);
  assert.match(adminHtml, /openrouter\.ai\/settings\/keys/);
});
