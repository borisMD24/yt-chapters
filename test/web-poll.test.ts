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
