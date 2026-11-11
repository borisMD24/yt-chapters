// Garde-fous demandés par la revue finale :
//  - `makeCleanup` ne doit pas être empoisonné par un jet synchrone ;
//  - le balayage doit tenir compte des écritures dans les fichiers existants ;
//  - la table des nettoyages doit être purgée avec les jobs évincés.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobRegistry, type JobPipeline } from '../src/jobs.ts';
import { UPLOAD_DIR_PREFIX, sweepStaleUploads } from '../src/upload.ts';

// Dossier temporaire privé (os.tmpdir() relit TEMP/TMP à chaque appel).
const privateRoot = mkdtempSync(join(tmpdir(), 'ckr-guard-files-'));
process.env.TEMP = privateRoot;
process.env.TMP = privateRoot;
process.env.TMPDIR = privateRoot;
const testTmp = tmpdir();

async function until(pred: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

const done: Awaited<ReturnType<JobPipeline>> = {
  videoId: 'v',
  chapters: [],
  text: '',
  warnings: [],
  durationSec: 1,
};

test('un finaliseur qui jette SYNCHRONEMENT la première fois est bien relancé', async () => {
  const dir = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  writeFileSync(join(dir, 'clip.mp3'), 'x');

  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (input) => {
    if (input.path === 'bloque.mp3') await blocker;
    return done;
  };

  const registry = createJobRegistry(pipeline);
  const running = registry.createJob({ path: 'bloque.mp3' });
  await until(() => registry.getJob(running.id)!.status === 'running');

  let calls = 0;
  const queued = registry.createJob({
    path: 'en-attente.mp3',
    onFinished: () => {
      calls++;
      if (calls === 1) throw new Error('échec synchrone'); // jet AVANT tout await
      rmSync(dir, { recursive: true, force: true });
    },
  });

  // 1re tentative : nettoyage appelé, échec synchrone, fichier toujours là.
  registry.cancelJob(queued.id);
  await until(() => registry.getJob(queued.id)!.status === 'cancelled');
  assert.equal(calls, 1, 'le nettoyage a été tenté une fois');
  assert.ok(existsSync(dir), 'le fichier est encore là après l’échec du premier nettoyage');

  // 2e tentative : la file avance, run() rappelle le nettoyage -> il doit
  // VRAIMENT s'exécuter (et non être bloqué par une garde empoisonnée).
  release();
  await until(() => existsSync(dir) === false, 3000);
  assert.equal(existsSync(dir), false, 'la seconde tentative doit supprimer le fichier');
  assert.equal(calls, 2, 'le nettoyage doit avoir été relancé une fois');
});

test('un finaliseur qui jette toujours signale l’échec sans rejet non géré', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const registry = createJobRegistry(async () => done);
    let calls = 0;
    const job = registry.createJob({
      path: 'a.mp3',
      onFinished: () => {
        calls++;
        throw new Error('toujours en échec');
      },
    });

    await until(() => registry.getJob(job.id)!.status === 'done');
    await new Promise((r) => setTimeout(r, 50));

    assert.ok(calls >= 1, 'le nettoyage a bien été tenté');
    assert.equal(registry.getJob(job.id)!.status, 'done', 'l’état terminal est publié malgré l’échec');
    assert.deepEqual(unhandled, [], 'aucun rejet non géré');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('le balayage épargne un dossier dont un fichier a été écrit récemment', async () => {
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

  // Dossier « en cours » : mtime du dossier ancien, mais un fichier récent.
  const live = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  writeFileSync(join(live, 'en-cours.mp3'), 'x');
  utimesSync(live, longAgo, longAgo);
  utimesSync(join(live, 'en-cours.mp3'), new Date(), new Date());

  // Dossier « abandonné » : dossier ET fichier anciens.
  const dead = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  writeFileSync(join(dead, 'oublie.mp3'), 'x');
  utimesSync(dead, longAgo, longAgo);
  utimesSync(join(dead, 'oublie.mp3'), longAgo, longAgo);

  try {
    await sweepStaleUploads(60 * 60 * 1000);
    assert.equal(existsSync(live), true, 'un envoi en cours (fichier récent) doit être épargné');
    assert.equal(existsSync(dead), false, 'un dossier entièrement ancien doit être supprimé');
  } finally {
    rmSync(live, { recursive: true, force: true });
    rmSync(dead, { recursive: true, force: true });
  }
});

test('la table des nettoyages est purgée avec les jobs évincés', async () => {
  const registry = createJobRegistry(async () => done, { maxRetainedFinished: 1 });

  const a = registry.createJob({ path: 'a.mp3', onFinished: () => {} });
  await until(() => registry.getJob(a.id)!.status === 'done');
  assert.equal(registry.retainedCleanupCount(), 1, 'un nettoyage est référencé');

  const b = registry.createJob({ path: 'b.mp3', onFinished: () => {} });
  await until(() => registry.getJob(b.id)!.status === 'done');

  assert.equal(registry.getJob(a.id), undefined, 'le plus ancien terminé est évincé');
  assert.equal(registry.retainedCleanupCount(), 1, 'l’entrée du job évincé a été supprimée');
});
