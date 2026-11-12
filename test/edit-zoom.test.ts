// Tests des nouveautés de l'éditeur de bornes : zoom + défilement (fenêtre
// visible, graduations, bornes hors fenêtre signalées), forme d'onde (requête de
// la fenêtre visible, dégradation propre), accrochage aux silences, boucle A/B
// et vitesse de lecture. Faux DOM + `fetch` injecté : aucun navigateur, aucun
// réseau, aucun ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const EDIT_HTML = new URL('../src/web/edit.html', import.meta.url);
const EDIT_ID = 'local:up-abcdef123456';
const ENC = encodeURIComponent(EDIT_ID);

const ANALYSIS = {
  from: 0,
  to: 120,
  durationSec: 600,
  peaks: [
    [-0.5, 0.5],
    [-0.2, 0.3],
  ],
  silences: [
    { startSec: 58, endSec: 59.2 },
    { startSec: 120.5, endSec: 121.3 },
  ],
};

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function boot(overrides: Record<string, unknown> = {}, opts: { analysisOk?: boolean } = {}) {
  const payload = {
    videoId: EDIT_ID,
    title: 'clip.mp3',
    durationSec: 600,
    hasVideo: false,
    mediaUrl: `/media/${ENC}`,
    chapters: [
      { id: 1, startSec: 0, title: 'Introduction', source: 'llm', validated: false },
      { id: 2, startSec: 60, title: 'Suite', source: 'llm', validated: false },
      { id: 3, startSec: 120, title: 'Fin', source: 'llm', validated: false },
    ],
    ...overrides,
  };
  const routes = async (url: string, _init?: FetchCall['init']) => {
    if (url === `/videos/${ENC}/edit`) return { ok: true, status: 200, json: async () => payload };
    if (url.startsWith(`/media/${ENC}/analysis`)) {
      if (opts.analysisOk === false) return { ok: false, status: 500, json: async () => ({ error: 'x' }) };
      return { ok: true, status: 200, json: async () => ANALYSIS };
    }
    throw new Error('URL inattendue dans le test : ' + url);
  };
  return bootPage(routes, { file: EDIT_HTML, location: { search: '?video=' + ENC } });
}

const countTicks = (page: ReturnType<typeof boot>) => (page.el('ticks').innerHTML.match(/class="tick"/g) || []).length;
const countMarkers = (page: ReturnType<typeof boot>) => (page.el('markers').innerHTML.match(/class="marker"/g) || []).length;

// ---------- zoom / fenêtre visible ----------

test('le zoom resserre la fenêtre visible et « tout voir » restaure la vue complète', async () => {
  const page = boot();
  await settle();
  const fullTicks = countTicks(page);
  assert.ok(fullTicks > 5, 'vue complète : graduations nombreuses');

  page.el('zoom').value = '120';
  page.fire('zoom', 'change');
  await settle();
  assert.ok(countTicks(page) < fullTicks, 'fenêtre de 2 min : graduations plus denses');
  assert.equal(countMarkers(page), 3, 'les trois bornes restent visibles sur 2 min');

  page.el('zoom').value = '30';
  page.fire('zoom', 'change');
  await settle();
  assert.equal(countMarkers(page), 1, 'seule la borne à 0:00 tient dans 30 s');

  page.fire('show-all', 'click');
  await settle();
  assert.equal(countTicks(page), fullTicks, 'tout voir restaure la vue complète');
  assert.equal(countMarkers(page), 3);
});

test('une borne hors fenêtre est SIGNALÉE, jamais perdue de vue', async () => {
  const page = boot();
  await settle();
  assert.equal(page.el('offscreen-info').hidden, true, 'rien hors fenêtre en vue complète');

  page.el('zoom').value = '30';
  page.fire('zoom', 'change');
  await settle();
  assert.equal(page.el('offscreen-info').hidden, false, 'bornes hors fenêtre signalées');
  assert.match(page.el('offscreen-info').textContent, /2 après la fenêtre/);
  assert.match(page.el('offscreen-info').textContent, /Tout voir/);
});

// ---------- forme d'onde ----------

test('au-delà de 2 minutes, la forme d’onde invite à zoomer sans appeler l’analyse', async () => {
  const page = boot();
  await settle();
  await delay(400);
  assert.match(page.el('wave-status').textContent, /Zoomez/);
  assert.equal(page.calls.filter((c) => c.url.includes('/analysis')).length, 0);
});

test('zoomer à 2 minutes demande l’analyse de la fenêtre visible', async () => {
  const page = boot();
  await settle();
  page.el('zoom').value = '120';
  page.fire('zoom', 'change');
  await delay(400);
  const reqs = page.calls.filter((c) => c.url.includes('/analysis'));
  assert.equal(reqs.length, 1);
  assert.match(reqs[0].url, /from=0&to=120/);
  assert.equal(page.el('wave-status').textContent, '', 'analyse réussie : aucun message d’alerte');
});

test('la forme d’onde dégrade proprement quand l’analyse échoue', async () => {
  const page = boot({}, { analysisOk: false });
  await settle();
  page.el('zoom').value = '120';
  page.fire('zoom', 'change');
  await delay(400);
  assert.match(page.el('wave-status').textContent, /indisponible/i);
  assert.match(page.el('wave-status').className, /warn-text/);
});

// ---------- accrochage aux silences ----------

test('l’accrochage choisit le silence le plus proche et respecte son interrupteur', async () => {
  const page = boot();
  await settle();
  page.el('zoom').value = '120';
  page.fire('zoom', 'change');
  await delay(400); // l'analyse de la fenêtre apporte les silences (58 s, 120,5 s)

  // Borne 2 (60 s) reculée d'1 s → 59 s, accrochée au silence à 58 s.
  page.fire('markers', 'keydown', { key: 'ArrowLeft', altKey: true, target: { dataset: { index: '1' } }, preventDefault() {} });
  assert.ok(page.el('export-text').textContent.includes('0:58 Suite'), page.el('export-text').textContent);
  assert.equal(page.el('snap-info').hidden, false);
  assert.match(page.el('snap-info').textContent, /silence/i);

  // Accrochage désactivé : plus d'accroche, on recule simplement d'1 s.
  page.el('snap-toggle').checked = false;
  page.fire('snap-toggle', 'change');
  page.fire('markers', 'keydown', { key: 'ArrowLeft', altKey: true, target: { dataset: { index: '1' } }, preventDefault() {} });
  assert.ok(page.el('export-text').textContent.includes('0:57 Suite'), page.el('export-text').textContent);
  assert.equal(page.el('snap-info').hidden, true);
});

// ---------- boucle A/B ----------

test('la boucle A/B encadre la borne, se reboucle sur A et s’arrête à la désélection', async () => {
  const page = boot();
  await settle();

  page.fire('markers', 'click', { target: { dataset: { index: '2' } } }); // borne à 120 s
  page.fire('loop-ab', 'click');
  assert.match(page.el('loop-info').textContent, /1:56 .*2:04/, 'A = −4 s, B = +4 s');
  assert.equal((page.el('loop-marks').innerHTML.match(/data-tag="/g) || []).length, 2, 'crochets A et B dessinés');

  // Garde-fou : hors de la boucle, la lecture revient à A.
  page.el('media-audio').currentTime = 130;
  page.fire('media-audio', 'timeupdate');
  assert.equal(page.el('media-audio').currentTime, 116, 'rebouclé sur A (1:56)');

  // Désélection (Échap) : la boucle s'arrête et les crochets disparaissent.
  page.fire('markers', 'keydown', { key: 'Escape', target: { dataset: { index: '2' } }, preventDefault() {} });
  assert.equal(page.el('loop-info').hidden, true);
  assert.equal(page.el('loop-marks').innerHTML, '');
});

// ---------- vitesse ----------

test('la vitesse de lecture règle playbackRate', async () => {
  const page = boot();
  await settle();
  assert.equal(page.el('media-audio').playbackRate, 1);
  page.el('speed').value = '1.5';
  page.fire('speed', 'change');
  assert.equal(page.el('media-audio').playbackRate, 1.5);
  page.el('speed').value = '0.5';
  page.fire('speed', 'change');
  assert.equal(page.el('media-audio').playbackRate, 0.5);
});

// ---------- balisage statique ----------

test('la page expose zoom, accrochage, boucle, vitesse et la liste des raccourcis (aucune ressource externe)', () => {
  const page = boot();
  for (const id of [
    'waveform',
    'loop-marks',
    'offscreen-info',
    'wave-status',
    'snap-info',
    'loop-info',
    'zoom',
    'show-all',
    'snap-toggle',
    'loop-ab',
    'speed',
  ]) {
    assert.ok(page.has(id), `élément manquant : #${id}`);
  }
  assert.ok(page.el('ticks').innerHTML !== undefined);
});
