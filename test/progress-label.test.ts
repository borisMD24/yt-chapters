// Intitulé de progression : le morceau affiché est celui EN COURS, en base 1
// (le premier morceau lit « 1 », le dernier « N »), et la barre ne se fige pas à
// 0 % pendant le premier morceau et n'atteint 100 % qu'à la fin.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRegistry, type JobPipeline } from '../src/jobs.ts';
import { bootPage, settle, type FetchCall } from './web-harness.ts';

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Registre avec un pipeline qui reste « en cours » (gate) après son signalement. */
function gatedRegistry(
  progress: { phase: 'chunking' | 'transcribing' | 'chaptering'; doneChunks: number; totalChunks: number },
) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (_i, { onProgress }) => {
    onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
    onProgress({ phase: 'chunking', doneChunks: progress.totalChunks, totalChunks: progress.totalChunks });
    onProgress(progress);
    await gate;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  return { registry: createJobRegistry(pipeline), release: () => release() };
}

test('l’intitulé nomme le premier morceau « morceau 1 sur 3 »', async () => {
  const { registry, release } = gatedRegistry({ phase: 'transcribing', doneChunks: 0, totalChunks: 3 });
  const job = registry.createJob({ path: 'a.mp3' });
  await until(() => registry.getJob(job.id)!.phase === 'transcribing');
  assert.equal(registry.getJob(job.id)!.message, 'Transcription du morceau 1 sur 3…');
  release();
  await until(() => registry.getJob(job.id)!.status === 'done');
});

test('l’intitulé nomme le dernier morceau « morceau 5 sur 5 »', async () => {
  const { registry, release } = gatedRegistry({ phase: 'transcribing', doneChunks: 5, totalChunks: 5 });
  const job = registry.createJob({ path: 'a.mp3' });
  await until(() => registry.getJob(job.id)!.phase === 'transcribing');
  assert.equal(registry.getJob(job.id)!.message, 'Transcription du morceau 5 sur 5…');
  release();
  await until(() => registry.getJob(job.id)!.status === 'done');
});

test('la page : barre indéterminée au premier morceau, 100 % seulement à la fin', async () => {
  let gets = 0;
  const jsonJob = (body: Record<string, unknown>) => ({ ok: true, status: 200, json: async () => body });
  const routes = async (url: string, init?: FetchCall['init']) => {
    if (url === '/local/jobs' && init?.method === 'POST') {
      return { ok: true, status: 202, json: async () => ({ jobId: 'p1' }) };
    }
    if (url === '/local/jobs/p1') {
      gets++;
      if (gets === 1) {
        return jsonJob({ id: 'p1', status: 'running', phase: 'transcribing', doneChunks: 0, totalChunks: 3, message: 'Transcription du morceau 1 sur 3…' });
      }
      if (gets === 2) {
        return jsonJob({ id: 'p1', status: 'running', phase: 'transcribing', doneChunks: 3, totalChunks: 3, message: 'Transcription du morceau 3 sur 3…' });
      }
      return jsonJob({
        id: 'p1',
        status: 'done',
        phase: 'done',
        doneChunks: 3,
        totalChunks: 3,
        message: 'Chapitres prêts.',
        result: { text: '0:00 Intro', warnings: [], transcript: [], chapters: [] },
      });
    }
    throw new Error('URL inattendue dans le test : ' + url);
  };

  const page = bootPage(routes);
  await settle();
  page.el('manual-path').value = 'C:\\medias\\clip.mp3';
  page.fire('generate', 'click');
  await settle();

  const fill = page.el('fill');
  // Premier morceau en cours : la barre reste indéterminée au lieu de se figer
  // à 0 % (aucune largeur peinte).
  assert.ok(!fill.style.width, `la barre ne doit pas être peinte à 0 % pendant le 1er morceau (reçu ${fill.style.width})`);
  assert.equal(page.el('status').textContent, 'Transcription du morceau 1 sur 3…');

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fill.style.width, '99%', 'dernier morceau terminé : jamais 100 % avant la fin');

  await new Promise((r) => setTimeout(r, 1200));
  assert.equal(fill.style.width, '100%', '100 % uniquement sur done');
  assert.equal(page.el('step-progress').hidden, true);
});
