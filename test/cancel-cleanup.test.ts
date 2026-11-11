// Tests du couple annulation / nettoyage du fichier temporaire, du balayage de
// démarrage et de l'hygiène des erreurs d'envoi.
//
// Invariant vérifié pour un job DOTÉ d'un finaliseur (contrat du registre) : un
// état terminal (« cancelled », « done », « error ») n'est JAMAIS observable
// tant que le fichier temporaire existe encore.
//
// Depuis le passage au CACHE d'envoi, un envoi n'enregistre plus de finaliseur
// (le média appartient à la rétention, pas au cycle de vie du job) : on vérifie
// aussi qu'un job SANS finaliseur ne peut pas rester bloqué en « cancelling ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { createJobRegistry, type JobPipeline, type JobRegistry, type JobStatus } from '../src/jobs.ts';
import { UPLOAD_DIR_PREFIX, sweepStaleUploads } from '../src/upload.ts';

// Dossier temporaire privé (voir test/upload.test.ts) : `os.tmpdir()` relit
// TEMP/TMP à chaque appel, ce qui isole ce fichier des autres tests parallèles.
const privateRoot = mkdtempSync(join(tmpdir(), 'ckr-cancel-files-'));
process.env.TEMP = privateRoot;
process.env.TMP = privateRoot;
process.env.TMPDIR = privateRoot;
const testTmp = tmpdir();

const dbDir = mkdtempSync(join(testTmp, 'ckr-cancel-db-'));
process.env.DB_PATH = join(dbDir, 'cancel.db');
process.env.MEDIA_DIR = dbDir;

async function until(pred: () => boolean, timeoutMs = 5000): Promise<void> {
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

/** Fichier temporaire d'envoi factice (dossier réel sous %TEMP%). */
function makeTempUpload(): { dir: string; file: string } {
  const dir = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  const file = join(dir, 'clip final.mp3');
  writeFileSync(file, 'x');
  return { dir, file };
}

/** Trace d'un finaliseur : combien de fois, dans quel état, fichier présent ? */
type CleanupLog = { runs: number; statusAtCleanup: JobStatus[]; dirExisted: boolean[]; dir: string };
function makeCleanupLog(dir: string): CleanupLog {
  return { runs: 0, statusAtCleanup: [], dirExisted: [], dir };
}

/**
 * Finaliseur instrumenté, lent (comme un vrai `rm`), qui enregistre l'état du
 * job et l'existence du fichier AU MOMENT du nettoyage.
 */
function instrumentedFinalizer(log: CleanupLog, registry: JobRegistry, id: () => string) {
  return async () => {
    log.runs++;
    log.statusAtCleanup.push(registry.getJob(id())!.status);
    log.dirExisted.push(existsSync(log.dir));
    await new Promise((r) => setTimeout(r, 60));
    rmSync(log.dir, { recursive: true, force: true });
  };
}

test('annuler un job EN COURS : le fichier disparaît avant l’état « cancelled »', async () => {
  const log = makeCleanupLog(makeTempUpload().dir);

  // Pipeline qui ne se termine que sur annulation.
  const pipeline: JobPipeline = async (_input, { signal }) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('interrompu')));
    });
    return done;
  };

  const registry = createJobRegistry(pipeline);
  let id = '';
  const job = registry.createJob({ path: 'clip.mp3', onFinished: instrumentedFinalizer(log, registry, () => id) });
  id = job.id;
  await until(() => registry.getJob(id)!.status === 'running');

  const afterCancel = registry.cancelJob(id)!;
  assert.equal(afterCancel.status, 'cancelling', 'l’annulation s’annonce, elle ne se simule pas');
  assert.equal(afterCancel.message, 'Annulation en cours…');
  assert.ok(existsSync(log.dir), 'le fichier existe encore pendant l’annulation');

  await until(() => registry.getJob(id)!.status === 'cancelled');
  assert.equal(registry.getJob(id)!.message, 'Annulé.');
  assert.equal(existsSync(log.dir), false, 'le fichier temporaire doit être supprimé');
  assert.deepEqual(log.statusAtCleanup, ['cancelling'], 'état non terminal pendant le nettoyage');
  assert.deepEqual(log.dirExisted, [true], 'le fichier était bien présent au moment du nettoyage');

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(log.runs, 1, 'le finaliseur ne doit pas être relancé');
});

test('annuler un job EN ATTENTE : nettoyage immédiat, « cancelled » publié ensuite', async () => {
  const log = makeCleanupLog(makeTempUpload().dir);

  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (input) => {
    if (input.path === 'bloque.mp3') await blocker;
    return done;
  };

  const registry = createJobRegistry(pipeline);
  const running = registry.createJob({ path: 'bloque.mp3' });
  await until(() => registry.getJob(running.id)!.status === 'running');

  let id = '';
  const queued = registry.createJob({
    path: 'en-attente.mp3',
    onFinished: instrumentedFinalizer(log, registry, () => id),
  });
  id = queued.id;
  assert.equal(registry.getJob(id)!.status, 'queued');

  const afterCancel = registry.cancelJob(id)!;
  assert.equal(afterCancel.status, 'cancelling', 'l’état reste non terminal tant que le fichier est là');

  await until(() => registry.getJob(id)!.status === 'cancelled');
  assert.equal(existsSync(log.dir), false, 'le fichier est supprimé sans attendre la file');
  assert.deepEqual(log.statusAtCleanup, ['cancelling']);
  assert.equal(log.runs, 1);

  // Le job traverse ensuite la file : le nettoyage ne doit pas être relancé.
  release();
  await until(() => registry.getJob(running.id)!.status === 'done');
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(log.runs, 1, 'le passage dans la file ne relance pas le nettoyage');
  assert.equal(registry.getJob(id)!.status, 'cancelled');
});

// Les deux ordres « annulation puis exécution » et « exécution puis annulation »
// sont couverts ci-dessus ; on vérifie ici les fins normales.
for (const testCase of [
  { name: 'succès', expected: 'done' as JobStatus, pipeline: (async () => done) as JobPipeline },
  {
    name: 'erreur',
    expected: 'error' as JobStatus,
    pipeline: (async () => {
      throw new Error('ffmpeg a échoué');
    }) as JobPipeline,
  },
]) {
  test(`le finaliseur s’exécute exactement une fois (${testCase.name})`, async () => {
    const log = makeCleanupLog(makeTempUpload().dir);
    const registry = createJobRegistry(testCase.pipeline);
    let id = '';
    const job = registry.createJob({ path: 'a.mp3', onFinished: instrumentedFinalizer(log, registry, () => id) });
    id = job.id;

    await until(() => {
      const s = registry.getJob(id)!.status;
      return s === 'done' || s === 'error' || s === 'cancelled';
    });
    assert.equal(registry.getJob(id)!.status, testCase.expected);
    assert.equal(existsSync(log.dir), false, 'aucun fichier ne doit rester');
    assert.deepEqual(
      log.statusAtCleanup.map((s) => s !== 'done' && s !== 'error' && s !== 'cancelled'),
      [true],
      'l’état terminal ne doit pas être publié avant le nettoyage',
    );
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(log.runs, 1);
  });
}

test('un job SANS finaliseur (envoi en cache) ne reste jamais bloqué en « cancelling »', async () => {
  // Pipeline qui ne se termine que sur annulation : exactement le cas d'un job
  // d'envoi, qui ne fournit plus de `onFinished` (le média est conservé).
  const pipeline: JobPipeline = async (_input, { signal }) => {
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('interrompu')));
    });
    return done;
  };
  const registry = createJobRegistry(pipeline);
  const job = registry.createJob({ path: 'cache/clip.mp3' }); // aucun finaliseur
  await until(() => registry.getJob(job.id)!.status === 'running');

  assert.equal(registry.cancelJob(job.id)!.status, 'cancelling');
  await until(() => registry.getJob(job.id)!.status === 'cancelled');
  assert.equal(registry.getJob(job.id)!.message, 'Annulé.');
  assert.equal(registry.retainedCleanupCount(), 1, 'l’entrée de nettoyage reste inerte (no-op)');
});

test('annuler un job SANS finaliseur EN ATTENTE publie « cancelled » sans attendre la file', async () => {
  let release!: () => void;
  const blocker = new Promise<void>((r) => (release = r));
  const pipeline: JobPipeline = async (input) => {
    if (input.path === 'bloque.mp3') await blocker;
    return done;
  };
  const registry = createJobRegistry(pipeline);
  const running = registry.createJob({ path: 'bloque.mp3' });
  await until(() => registry.getJob(running.id)!.status === 'running');

  const queued = registry.createJob({ path: 'cache/en-attente.mp3' }); // aucun finaliseur
  assert.equal(registry.getJob(queued.id)!.status, 'queued');
  assert.equal(registry.cancelJob(queued.id)!.status, 'cancelling');

  await until(() => registry.getJob(queued.id)!.status === 'cancelled');
  release();
  await until(() => registry.getJob(running.id)!.status === 'done');
  assert.equal(registry.getJob(queued.id)!.status, 'cancelled', 'l’état terminal reste stable');
});

test('un finaliseur qui échoue ne bloque pas l’état terminal (le balayage reprend la main)', async () => {
  const registry = createJobRegistry(async () => done);
  const job = registry.createJob({
    path: 'a.mp3',
    onFinished: () => {
      throw new Error('fichier verrouillé');
    },
  });
  await until(() => registry.getJob(job.id)!.status === 'done');
  assert.equal(registry.getJob(job.id)!.status, 'done', 'le job ne doit pas rester bloqué');
});

test('le balayage supprime un dossier ancien et épargne un dossier récent', async () => {
  const stale = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  const fresh = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  writeFileSync(join(stale, 'vieux.mp3'), 'x');
  writeFileSync(join(fresh, 'neuf.mp3'), 'x');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  // L'ancienneté se juge sur l'activité la plus récente (dossier ET fichiers).
  utimesSync(stale, old, old);
  utimesSync(join(stale, 'vieux.mp3'), old, old);

  try {
    const removed = await sweepStaleUploads(60 * 60 * 1000);
    assert.ok(removed >= 1, 'au moins le dossier abandonné doit être supprimé');
    assert.equal(existsSync(stale), false, 'un dossier abandonné est supprimé');
    assert.equal(existsSync(fresh), true, 'un dossier récent (serveur en cours) est épargné');
  } finally {
    rmSync(fresh, { recursive: true, force: true });
  }
});

test('createApp déclenche le balayage de démarrage', async () => {
  const stale = mkdtempSync(join(testTmp, UPLOAD_DIR_PREFIX));
  writeFileSync(join(stale, 'oublie.mp3'), 'x');
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(stale, old, old);
  utimesSync(join(stale, 'oublie.mp3'), old, old);

  const app = (await import('../src/app.ts')).createApp({ pipeline: async () => done, logger: false });
  try {
    await until(() => !existsSync(stale));
    assert.equal(existsSync(stale), false, 'le dossier oublié est nettoyé au démarrage');
  } finally {
    await app.close();
  }
});

test('un nom de fichier de 304 caractères donne 400 et jamais de chemin', async () => {
  const app: FastifyInstance = (await import('../src/app.ts')).createApp({ pipeline: async () => done, logger: false });
  try {
    const name = 'a'.repeat(300) + '.mp3';
    const res = await app.inject({
      method: 'POST',
      url: '/local/jobs/upload',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(name) },
      payload: Buffer.alloc(64, 1),
    });
    assert.equal(res.statusCode, 400, res.body);
    const body = res.json() as { error: string };
    assert.match(body.error, /nom du fichier|trop long|invalide/i);
    assert.ok(!/[A-Za-z]:\\/.test(res.body), 'aucun chemin Windows ne doit apparaître');
    assert.ok(!res.body.includes(tmpdir()), 'aucun chemin absolu ne doit apparaître');
    assert.ok(!/Users|boris/i.test(res.body), 'aucune trace du compte utilisateur');
  } finally {
    await app.close();
  }
});
