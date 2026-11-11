// Harnais de test partagé : évalue le <script> de src/web/index.html dans un
// faux DOM minimal avec un `fetch` injecté. Sert aux tests de la page sans
// navigateur (aucune dépendance ajoutée).
//
// Les URL `/local/media` et `/local/history` sont servies par le harnais ;
// tout le reste est délégué à l'implémentation `fetch` fournie par le test.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

export type FakeEl = {
  id: string;
  hidden: boolean;
  textContent: string;
  value: string;
  checked: boolean;
  disabled: boolean;
  open: boolean;
  innerHTML: string;
  files: unknown[];
  style: Record<string, string>;
  classList: { add(): void; remove(): void; toggle(): void; contains(): boolean };
  setAttribute(): void;
  removeAttribute(): void;
  getAttribute(): string | null;
  addEventListener(type: string, fn: (ev?: unknown) => void): void;
  querySelector(): null;
  querySelectorAll(): never[];
  appendChild(): void;
  focus(): void;
  __on: Record<string, ((ev?: unknown) => void)[]>;
};

export type FetchCall = {
  url: string;
  init?: { method?: string; body?: unknown; headers?: Record<string, string> };
};

export type Harness = {
  els: Map<string, FakeEl>;
  calls: FetchCall[];
  has(id: string): boolean;
  el(id: string): FakeEl;
  /** Déclenche le premier handler enregistré pour cet élément/événement. */
  fire(id: string, type: string, event?: unknown): void;
};

function makeEl(id: string): FakeEl {
  const on: Record<string, ((ev?: unknown) => void)[]> = {};
  return {
    id,
    hidden: false,
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    open: false,
    innerHTML: '',
    files: [],
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

/**
 * `routes` reçoit les URL non internes au harnais et doit renvoyer un objet
 * de type `Response` ({ ok, status, json() }).
 */
export function bootPage(
  routes: (url: string, init?: FetchCall['init']) => Promise<unknown> = async () => ({
    ok: true,
    status: 200,
    json: async () => ({}),
  }),
): Harness {
  const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)?.[1];
  assert.ok(script, 'la page doit contenir un <script>');

  const els = new Map<string, FakeEl>();
  const el = (id: string): FakeEl => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id)!;
  };

  const calls: FetchCall[] = [];
  const fetchImpl = async (url: string, init?: FetchCall['init']) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === '/local/media') return { ok: true, status: 200, json: async () => ({ dir: 'X', files: [] }) };
    if (u === '/local/history') return { ok: true, status: 200, json: async () => ({ items: [] }) };
    return routes(u, init);
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

  return {
    els,
    calls,
    has: (id) => els.has(id),
    el,
    fire: (id, type, event) => {
      const handler = els.get(id)?.__on[type]?.[0];
      assert.ok(handler, `aucun handler ${type} branché sur #${id}`);
      handler(event);
    },
  };
}

/** Laisse se vider la file de micro-tâches et les promesses déjà résolues. */
export const settle = () => new Promise((r) => setTimeout(r, 20));
