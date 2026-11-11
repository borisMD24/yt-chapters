// Test comportemental du script de la page (sans navigateur, harnais partagé) :
// un 404 sur le suivi d'un job (job évincé) doit rendre la page de nouveau
// utilisable au lieu de rester bloquée sur « Traitement… ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const routes = async (url: string, init?: FetchCall['init']) => {
  if (url === '/local/jobs' && init?.method === 'POST') {
    return { ok: true, status: 202, json: async () => ({ jobId: 'evince-1' }) };
  }
  if (url.startsWith('/local/jobs/')) {
    return { ok: false, status: 404, json: async () => ({ error: 'job introuvable' }) };
  }
  throw new Error('URL inattendue dans le test : ' + url);
};

test('annulation : la page annonce « Annulation en cours… » puis attend l’état terminal', async () => {
  let gets = 0;
  const routes = async (url: string, init?: FetchCall['init']) => {
    const job = (status: string, message: string) => ({
      ok: true,
      status: 200,
      json: async () => ({ id: 'c1', status, phase: 'chunking', doneChunks: 1, totalChunks: 4, message }),
    });
    if (url === '/local/jobs' && init?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ jobId: 'c1' }) };
    }
    if (url === '/local/jobs/c1' && init?.method === 'DELETE') return job('cancelling', 'Annulation en cours…');
    if (url === '/local/jobs/c1') {
      gets++;
      return gets === 1 ? job('running', 'Transcription du morceau 1 sur 4…') : job('cancelled', 'Annulé.');
    }
    throw new Error('URL inattendue dans le test : ' + url);
  };

  const page = bootPage(routes);
  await settle();
  page.el('manual-path').value = 'C:\\m\\a.mp3';
  page.fire('generate', 'click');
  await settle();
  assert.equal(page.el('step-progress').hidden, false);

  page.fire('cancel', 'click');
  await settle();

  // L'arrêt n'est pas simulé : la progression reste affichée et le bouton
  // reste bloqué tant que le serveur n'a pas publié l'état terminal.
  assert.equal(page.el('status').textContent, 'Annulation en cours…');
  assert.equal(page.el('step-progress').hidden, false, 'la progression reste visible');
  assert.equal(page.el('generate').disabled, true, 'le bouton reste bloqué pendant l’annulation');
  assert.equal(page.el('cancel').disabled, true, 'le bouton Annuler ne peut pas être recliqué');

  // Le sondage suivant publie l'état terminal : la page redevient utilisable.
  await new Promise((r) => setTimeout(r, 1200));
  assert.ok(gets >= 2, 'le serveur doit continuer à être interrogé');
  assert.equal(page.el('status').textContent, '');
  assert.equal(page.el('step-progress').hidden, true, 'la progression disparaît après l’annulation');
  assert.equal(page.el('generate').disabled, false, 'la page redevient utilisable');
});

test('un 404 pendant le suivi du job rend la page utilisable (pas de blocage)', async () => {
  const page = bootPage(routes);
  await settle(); // loadMedia + loadHistory

  page.el('manual-path').value = 'C:\\Vidéos\\clip final.mp4';
  const generate = page.el('generate');
  page.fire('generate', 'click');

  await settle();

  // La demande de job a bien été envoyée (le test n'est pas vide).
  const post = page.calls.find((c) => c.url === '/local/jobs' && c.init?.method === 'POST');
  assert.ok(post, 'la demande de job doit partir');
  assert.equal(JSON.parse(String(post!.init!.body)).path, 'C:\\Vidéos\\clip final.mp4');
  assert.ok(page.calls.some((c) => c.url === '/local/jobs/evince-1'), 'le suivi du job doit être appelé');

  // Le job a disparu (404) : la page doit sortir de l'état « en cours ».
  assert.equal(page.el('error-box').hidden, false, "l'erreur doit être visible");
  assert.match(page.el('error-text').textContent, /plus disponible/);
  assert.match(page.el('error-text').textContent, /Relancez-le/);
  assert.equal(generate.disabled, false, 'le bouton doit redevenir utilisable');
  assert.equal(page.el('step-progress').hidden, true, 'la progression doit être masquée');
  assert.equal(page.el('cancel').hidden, true, 'le bouton Annuler doit être masqué');
});
