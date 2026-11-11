// Tests de la clé OpenRouter : détection (absente / restée à l'exemple / plausible),
// messages d'erreur français EXACTS, endpoint /local/health et bandeau de la page.
// Aucun appel réseau : l'application est injectée et la page est évaluée hors
// navigateur par le harnais partagé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { bootPage, settle } from './web-harness.ts';
import { MIN_OPENROUTER_KEY_LENGTH, openRouterKeyStatus } from '../src/openrouter-key.ts';
import {
  OPENROUTER_CREDIT_MESSAGE,
  OPENROUTER_KEY_MISSING_MESSAGE,
  OPENROUTER_RATE_LIMIT_MESSAGE,
  friendlyErrorMessage,
} from '../src/jobs.ts';

/** Clé plausible : préfixe réel + 64 caractères (jamais une vraie clé). */
const VALID_KEY = 'sk-or-v1-' + 'a1b2c3d4'.repeat(8);

// ---------- 1. détection de la configuration ----------

test('openRouterKeyStatus : clé absente ou vide → missing', () => {
  for (const value of [undefined, '', '   ']) {
    assert.deepEqual(openRouterKeyStatus(value), { ok: false, reason: 'missing' }, JSON.stringify(value));
  }
});

test('openRouterKeyStatus : exemple évident ou trop court → placeholder', () => {
  const cases = [
    'sk-...',
    'sk-or-...',
    'votre-cle',
    'your-key-here',
    'sk-',
    'x'.repeat(MIN_OPENROUTER_KEY_LENGTH - 1),
  ];
  for (const value of cases) {
    assert.deepEqual(openRouterKeyStatus(value), { ok: false, reason: 'placeholder' }, value);
  }
});

test('openRouterKeyStatus : clé plausible → ok, la valeur n’est jamais renvoyée', () => {
  const status = openRouterKeyStatus(VALID_KEY);
  assert.deepEqual(status, { ok: true });
  assert.ok(!JSON.stringify(status).includes(VALID_KEY), 'le statut ne doit porter aucune valeur de clé');
});

test('openRouterKeyStatus lit OPENROUTER_API_KEY quand aucune valeur n’est passée', () => {
  const previous = process.env.OPENROUTER_API_KEY;
  try {
    process.env.OPENROUTER_API_KEY = 'sk-...';
    assert.deepEqual(openRouterKeyStatus(), { ok: false, reason: 'placeholder' });
    process.env.OPENROUTER_API_KEY = VALID_KEY;
    assert.deepEqual(openRouterKeyStatus(), { ok: true });
  } finally {
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
});

test('openRouterKeyStatus : les exemples documentés restent des placeholders', () => {
  const placeholders = [
    'sk-...',
    'sk-or-...',
    'sk-votre-cle-openrouter-ici',
    'sk-your-key-here-openrouter',
    'CHANGE_ME_OPENROUTER_KEY_ICI',
    'sk-xxx-cle-openrouter-ici-xxxx',
    'your-key-here',
    'votre-cle',
  ];
  for (const value of placeholders) {
    assert.deepEqual(openRouterKeyStatus(value), { ok: false, reason: 'placeholder' }, value);
  }
  assert.deepEqual(openRouterKeyStatus(''), { ok: false, reason: 'missing' });
});

/**
 * Fuzz déterministe (PRNG à graine fixe) de clés RÉALISTES : aucune ne doit être
 * prise pour un exemple, sans quoi une vraie clé serait refusée au démarrage.
 * Trois formes : clé hexadécimale de 64 caractères, base64 (32 à 64), et longue
 * suite alphanumérique (20 à 100) — la forme la plus exposée au motif d'exemple.
 */
test('openRouterKeyStatus : le fuzz de clés réalistes ne rejette rien à tort', () => {
  const HEX = '0123456789abcdef';
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (alphabet: string, length: number): string => {
    let out = '';
    for (let i = 0; i < length; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
    return out;
  };
  // PRNG mulberry32 : reproductible, aucune dépendance.
  let state = 0x9e3779b9;
  const rand = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const samples: string[] = [];
  for (let i = 0; i < 2000; i++) samples.push('sk-or-v1-' + pick(HEX, 64));
  for (let i = 0; i < 2000; i++) samples.push('sk-or-v1-' + pick(B64, 32 + Math.floor(rand() * 33)));
  for (let i = 0; i < 2000; i++) samples.push(pick(ALNUM, 20 + Math.floor(rand() * 81)));

  const rejected = samples.filter((s) => !openRouterKeyStatus(s).ok);
  assert.equal(rejected.length, 0, `rejets à tort (${rejected.length}) : ${rejected.slice(0, 3).map((s) => JSON.stringify(s.slice(0, 32))).join(', ')}`);
});

// ---------- 2. messages français exacts ----------

const MESSAGE_CASES: { name: string; err: unknown; expected: string }[] = [
  {
    name: '401 « Missing Authentication header » (cas reproduit)',
    err: new Error('OpenRouter STT 401: Missing Authentication header'),
    expected: OPENROUTER_KEY_MISSING_MESSAGE,
  },
  { name: '403 interdit', err: new Error('OpenRouter STT 403: Forbidden'), expected: OPENROUTER_KEY_MISSING_MESSAGE },
  {
    name: 'en-tête d’authentification absent (autre code)',
    err: new Error('OpenRouter STT 400: Missing Authentication header'),
    expected: OPENROUTER_KEY_MISSING_MESSAGE,
  },
  { name: 'aucun identifiant (No auth credentials)', err: new Error('No auth credentials found'), expected: OPENROUTER_KEY_MISSING_MESSAGE },
  {
    name: 'clé manquante détectée avant l’appel',
    err: new Error('OPENROUTER_API_KEY manquante'),
    expected: OPENROUTER_KEY_MISSING_MESSAGE,
  },
  {
    name: '402 crédit insuffisant',
    err: new Error('OpenRouter STT 402: insufficient credits'),
    expected: OPENROUTER_CREDIT_MESSAGE,
  },
  { name: '429 trop de requêtes', err: new Error('OpenRouter STT 429: Too Many Requests'), expected: OPENROUTER_RATE_LIMIT_MESSAGE },
];

for (const testCase of MESSAGE_CASES) {
  test(`friendlyErrorMessage — ${testCase.name}`, () => {
    assert.equal(friendlyErrorMessage(testCase.err), testCase.expected, testCase.name);
  });
}

test('friendlyErrorMessage garde son repli générique et le cas ffmpeg', () => {
  assert.equal(friendlyErrorMessage(new Error('panne inattendue')), "Le chapitrage n'a pas abouti. Vous pouvez réessayer.");
  assert.match(friendlyErrorMessage(new Error('ffmpeg exited with code 1')), /Impossible de lire ce fichier/);
});

test('le message « clé manquante » ne contient jamais la clé utilisée', () => {
  const secret = 'sk-or-v1-deadbeefdeadbeefdeadbeef';
  const message = friendlyErrorMessage(new Error(`OpenRouter STT 401: Missing Authentication header (key ${secret})`));
  assert.equal(message, OPENROUTER_KEY_MISSING_MESSAGE);
  assert.ok(!message.includes(secret));
});

// ---------- 3. endpoint /local/health ----------

// Environnement isolé, posé AVANT l'import de l'app (DB_PATH est lu à l'import).
const mediaDir = mkdtempSync(join(tmpdir(), 'ckr-key-media-'));
const dbDir = mkdtempSync(join(tmpdir(), 'ckr-key-db-'));
process.env.MEDIA_DIR = mediaDir;
process.env.DB_PATH = join(dbDir, 'key.db');

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

type HealthBody = { openrouterKey: { ok: boolean; reason?: string } };

/** Interroge /local/health avec une clé donnée, sans jamais la laisser fuir. */
async function healthFor(key: string | undefined): Promise<HealthBody> {
  const previous = process.env.OPENROUTER_API_KEY;
  if (key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = key;
  const { createApp } = await import('../src/app.ts');
  const app = createApp({
    pipeline: async () => ({ videoId: 'local:key', chapters: [], text: '', warnings: [], durationSec: 1 }),
    logger: false,
    toolChecker: async () => ({ ok: true, version: '6.1.1' }),
  });
  try {
    const res = await app.inject({ method: 'GET', url: '/local/health' });
    assert.equal(res.statusCode, 200);
    return res.json() as HealthBody;
  } finally {
    await app.close();
    if (previous === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previous;
  }
}

test('GET /local/health : clé absente → openrouterKey.ok=false, reason=missing', async () => {
  const body = await healthFor(undefined);
  assert.deepEqual(body.openrouterKey, { ok: false, reason: 'missing' });
});

test('GET /local/health : clé restée à l’exemple → reason=placeholder, valeur jamais renvoyée', async () => {
  const body = await healthFor('sk-...');
  assert.deepEqual(body.openrouterKey, { ok: false, reason: 'placeholder' });
  assert.ok(!JSON.stringify(body).includes('sk-...'), 'la valeur ne doit jamais être renvoyée, même tronquée');
});

test('GET /local/health : clé plausible → ok=true, aucun fragment de la clé', async () => {
  const body = await healthFor(VALID_KEY);
  assert.deepEqual(body.openrouterKey, { ok: true });
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes(VALID_KEY), 'la clé ne doit jamais être renvoyée');
  assert.ok(!serialized.includes('a1b2c3d4'), 'pas même un fragment');
});

// ---------- 4. bandeau de la page ----------

function bootWithHealth(openrouterKey: unknown) {
  const routes = async (url: string) => {
    if (url === '/local/health') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ffmpeg: { ok: true, version: '6.1.1' }, ffprobe: { ok: true, version: '6.1.1' }, openrouterKey }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  };
  return bootPage(routes);
}

test('la page signale une clé de transcription absente dès le chargement', async () => {
  const page = bootWithHealth({ ok: false, reason: 'missing' });
  await settle();
  assert.equal(page.el('health-banner').hidden, false, 'le bandeau doit être visible');
  assert.match(page.el('health-text').textContent, /Le service de transcription n'est pas configuré/);
  assert.match(page.el('health-text').textContent, /OPENROUTER_API_KEY/);
});

test('la page signale une clé restée à l’exemple', async () => {
  const page = bootWithHealth({ ok: false, reason: 'placeholder' });
  await settle();
  assert.equal(page.el('health-banner').hidden, false);
  assert.match(page.el('health-text').textContent, /Le service de transcription n'est pas configuré/);
  assert.match(page.el('health-text').textContent, /exemple/);
});

test('la page ne signale rien quand la clé est configurée ou absente de la réponse', async () => {
  for (const openrouterKey of [{ ok: true }, undefined]) {
    const page = bootWithHealth(openrouterKey);
    await settle();
    assert.equal(page.el('health-banner').hidden, true, `openrouterKey=${JSON.stringify(openrouterKey)}`);
  }
});

test('les deux bandeaux (outils + clé) cohabitent dans le même message', async () => {
  const routes = async (url: string) => {
    if (url === '/local/health') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ ffmpeg: { ok: false }, ffprobe: { ok: true }, openrouterKey: { ok: false, reason: 'missing' } }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes);
  await settle();
  assert.equal(page.el('health-banner').hidden, false);
  assert.match(page.el('health-text').textContent, /ffmpeg est introuvable sur cet ordinateur/);
  assert.match(page.el('health-text').textContent, /Le service de transcription n'est pas configuré/);
});
