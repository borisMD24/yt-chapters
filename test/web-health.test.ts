// Tests de la page : bandeau de santé (ffmpeg/ffprobe manquants) affiché dès le
// chargement, et repli « Détails techniques » raccourci après un échec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

const html = readFileSync(new URL('../src/web/index.html', import.meta.url), 'utf8');

test('la page expose un bandeau de santé et un repli technique raccourci', () => {
  assert.match(html, /id="health-banner"/);
  assert.match(html, /id="health-text"/);
  assert.ok(html.includes('id="tech-error-text"'), 'le repli technique doit rester');
  assert.match(html, /Détail raccourci|raccourci volontairement|s'affiche dans la fenêtre du serveur/);
});

test('le bandeau signale ffmpeg introuvable au chargement', async () => {
  const routes = async (url: string) => {
    if (url === '/local/health') {
      return { ok: true, status: 200, json: async () => ({ ffmpeg: { ok: false }, ffprobe: { ok: true, version: '6.1.1' } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes);
  await settle();

  assert.ok(page.calls.some((c) => c.url === '/local/health'), 'la page doit interroger la santé au chargement');
  assert.equal(page.el('health-banner').hidden, false, 'le bandeau doit être visible');
  assert.match(page.el('health-text').textContent, /ffmpeg est introuvable sur cet ordinateur/);
  assert.match(page.el('health-text').textContent, /PATH/);
});

test('le bandeau reste masqué quand les outils sont disponibles', async () => {
  const routes = async (url: string) => {
    if (url === '/local/health') {
      return { ok: true, status: 200, json: async () => ({ ffmpeg: { ok: true, version: '6.1.1' }, ffprobe: { ok: true, version: '6.1.1' } }) };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes);
  await settle();
  assert.equal(page.el('health-banner').hidden, true);
});

test('après un échec de job : détail nettoyé affiché, santé re-vérifiée', async () => {
  let healthCalls = 0;
  const routes = async (url: string, init?: FetchCall['init']) => {
    if (url === '/local/health') {
      healthCalls++;
      return { ok: true, status: 200, json: async () => ({ ffmpeg: { ok: true }, ffprobe: { ok: true } }) };
    }
    if (url === '/local/jobs' && init?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ jobId: 'ko-1' }) };
    }
    if (url === '/local/jobs/ko-1') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'ko-1',
          status: 'error',
          phase: 'chunking',
          message: 'Ce fichier ne contient pas de piste audio.',
          error: 'ffmpeg exited with code 1: <chemin>: Output file does not contain any stream',
        }),
      };
    }
    throw new Error('URL inattendue : ' + url);
  };
  const page = bootPage(routes);
  await settle();
  const before = healthCalls;

  page.el('manual-path').value = 'C:\\media\\muet.mp4';
  page.fire('generate', 'click');
  await settle();

  assert.equal(page.el('error-box').hidden, false);
  assert.match(page.el('error-text').textContent, /piste audio/);
  assert.equal(page.el('tech-error').hidden, false, 'le repli technique doit rester disponible');
  assert.match(page.el('tech-error-text').textContent, /Output file does not contain any stream/);
  assert.ok(page.el('tech-fold').open, 'le repli doit être ouvert');
  assert.ok(healthCalls > before, 'la santé doit être re-vérifiée après un échec');
});
