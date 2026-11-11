// Tests du registre de jobs en mémoire (pipeline injecté) : transitions de
// progression, succès, erreur (message en français, sans fuite de clé) et
// annulation, plus la sérialisation (un job à la fois).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJobRegistry, type JobPipeline } from '../src/jobs.ts';

const input = { path: 'C:\\media\\reportage.mp3' };

/** Attend qu'un prédicat devienne vrai (avec délai de garde). */
async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('createJob démarre en "queued" et le runner sérialise + progresse vers done', async () => {
  const events: string[] = [];
  const pipeline: JobPipeline = async (i, { onProgress }) => {
    assert.equal(i.path, input.path);
    onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
    events.push('chunking');
    onProgress({ phase: 'chunking', doneChunks: 3, totalChunks: 3 });
    onProgress({ phase: 'transcribing', doneChunks: 1, totalChunks: 3 });
    onProgress({ phase: 'transcribing', doneChunks: 3, totalChunks: 3 });
    onProgress({ phase: 'chaptering', doneChunks: 0, totalChunks: 0 });
    events.push('chaptering');
    onProgress({ phase: 'persisting', doneChunks: 0, totalChunks: 0 });
    return {
      videoId: 'local:abc',
      chapters: [{ startSec: 0, title: 'Intro' }],
      text: '0:00 Intro',
      warnings: [],
      durationSec: 120,
    };
  };

  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  assert.equal(job.status, 'queued');
  assert.equal(job.phase, 'chunking');
  assert.equal(job.message, 'En attente…');
  assert.ok(job.id.length > 0);

  await until(() => registry.getJob(job.id)!.status === 'done');
  const done = registry.getJob(job.id)!;
  assert.equal(done.phase, 'done');
  assert.equal(done.message, 'Chapitres prêts.');
  assert.deepEqual(events, ['chunking', 'chaptering']);
  assert.deepEqual(done.result?.chapters, [{ startSec: 0, title: 'Intro' }]);
  assert.equal(done.totalChunks, 3);
  assert.equal(done.error, undefined);
});

test('le message de progression décrit le morceau en cours (français)', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (_i, { onProgress }) => {
    onProgress({ phase: 'chunking', doneChunks: 5, totalChunks: 5 });
    onProgress({ phase: 'transcribing', doneChunks: 2, totalChunks: 5 });
    await gate;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.doneChunks === 2);
  assert.equal(registry.getJob(job.id)!.message, 'Transcription du morceau 2 sur 5…');
  release();
  await until(() => registry.getJob(job.id)!.status === 'done');
});

test('une erreur du pipeline donne status error + message clair, sans fuite de clé', async () => {
  process.env.OPENROUTER_API_KEY = 'sk-or-secretvalue123';
  const pipeline: JobPipeline = async () => {
    throw new Error('ffmpeg a échoué: sk-or-secretvalue123 inaccessible');
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.status === 'error');
  const err = registry.getJob(job.id)!;
  assert.match(err.message, /Impossible de lire ce fichier/);
  assert.ok(!JSON.stringify(err).includes('sk-or-secretvalue123'), 'la clé ne doit pas fuiter');
  assert.ok(!err.result);
  assert.ok(err.error && err.error.length > 0);
});

test('cancelJob annule un job en cours (status cancelled, pipeline interrompu)', async () => {
  const pipeline: JobPipeline = async (_i, { signal }) => {
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(resolve, 5000);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('interrompu'));
      });
    });
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob(input);
  await until(() => registry.getJob(job.id)!.status === 'running');
  registry.cancelJob(job.id);
  await until(() => registry.getJob(job.id)!.status === 'cancelled');
  const cancelled = registry.getJob(job.id)!;
  assert.equal(cancelled.message, 'Annulé.');
  assert.equal(cancelled.error, undefined);
});

test('cancelJob sur un job en attente l\'empêche de démarrer', async () => {
  const started: string[] = [];
  const pipeline: JobPipeline = async (i) => {
    started.push(i.path);
    await new Promise((r) => setTimeout(r, 30));
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const first = registry.createJob({ path: 'first.mp3' });
  const second = registry.createJob({ path: 'second.mp3' });
  await until(() => registry.getJob(first.id)!.status === 'running');
  registry.cancelJob(second.id);
  await until(() => registry.getJob(first.id)!.status === 'done');
  assert.equal(registry.getJob(second.id)!.status, 'cancelled');
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(started, ['first.mp3'], 'le job annulé ne doit pas s\'exécuter');
});

test('les jobs sont séquentiels (jamais deux pipelines en parallèle)', async () => {
  let running = 0;
  let maxConcurrent = 0;
  const pipeline: JobPipeline = async () => {
    running += 1;
    maxConcurrent = Math.max(maxConcurrent, running);
    await new Promise((r) => setTimeout(r, 20));
    running -= 1;
    return { videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 };
  };
  const registry = createJobRegistry(pipeline);
  const a = registry.createJob({ path: 'a.mp3' });
  const b = registry.createJob({ path: 'b.mp3' });
  await until(() => registry.getJob(a.id)!.status === 'done' && registry.getJob(b.id)!.status === 'done');
  assert.equal(maxConcurrent, 1);
});

test('getJob renvoie undefined pour un identifiant inconnu', () => {
  const registry = createJobRegistry(async () => ({ videoId: 'x', chapters: [], text: '', warnings: [], durationSec: 1 }));
  assert.equal(registry.getJob('inexistant'), undefined);
  assert.equal(registry.cancelJob('inexistant'), undefined);
});
