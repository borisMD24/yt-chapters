// Correctif de revue — éditeur : la conversion position écran → temps doit
// suivre la FENÊTRE VISIBLE (et non la durée totale), le suivi automatique ne
// doit pas écraser un défilement manuel, et « L » doit marcher depuis un
// marqueur focalisé. Faux DOM + `fetch` injecté : aucun navigateur, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, type FetchCall, type Harness } from './web-harness.ts';

const EDIT_HTML = new URL('../src/web/edit.html', import.meta.url);
const EDIT_ID = 'local:up-abcdef123456';
const ENC = encodeURIComponent(EDIT_ID);

type Chapter = { id: number; startSec: number; title: string; source: string; validated: boolean };

const DEFAULT: Chapter[] = [
  { id: 1, startSec: 0, title: 'Introduction', source: 'llm', validated: false },
  { id: 2, startSec: 60, title: 'Suite', source: 'llm', validated: false },
  { id: 3, startSec: 120, title: 'Fin', source: 'llm', validated: false },
];

const FAR: Chapter[] = [
  { id: 1, startSec: 600, title: 'Alpha', source: 'llm', validated: false },
  { id: 2, startSec: 660, title: 'Beta', source: 'llm', validated: false },
  { id: 3, startSec: 900, title: 'Omega', source: 'llm', validated: false },
];

function boot(chapters: Chapter[], durationSec: number): Harness {
  const payload = { videoId: EDIT_ID, title: 'clip.mp3', durationSec, hasVideo: false, mediaUrl: `/media/${ENC}`, chapters };
  const routes = async (url: string, _init?: FetchCall['init']) => {
    if (url === `/videos/${ENC}/edit`) return { ok: true, status: 200, json: async () => payload };
    if (url.startsWith(`/media/${ENC}/analysis`)) return { ok: false, status: 500, json: async () => ({ error: 'x' }) };
    throw new Error('URL inattendue dans le test : ' + url);
  };
  return bootPage(routes, { file: EDIT_HTML, location: { search: '?video=' + ENC } });
}

/** Largeur de règle simulée (le faux DOM n’a pas de géométrie réelle). */
function setWidth(page: Harness, width: number): void {
  (page.el('timeline') as unknown as { clientWidth: number }).clientWidth = width;
}

function disableSnap(page: Harness): void {
  page.el('snap-toggle').checked = false;
  page.fire('snap-toggle', 'change');
}

function dragMarker(page: Harness, index: number, clientX: number): void {
  page.fire('markers', 'pointerdown', { clientX: 0, target: { dataset: { index: String(index) } }, preventDefault() {} });
  page.fire('timeline', 'pointermove', { clientX });
  page.fire('timeline', 'pointerup', {});
}

const exportText = (page: Harness) => page.el('export-text').textContent;

// ---------- 1. BLOQUANT : conversion inverse sous zoom ----------

test('glisser à mi-règle avec une fenêtre [0, 30] place la borne à 15 s (jamais sur la durée totale)', async () => {
  const page = boot(DEFAULT, 600);
  await settle();
  page.el('zoom').value = '30';
  page.fire('zoom', 'change');
  await settle();
  setWidth(page, 1000);
  disableSnap(page);

  dragMarker(page, 0, 500); // mi-règle
  assert.ok(exportText(page).includes('0:15 Introduction'), exportText(page));
  assert.ok(!exportText(page).includes('2:00 Introduction'), 'la valeur ne doit PAS être calculée sur la durée totale');
});

test('glisser à 25 % d’une fenêtre à début non nul (600 → 720) vise 10:30', async () => {
  const page = boot(FAR, 900);
  await settle();
  // Sélectionner la borne à 660 s : le zoom s’ancre dessus → fenêtre [600, 720].
  page.fire('markers', 'click', { target: { dataset: { index: '1' } } });
  page.el('media-audio').__on.pause[0](); // annule l’extrait de 8 s
  page.el('zoom').value = '120';
  page.fire('zoom', 'change');
  await settle();
  setWidth(page, 1000);
  disableSnap(page);

  dragMarker(page, 1, 250); // 25 % de la règle
  assert.ok(exportText(page).includes('10:30 Beta'), exportText(page));
  assert.ok(!exportText(page).includes('3:45 Beta'), 'pas de calcul sur la durée totale (900 s)');
});

test('un glisser hors des bords est borné aux extrémités de la fenêtre visible', async () => {
  const page = boot(DEFAULT, 600);
  await settle();
  page.el('zoom').value = '30';
  page.fire('zoom', 'change');
  await settle();
  setWidth(page, 1000);
  disableSnap(page);

  dragMarker(page, 0, -800);
  assert.ok(exportText(page).includes('0:00 Introduction'), exportText(page));
  dragMarker(page, 0, 5000);
  assert.ok(exportText(page).includes('0:30 Introduction'), exportText(page));
  // La borne reste dans la fenêtre visible : cohérente avec la position visée.
  assert.ok(!exportText(page).includes('10:00 Introduction'), exportText(page));
});

// ---------- 2. Le suivi automatique ne doit pas écraser un défilement manuel ----------

test('un défilement manuel en cours n’est pas écrasé par le suivi ; il reprend au relâchement', async () => {
  const page = boot(DEFAULT, 600);
  await settle();
  page.el('zoom').value = '30';
  page.fire('zoom', 'change');
  await settle();

  const audio = page.el('media-audio') as unknown as { paused: boolean; currentTime: number };
  audio.paused = false;
  audio.currentTime = 60; // hors fenêtre [0, 30]
  page.fire('media-audio', 'timeupdate');
  assert.ok(page.el('markers').innerHTML.includes('data-index="1"'), 'suivi actif : la borne à 1:00 est ramenée dans la fenêtre');

  // Défilement manuel en cours : le suivi doit se taire.
  page.fire('timeline', 'pointerdown', { clientX: 100, preventDefault() {} });
  audio.currentTime = 500;
  page.fire('media-audio', 'timeupdate');
  assert.ok(page.el('markers').innerHTML.includes('data-index="1"'), 'le défilement manuel n’est pas écrasé');

  // Relâchement : le suivi reprend.
  page.fire('timeline', 'pointerup', {});
  page.fire('media-audio', 'timeupdate');
  assert.ok(!page.el('markers').innerHTML.includes('data-index="1"'), 'au relâchement, le suivi recentre sur la lecture');
});

// ---------- 5. « L » depuis un marqueur focalisé ----------

test('la touche « L » démarre la boucle A/B depuis un marqueur focalisé', async () => {
  const page = boot(DEFAULT, 600);
  await settle();
  // Sélectionner la borne à 2:00 (comme un clic ou Entrée sur le marqueur).
  page.fire('markers', 'click', { target: { dataset: { index: '2' } } });
  page.el('media-audio').__on.pause[0](); // annule l’extrait de 8 s
  page.fire('markers', 'keydown', { key: 'L', target: { dataset: { index: '2' } }, preventDefault() {} });
  assert.equal(page.el('loop-info').hidden, false);
  assert.match(page.el('loop-info').textContent, /1:56/);
  assert.equal((page.el('loop-marks').innerHTML.match(/data-tag="/g) || []).length, 2);
});
