// Test comportemental du script de la page (sans navigateur) : on évalue le
// <script> de src/web/index.html dans un faux DOM minimal avec un `fetch`
// injecté. On vérifie qu'un 404 sur le suivi d'un job (job évincé) rend la page
// de nouveau utilisable au lieu de rester bloquée sur « Traitement… ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* ------------------------------------------------------------------ faux DOM */

type FakeEl = {
  id: string;
  hidden: boolean;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  open: boolean;
  innerHTML: string;
  style: Record<string, string>;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  setAttribute(): void;
  removeAttribute(): void;
  getAttribute(): string | null;
  addEventListener(type: string, fn: () => void): void;
  querySelector(): null;
  querySelectorAll(): never[];
  appendChild(): void;
  focus(): void;
  __on: Record<string, (() => void)[]>;
};

function makeEl(id: string): FakeEl {
  const on: Record<string, (() => void)[]> = {};
  return {
    id,
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    open: false,
    innerHTML: '',
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    setAttribute() {},
    removeAttribute() {},
    getAttribute: () => null,
    addEventListener(type, fn) {
      (on[type] ??= []).push(fn);
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    appendChild() {},
    focus() {},
    __on: on,
  };
}

type Ctx = {
  els: Map<string, FakeEl>;
  calls: { url: string; init?: { method?: string; body?: string } }[];
  document: unknown;
};

/** Évalue le script de la page et renvoie les éléments + appels `fetch`. */
function bootPage(): Ctx {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'la page doit contenir un <script>');

  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id)!;
  };

  const calls: Ctx['calls'] = [];
  const fetchImpl = async (url: string, init?: { method?: string; body?: string }) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u === '/local/media') return { ok: true, status: 200, json: async () => ({ dir: 'X', files: [] }) };
    if (u === '/local/history') return { ok: true, status: 200, json: async () => ({ items: [] }) };
    if (u === '/local/jobs' && init?.method === 'POST') return { ok: true, status: 202, json: async () => ({ jobId: 'evince-1' }) };
    if (u.startsWith('/local/jobs/')) return { ok: false, status: 404, json: async () => ({ error: 'job introuvable' }) };
    throw new Error('URL inattendue dans le test : ' + u);
  };

  const document = {
    getElementById: el,
    createElement: (tag: string) => makeEl(tag),
    body: makeEl('body'),
    execCommand: () => false,
  };

  const run = new Function(
    'document',
    'navigator',
    'window',
    'fetch',
    'Blob',
    'URL',
    'setTimeout',
    'clearTimeout',
    'console',
    script,
  );
  run(document, { clipboard: undefined }, {}, fetchImpl, Blob, URL, setTimeout, clearTimeout, console);

  return { els, calls, document };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

/* ---------------------------------------------------------------------- test */

test('un 404 pendant le suivi du job rend la page utilisable (pas de blocage)', async () => {
  const { els, calls } = bootPage();
  await settle(); // loadMedia + loadHistory

  els.get('manual-path')!.value = 'C:\\Vidéos\\clip final.mp4';
  const generate = els.get('generate')!;
  const click = generate.__on.click?.[0];
  assert.ok(click, 'le bouton « Générer les chapitres » doit être branché');
  click();

  await settle();

  // La demande de job a bien été envoyée (le test n'est pas vide).
  const post = calls.find((c) => c.url === '/local/jobs' && c.init?.method === 'POST');
  assert.ok(post, 'la demande de job doit partir');
  assert.equal(JSON.parse(post!.init!.body!).path, 'C:\\Vidéos\\clip final.mp4');
  assert.ok(calls.some((c) => c.url === '/local/jobs/evince-1'), 'le suivi du job doit être appelé');

  // Le job a disparu (404) : la page doit sortir de l'état « en cours ».
  assert.equal(els.get('error-box')!.hidden, false, "l'erreur doit être visible");
  assert.match(els.get('error-text')!.textContent, /plus disponible/);
  assert.match(els.get('error-text')!.textContent, /Relancez-le/);
  assert.equal(generate.disabled, false, 'le bouton doit redevenir utilisable');
  assert.equal(els.get('step-progress')!.hidden, true, 'la progression doit être masquée');
  assert.equal(els.get('cancel')!.hidden, true, 'le bouton Annuler doit être masqué');
});
