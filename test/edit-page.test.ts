// Tests de la page `/edit` : balisage (chronologie, actions de déplacement,
// alternative textuelle) et comportement (rendu des bornes, mise à jour du texte
// d'export, avertissements de règles, et enregistrement via les routes
// existantes). Faux DOM + `fetch` injecté : aucun navigateur, aucun réseau.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const EDIT_HTML = new URL('../src/web/edit.html', import.meta.url);
const html = readFileSync(EDIT_HTML, 'utf8');

const EDIT_ID = 'local:up-abcdef123456';
const ENC = encodeURIComponent(EDIT_ID);

const AUDIO_PAYLOAD = {
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
};

function boot(overrides: Record<string, unknown> = {}) {
  const payload = { ...AUDIO_PAYLOAD, ...overrides };
  const routes = async (url: string, init?: FetchCall['init']) => {
    if (url === `/videos/${ENC}/edit`) return { ok: true, status: 200, json: async () => payload };
    if (url === `/videos/${ENC}/chapters` && init?.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 99 }) };
    if (url.startsWith('/chapters/')) return { ok: true, status: 200, json: async () => ({}) };
    throw new Error('URL inattendue dans le test : ' + url);
  };
  return bootPage(routes, { file: EDIT_HTML, location: { search: '?video=' + ENC } });
}

const countMarkers = (markup: string) => (markup.match(/class="marker"/g) || []).length;

// ---------- balisage (statique) ----------

test('la page expose le média, la chronologie et ses commandes en français', () => {
  for (const id of [
    'media-video',
    'media-audio',
    'timeline',
    'ticks',
    'markers',
    'playhead',
    'selected-info',
    'preview-play',
    'nudge-back-1',
    'nudge-fwd-1',
    'nudge-back-5',
    'nudge-fwd-5',
    'set-boundary',
    'add-chapter',
    'chapter-list',
    'save-all',
    'warnings',
    'warnings-list',
    'export-text',
    'copy',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `élément manquant : #${id}`);
  }
  assert.ok(html.includes('Définir la borne ici'), 'action « Définir la borne ici »');
  assert.ok(html.includes('Ajouter un chapitre ici'));
  assert.ok(html.includes('− 5 s') && html.includes('+ 5 s'));
  assert.ok(html.includes('Copier pour YouTube'));
  assert.ok(html.includes('Enregistrer les modifications'));
  // Aide clavier exigée (alternative à la souris).
  assert.match(html, /Tabulation/);
  assert.match(html, /Flèches/);
  assert.match(html, /Échap/);
  // Mise en page étroite : 380 px reste utilisable.
  assert.match(html, /@media \(max-width: 420px\)/);
  assert.match(html, /<meta name="viewport"/);
  // Aucune ressource externe.
  assert.ok(!/https?:\/\//.test(html), 'aucune ressource externe attendue');
});

// ---------- comportement ----------

test('une borne par chapitre est rendue, avec la liste comme équivalent textuel', async () => {
  const page = boot();
  await settle();

  assert.equal(page.el('markers').innerHTML.match(/data-index="/g)?.length, 3, 'trois bornes');
  assert.equal(countMarkers(page.el('markers').innerHTML), 3);
  assert.equal((page.el('chapter-list').innerHTML.match(/data-field="time"/g) || []).length, 3);
  assert.equal((page.el('chapter-list').innerHTML.match(/data-field="title"/g) || []).length, 3);
  assert.ok(page.el('ticks').innerHTML.includes('10:00'), 'échelle lisible sur 10 minutes');
  assert.equal(page.el('export-text').textContent, '0:00 Introduction\n1:00 Suite\n2:00 Fin');
  assert.equal(page.el('warnings').hidden, true, 'aucune alerte quand les règles sont respectées');
  assert.equal(page.el('load-error').hidden, true);
});

test('le lecteur choisi suit hasVideo (audio seul → <audio>, sinon <video>)', async () => {
  const audio = boot();
  await settle();
  assert.equal(audio.el('media-audio').hidden, false);
  assert.equal(audio.el('media-video').hidden, true);
  assert.equal(audio.el('media-audio').src, `/media/${ENC}`);

  const video = boot({ hasVideo: true, mediaUrl: `/media/${ENC}` });
  await settle();
  assert.equal(video.el('media-video').hidden, false);
  assert.equal(video.el('media-audio').hidden, true);
  assert.equal(video.el('media-video').src, `/media/${ENC}`);
});

test('sans média disponible, la page l’explique et reste utilisable', async () => {
  const page = boot({ mediaUrl: null, hasVideo: false });
  await settle();
  assert.equal(page.el('media-warn').hidden, false);
  assert.match(page.el('media-warn-text').textContent, /plus disponible/);
  assert.equal(page.el('export-text').textContent, '0:00 Introduction\n1:00 Suite\n2:00 Fin');
});

test('les quatre boutons de déplacement et la borne-au-lecteur sont branchés', async () => {
  const page = boot();
  await settle();
  for (const id of ['nudge-back-1', 'nudge-fwd-1', 'nudge-back-5', 'nudge-fwd-5', 'set-boundary', 'add-chapter']) {
    assert.ok(page.el(id).__on.click?.length, `#${id} doit avoir un gestionnaire de clic`);
  }
});

test('cliquer une borne sélectionne, cherche la position et met le texte d’export à jour', async () => {
  const page = boot();
  await settle();

  page.fire('markers', 'click', { target: { dataset: { index: '2' } } });
  assert.equal(page.el('media-audio').currentTime, 120, 'la lecture se place sur la borne');
  assert.match(page.el('selected-info').textContent, /3 — 2:00/);
  // On arrête l'extrait : sinon une minuterie de 8 s garde la boucle ouverte.
  page.el('media-audio').__on.pause[0]();
});

test('les flèches déplacent la borne sélectionnée (1 s, 5 s avec Maj)', async () => {
  const page = boot();
  await settle();

  const ev = { key: 'ArrowRight', target: { dataset: { index: '0' } }, preventDefault() {} };
  page.fire('markers', 'keydown', ev);
  assert.equal(page.el('export-text').textContent, '0:01 Introduction\n1:00 Suite\n2:00 Fin');

  page.fire('markers', 'keydown', { key: 'ArrowLeft', shiftKey: true, target: { dataset: { index: '2' } }, preventDefault() {} });
  assert.equal(page.el('export-text').textContent, '0:01 Introduction\n1:00 Suite\n1:55 Fin');

  // Échap désélectionne.
  page.fire('markers', 'keydown', { key: 'Escape', target: { dataset: { index: '1' } }, preventDefault() {} });
  assert.match(page.el('selected-info').textContent, /Aucune borne sélectionnée/);
});

test('« Définir la borne ici » règle la borne sur la position de lecture', async () => {
  const page = boot();
  await settle();
  page.el('media-audio').currentTime = 300;
  page.fire('set-boundary', 'click');
  // La borne sélectionnée (la première) passe à 5:00 ; le texte est trié.
  assert.equal(page.el('export-text').textContent, '1:00 Suite\n2:00 Fin\n5:00 Introduction');
  assert.match(page.el('selected-info').textContent, /5:00/);
});

test('le playhead suit la lecture', async () => {
  const page = boot();
  await settle();
  page.el('media-audio').currentTime = 300;
  page.fire('media-audio', 'timeupdate');
  assert.equal(page.el('playhead').style.left, '50.000%');
});

test('le texte d’export suit une saisie de titre et d’horodatage', async () => {
  const page = boot();
  await settle();

  page.fire('chapter-list', 'input', { target: { dataset: { index: '1', field: 'title' }, value: 'Partie 2' } });
  assert.ok(page.el('export-text').textContent.includes('1:00 Partie 2'), page.el('export-text').textContent);

  page.fire('chapter-list', 'input', { target: { dataset: { index: '2', field: 'time' }, value: '1:05' } });
  assert.ok(page.el('export-text').textContent.includes('1:05 Fin'));
});

test('les règles cassées affichent un avertissement NON bloquant', async () => {
  const page = boot();
  await settle();

  // Deux chapitres à moins de 10 s.
  page.fire('chapter-list', 'input', { target: { dataset: { index: '2', field: 'time' }, value: '1:05' } });
  assert.equal(page.el('warnings').hidden, false);
  assert.match(page.el('warnings-list').innerHTML, /moins de 10 s/);

  // Premier chapitre décalé.
  page.fire('chapter-list', 'input', { target: { dataset: { index: '0', field: 'time' }, value: '0:05' } });
  assert.match(page.el('warnings-list').innerHTML, /ne commence pas à 0:00/);

  // Corrigé : l'avertissement disparaît.
  page.fire('chapter-list', 'input', { target: { dataset: { index: '0', field: 'time' }, value: '0:00' } });
  page.fire('chapter-list', 'input', { target: { dataset: { index: '2', field: 'time' }, value: '2:00' } });
  assert.equal(page.el('warnings').hidden, true);
});

test('enregistrer appelle PATCH pour un chapitre modifié, POST pour un ajout, DELETE pour une suppression', async () => {
  const page = boot();
  await settle();

  // 1) modifier le titre du chapitre 2 et l'horodatage du chapitre 3
  page.fire('chapter-list', 'input', { target: { dataset: { index: '1', field: 'title' }, value: 'Partie 2' } });
  page.fire('chapter-list', 'input', { target: { dataset: { index: '2', field: 'time' }, value: '1:05' } });
  // 2) ajouter un chapitre
  page.fire('add-chapter', 'click');
  // 3) supprimer le chapitre 1
  page.fire('chapter-list', 'click', { target: { classList: { contains: (c: string) => c === 'del' }, dataset: { index: '0' } } });

  page.fire('save-all', 'click');
  await settle();

  const calls = page.calls;
  const patches = calls.filter((c) => c.init?.method === 'PATCH');
  const posts = calls.filter((c) => c.url === `/videos/${ENC}/chapters` && c.init?.method === 'POST');
  const deletes = calls.filter((c) => c.init?.method === 'DELETE');

  assert.deepEqual(
    patches.map((c) => c.url).sort(),
    ['/chapters/2', '/chapters/3'],
    'chapitres modifiés uniquement',
  );
  const byUrl = Object.fromEntries(patches.map((c) => [c.url, JSON.parse(String(c.init!.body))]));
  assert.deepEqual(byUrl['/chapters/2'], { startSec: 60, title: 'Partie 2' });
  assert.deepEqual(byUrl['/chapters/3'], { startSec: 65, title: 'Fin' });
  assert.equal(posts.length, 1, 'un POST pour le nouveau chapitre');
  assert.deepEqual(JSON.parse(String(posts[0].init!.body)), { startSec: 0, title: 'Nouveau chapitre' });
  assert.deepEqual(deletes.map((c) => c.url), ['/chapters/1']);
  assert.match(page.el('status').textContent, /enregistrées/i);
});

test('un identifiant absent de l’adresse est expliqué en français', async () => {
  const page = bootPage(async () => ({ ok: true, status: 200, json: async () => ({}) }), { file: EDIT_HTML, location: { search: '' } });
  await settle();
  assert.equal(page.el('load-error').hidden, false);
  assert.match(page.el('load-error-text').textContent, /Aucun chapitrage/);
});
