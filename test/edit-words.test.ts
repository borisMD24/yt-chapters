// Tests du panneau « Texte autour de la borne » de `/edit` : affichage du texte
// de la fenêtre, mise en évidence du mot de la borne, rafraîchissement après
// déplacement, et état dégradé honnête quand le média n'a pas de mots.
// Faux DOM + `fetch` injecté : aucun navigateur, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const EDIT_HTML = new URL('../src/web/edit.html', import.meta.url);
const html = readFileSync(EDIT_HTML, 'utf8');

const EDIT_ID = 'local:up-wordsabcdef';
const ENC = encodeURIComponent(EDIT_ID);

const WORDS = [
  { startSec: 58, endSec: 58.4, word: 'un' },
  { startSec: 59.5, endSec: 60.3, word: 'borne' },
  { startSec: 60.5, endSec: 61.5, word: 'deux' },
];

const EMPTY_MESSAGE =
  "Aucun texte enregistré pour ce média (chapitré avant cette version) — relancez un chapitrage pour l'obtenir.";

function boot(overrides: Record<string, unknown> = {}, words = WORDS) {
  const payload = {
    videoId: EDIT_ID,
    title: 'clip.mp3',
    durationSec: 600,
    hasVideo: false,
    hasWords: true,
    mediaUrl: `/media/${ENC}`,
    chapters: [
      { id: 1, startSec: 60, title: 'Introduction', source: 'llm', validated: false },
      { id: 2, startSec: 300, title: 'Suite', source: 'llm', validated: false },
    ],
    ...overrides,
  };
  const routes = async (url: string, _init?: FetchCall['init']) => {
    if (url === `/videos/${ENC}/edit`) return { ok: true, status: 200, json: async () => payload };
    if (url.startsWith(`/videos/${ENC}/words?`)) return { ok: true, status: 200, json: async () => ({ from: 0, to: 0, truncated: false, words }) };
    throw new Error('URL inattendue dans le test : ' + url);
  };
  return bootPage(routes, { file: EDIT_HTML, location: { search: '?video=' + ENC } });
}

/** Attend la fin de l'anti-rebond du panneau (150 ms) et des promesses. */
const wait = (ms = 260) => new Promise((r) => setTimeout(r, ms));

const wordsCalls = (page: ReturnType<typeof boot>) =>
  page.calls.filter((c) => c.url.startsWith(`/videos/${ENC}/words?`));
const currentWord = (markup: string) => /<span class="word word-current">([^<]*)<\/span>/.exec(markup)?.[1] ?? null;

// ---------- balisage ----------

test('la page expose le panneau « Texte autour de la borne »', () => {
  for (const id of ['words-panel', 'words-status', 'words-context']) {
    assert.match(html, new RegExp(`id="${id}"`), `élément manquant : #${id}`);
  }
  assert.ok(html.includes('Texte autour de la borne'));
});

// ---------- comportement ----------

test('le panneau affiche le texte de la fenêtre et met en évidence le mot de la borne', async () => {
  const page = boot();
  await wait();

  const markup = page.el('words-context').innerHTML;
  for (const w of ['un', 'borne', 'deux']) assert.ok(markup.includes('>' + w + '</span>'), `mot « ${w} » affiché`);
  assert.equal(currentWord(markup), 'borne', 'le mot contenant la borne (60 s) est mis en évidence');

  // La fenêtre demandée couvre −15 s / +15 s autour de la borne (60 → 45..75).
  const call = wordsCalls(page)[0];
  assert.ok(call, 'une requête de mots a été émise');
  assert.match(call.url, /from=45&to=75$/);
});

test('le panneau se rafraîchit après un déplacement (anti-rebond annulé)', async () => {
  const page = boot();
  await wait();
  const before = wordsCalls(page).length;

  page.fire('nudge-fwd-1', 'click'); // borne 60 → 61
  await wait();

  const calls = wordsCalls(page);
  assert.ok(calls.length > before, 'une nouvelle requête a suivi le déplacement');
  const last = calls[calls.length - 1];
  assert.match(last.url, /from=46&to=76$/, 'fenêtre recalculée autour de la nouvelle borne');
  assert.equal(currentWord(page.el('words-context').innerHTML), 'deux', 'le mot de la nouvelle borne est mis en évidence');
});

test('la fenêtre est bornée quand elle dépasse le début ou la fin du média', async () => {
  // Borne à 5 s : le début ne descend pas sous 0.
  const start = boot({ chapters: [{ id: 1, startSec: 5, title: 'Début', source: 'llm', validated: false }] });
  await wait();
  assert.match(wordsCalls(start)[0].url, /from=0&to=20$/);

  // Borne à 598 s : la fin ne dépasse pas la durée connue (600 s).
  const end = boot({ chapters: [{ id: 1, startSec: 598, title: 'Fin', source: 'llm', validated: false }] });
  await wait();
  assert.match(wordsCalls(end)[0].url, /from=583&to=600$/);
});

test('sans mots, le panneau affiche le message dégradé honnête', async () => {
  const page = boot({ hasWords: false });
  await wait();
  assert.equal(page.el('words-status').textContent, EMPTY_MESSAGE);
  assert.equal(wordsCalls(page).length, 0, 'aucune requête de mots inutile');
  assert.equal(page.el('words-context').innerHTML, '');
});

test('un média sans borne sélectionnée explique quoi faire', async () => {
  const page = boot({ chapters: [] });
  await wait();
  assert.match(page.el('words-status').textContent, /Sélectionnez une borne/);
});
