// Tests du diagnostic serveur des échecs de job :
//  - la trace BRUTE (avec chemins) part vers le logger injecté, jamais au client ;
//  - le détail visible par le navigateur reste nettoyé ET tronqué.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createJobRegistry,
  MAX_TECHNICAL_DETAIL,
  sanitizeErrorMessage,
  type JobFailure,
  type JobPipeline,
} from '../src/jobs.ts';

async function until(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const RAW =
  'ffmpeg exited with code 1: C:\\Users\\boris\\Vidéos\\reportage final.mp4: ' +
  'Output file does not contain any stream (' +
  'sk-or-v1-abcdef1234567890 '.repeat(30) +
  ')';

test('un échec de job alimente le logger injecté avec l’erreur BRUTE, l’id, la phase et la durée', async () => {
  const seen: JobFailure[] = [];
  const raw = new Error(RAW);
  const pipeline: JobPipeline = async (_i, { onProgress }) => {
    onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 0 });
    throw raw;
  };

  const registry = createJobRegistry(pipeline, { logger: (f) => seen.push(f) });
  const job = registry.createJob({ path: 'C:\\media\\clip.mp4' });
  await until(() => registry.getJob(job.id)!.status === 'error');

  assert.equal(seen.length, 1, 'un échec = une trace serveur');
  const trace = seen[0];
  assert.equal(trace.jobId, job.id);
  assert.equal(trace.phase, 'chunking');
  assert.equal(trace.error, raw, 'le logger reçoit l’erreur d’origine, non nettoyée');
  assert.ok(String((trace.error as Error).message).includes('C:\\Users\\boris'), 'chemin brut conservé côté serveur');
  assert.ok(typeof trace.elapsedMs === 'number' && trace.elapsedMs >= 0);
});

test('la phase transmise au logger est celle de l’échec (transcribing)', async () => {
  const seen: JobFailure[] = [];
  const pipeline: JobPipeline = async (_i, { onProgress }) => {
    onProgress({ phase: 'chunking', doneChunks: 0, totalChunks: 4 });
    onProgress({ phase: 'transcribing', doneChunks: 2, totalChunks: 4 });
    throw new Error('réseau indisponible');
  };
  const registry = createJobRegistry(pipeline, { logger: (f) => seen.push(f) });
  const job = registry.createJob({ path: 'a.mp4' });
  await until(() => registry.getJob(job.id)!.status === 'error');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].phase, 'transcribing');
});

test('le détail visible par le navigateur est nettoyé ET tronqué, jamais la commande entière', async () => {
  const pipeline: JobPipeline = async () => {
    throw new Error(RAW);
  };
  const registry = createJobRegistry(pipeline, { logger: () => {} });
  const job = registry.createJob({ path: 'a.mp4' });
  await until(() => registry.getJob(job.id)!.status === 'error');
  const visible = registry.getJob(job.id)!.error!;

  assert.ok(visible.length <= MAX_TECHNICAL_DETAIL, `détail trop long : ${visible.length}`);
  assert.ok(!visible.includes('C:\\Users'), 'aucun chemin absolu ne doit atteindre la page');
  assert.ok(!visible.includes('sk-or-v1-abcdef'), 'aucune clé ne doit atteindre la page');
});

test('ni un succès ni une annulation n’écrivent de trace d’échec', async () => {
  const seen: JobFailure[] = [];
  const done: Awaited<ReturnType<JobPipeline>> = {
    videoId: 'x',
    chapters: [],
    text: '',
    warnings: [],
    durationSec: 1,
  };
  const pipeline: JobPipeline = async (input, { signal }) => {
    if (input.path === 'ko.mp4') throw new Error('échec franc');
    if (input.path === 'annule.mp4') {
      await new Promise<void>((_res, reject) => {
        signal.addEventListener('abort', () => reject(new Error('interrompu')));
      });
    }
    return done;
  };
  const registry = createJobRegistry(pipeline, { logger: (f) => seen.push(f) });

  const ok = registry.createJob({ path: 'ok.mp4' });
  await until(() => registry.getJob(ok.id)!.status === 'done');

  const cancelling = registry.createJob({ path: 'annule.mp4' });
  await until(() => registry.getJob(cancelling.id)!.status === 'running');
  registry.cancelJob(cancelling.id);
  await until(() => registry.getJob(cancelling.id)!.status === 'cancelled');
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(seen, [], 'succès et annulation ne sont pas des échecs');

  const failing = registry.createJob({ path: 'ko.mp4' });
  await until(() => registry.getJob(failing.id)!.status === 'error');
  assert.equal(seen.length, 1, 'le logger fonctionne bien dans ce même registre');
});

test('sanitizeErrorMessage tronque à MAX_TECHNICAL_DETAIL caractères', () => {
  const veryLong = 'x'.repeat(2000);
  assert.equal(sanitizeErrorMessage(veryLong).length, MAX_TECHNICAL_DETAIL);
  assert.ok(MAX_TECHNICAL_DETAIL >= 400 && MAX_TECHNICAL_DETAIL <= 600, 'plafond attendu entre 400 et 600');
});
