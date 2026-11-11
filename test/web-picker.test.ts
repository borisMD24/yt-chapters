// Tests du sélecteur de fichier (input + glisser-déposer) et de l'envoi :
// partie statique (le balisage et les libellés français) et partie
// comportementale (harnais de faux DOM + fetch injecté).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

test('la page expose un vrai champ fichier étiqueté et une zone de dépôt', () => {
  // Champ fichier : caché visuellement mais étiqueté par un <label for>.
  assert.match(html, /<input id="file-input"[^>]*type="file"/);
  assert.match(html, /<input id="file-input"[^>]*accept="audio\/\*,video\/\*"/);
  assert.match(html, /<label[^>]*for="file-input"[^>]*>\s*Choisir un fichier\s*<\/label>/);
  // Anneau de focus visible reporté sur le bouton quand le champ caché a le focus.
  assert.match(html, /#file-input:focus-visible \+ \.btn/);
  // Zone de dépôt : présente, nommée, et sans texte technique.
  assert.match(html, /<div id="dropzone"/);
  assert.match(html, /id="dropzone-title"/);
  assert.ok(html.includes('Glissez-déposez votre fichier ici'));
  assert.ok(html.includes('Formats acceptés'));
  // Le dossier MEDIA_DIR et le chemin manuel restent disponibles (secondaires).
  assert.ok(html.includes('Ou choisir un fichier déjà présent sur cet ordinateur'));
  assert.ok(html.includes('Ou saisir un chemin'));
  assert.ok(!/https?:\/\//.test(html), 'aucune ressource externe attendue');
});

const FAKE_FILE = { name: 'clip final.mp3', size: 2_500_000, type: 'audio/mpeg' };

const routes = async (url: string, init?: FetchCall['init']) => {
  if (url.startsWith('/local/jobs/upload')) {
    return { ok: true, status: 202, json: async () => ({ jobId: 'up-1' }) };
  }
  if (url === '/local/jobs/up-1') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        id: 'up-1',
        status: 'done',
        phase: 'done',
        doneChunks: 3,
        totalChunks: 3,
        message: 'Chapitres prêts.',
        result: { videoId: 'local:up-abcdef123456', chapters: [], text: '0:00 Intro\n3:00 Suite\n6:00 Fin', warnings: [], durationSec: 400 },
      }),
    };
  }
  throw new Error('URL inattendue dans le test : ' + url);
};

test('déposer un fichier puis générer envoie le fichier brut avec les bons en-têtes', async () => {
  const page = bootPage(routes);
  await settle();

  // La zone de dépôt doit avoir des handlers prévenant le comportement natif.
  assert.ok(page.el('dropzone').__on.dragover?.length, 'dragover doit être branché');
  assert.ok(page.el('dropzone').__on.drop?.length, 'drop doit être branché');
  let prevented = 0;
  const dragEvent = { preventDefault: () => prevented++, dataTransfer: { files: [FAKE_FILE] } };
  page.fire('dropzone', 'dragover', dragEvent);
  page.fire('dropzone', 'drop', dragEvent);
  assert.equal(prevented, 2, 'le comportement natif doit être empêché');
  assert.equal(page.el('upload-info').hidden, false, 'le fichier choisi doit être annoncé');
  assert.ok(page.el('upload-info').textContent.includes('clip final.mp3'));
  assert.ok(page.el('upload-info').textContent.includes('2,5 Mo'), page.el('upload-info').textContent);

  page.fire('generate', 'click');
  await settle();

  const upload = page.calls.find((c) => c.url.startsWith('/local/jobs/upload'));
  assert.ok(upload, "l'envoi doit viser /local/jobs/upload");
  assert.equal(upload!.init!.method, 'POST');
  assert.equal(upload!.init!.headers!['content-type'], 'application/octet-stream');
  assert.equal(upload!.init!.headers!['x-filename'], encodeURIComponent('clip final.mp3'));
  assert.equal(upload!.init!.body, FAKE_FILE, 'le fichier est envoyé brut, sans être recopié');
  // Les options avancées par défaut passent par la requête (pas le JSON).
  assert.match(upload!.url, /chunkSec=300/);
  assert.match(upload!.url, /lang=fr/);
  // Le suivi du job reprend ensuite le flux habituel.
  assert.ok(page.calls.some((c) => c.url === '/local/jobs/up-1'), 'le suivi doit démarrer');
  assert.equal(page.el('result-text').textContent, '0:00 Intro\n3:00 Suite\n6:00 Fin');
});

test('choisir un fichier remplace la source : un seul fichier sera traité', async () => {
  const page = bootPage(routes);
  await settle();

  // Chemin manuel, puis dépôt d'un fichier : le chemin doit être abandonné.
  page.el('manual-path').value = 'C:\\Vidéos\\reportage.mp4';
  page.fire('dropzone', 'drop', { preventDefault() {}, dataTransfer: { files: [FAKE_FILE] } });
  assert.equal(page.el('manual-path').value, '');
  assert.ok(page.el('chosen').textContent.includes('clip final.mp3'), page.el('chosen').textContent);
  assert.ok(!page.el('chosen').textContent.includes('reportage.mp4'));

  page.fire('generate', 'click');
  await settle();
  assert.ok(
    page.calls.some((c) => c.url.startsWith('/local/jobs/upload')),
    "l'envoi doit primer sur l'ancien chemin",
  );
  assert.ok(!page.calls.some((c) => c.url === '/local/jobs'), 'aucun job par chemin ne doit partir');
});

test("l'échec d'envoi reprend le style d'erreur et propose de réessayer", async () => {
  let attempts = 0;
  const failing = async (url: string) => {
    if (url.startsWith('/local/jobs/upload')) {
      attempts++;
      return { ok: false, status: 413, json: async () => ({ error: 'Ce fichier est trop volumineux (limite : 2048 Mo).' }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(failing);
  await settle();

  page.fire('dropzone', 'drop', { preventDefault() {}, dataTransfer: { files: [FAKE_FILE] } });
  page.fire('generate', 'click');
  await settle();

  assert.equal(page.el('error-box').hidden, false);
  assert.match(page.el('error-text').textContent, /trop volumineux/);
  assert.equal(page.el('generate').disabled, false, 'le bouton doit rester utilisable');
  assert.equal(page.el('step-progress').hidden, true);

  // Le bouton « Réessayer » relance l'envoi.
  page.fire('retry', 'click');
  await settle();
  assert.equal(attempts, 2, 'le second essai doit réellement renvoyer le fichier');
});

test('« Générer les chapitres » explique ce qui sera traité', async () => {
  const page = bootPage(routes);
  await settle();
  assert.match(page.el('chosen').textContent, /Aucun fichier choisi/);

  // Aucune source : message clair, aucune requête.
  const before = page.calls.length;
  page.fire('generate', 'click');
  await settle();
  assert.equal(page.calls.length, before, 'aucune requête sans fichier choisi');
  assert.match(page.el('error-text').textContent, /Choisissez d'abord un fichier/);
  assert.equal(page.el('generate').disabled, false);

  // Après un dépôt : la note annonce précisément ce qui sera traité.
  page.fire('dropzone', 'drop', { preventDefault() {}, dataTransfer: { files: [FAKE_FILE] } });
  assert.match(page.el('chosen').textContent, /^Fichier à envoyer : clip final\.mp3 \(2,5 Mo\)/);
});
