// Correctif de revue — service d'analyse : coalescence des demandes identiques
// simultanées (un seul ffmpeg), plafond de concurrence (429 FR, jamais de file
// illimitée), compteur de créneaux rendu à zéro, et fenêtre jamais inversée
// quand `from` dépasse la durée du média. Lanceur injecté : aucun processus.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AnalysisError,
  createAnalysisService,
  type AnalysisRunner,
  type AnalysisRunnerOutput,
} from '../src/media-analysis.ts';

const STDERR = ['Duration: 00:01:00.00, start: 0.0', '[silencedetect @ 0x1] silence_start: 12.5'].join('\n');

function pcmSeconds(seconds: number): Buffer {
  const samples = Math.round(seconds * 8000);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((i % 80) - 40) * 500, i * 2);
  return b;
}

const ok5 = (): AnalysisRunnerOutput => ({ pcm: pcmSeconds(5), stderr: STDERR });

type Gate = {
  promise: Promise<AnalysisRunnerOutput>;
  resolve: (v: AnalysisRunnerOutput) => void;
  reject: (e: unknown) => void;
};

function gate(): Gate {
  let resolve!: (v: AnalysisRunnerOutput) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<AnalysisRunnerOutput>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('deux appels identiques SIMULTANÉS ne lancent qu’un seul ffmpeg (coalescence)', async () => {
  let calls = 0;
  const g = gate();
  const runner: AnalysisRunner = () => {
    calls++;
    return g.promise;
  };
  const svc = createAnalysisService({ runner });

  const p1 = svc.analyze('id', 'f.mp3', 0, 30);
  const p2 = svc.analyze('id', 'f.mp3', 0, 30);
  assert.equal(calls, 1, 'une seule exécution malgré deux demandes');

  g.resolve(ok5());
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
  assert.equal(calls, 1);
});

test('une demande coalescée qui échoue échoue pour TOUS, sans être mémorisée', async () => {
  let calls = 0;
  const g = gate();
  const runner: AnalysisRunner = () => {
    calls++;
    return g.promise;
  };
  const svc = createAnalysisService({ runner });

  const p1 = svc.analyze('id', 'f.mp3', 0, 30);
  const p2 = svc.analyze('id', 'f.mp3', 0, 30);
  assert.equal(calls, 1);
  g.reject(new Error('boom'));
  await assert.rejects(() => p1);
  await assert.rejects(() => p2, 'l’échec est partagé par les deux demandes');

  // Non mémorisé : un nouvel appel relance le lanceur (même s'il rejette encore).
  await assert.rejects(() => svc.analyze('id', 'f.mp3', 0, 30));
  assert.equal(calls, 2, 'un échec n’est jamais mis en cache');
});

test('au-delà du plafond, la demande est refusée (429 FR) sans file d’attente', async () => {
  let calls = 0;
  const gates: Gate[] = [];
  const runner: AnalysisRunner = () => {
    calls++;
    const g = gate();
    gates.push(g);
    return g.promise;
  };
  const svc = createAnalysisService({ runner, maxConcurrent: 2 });

  const a = svc.analyze('id', 'f.mp3', 0, 10);
  const b = svc.analyze('id', 'f.mp3', 0, 20);
  await assert.rejects(
    () => svc.analyze('id', 'f.mp3', 0, 30),
    (err: unknown) => {
      assert.ok(err instanceof AnalysisError);
      assert.equal(err.kind, 'busy');
      assert.equal(err.status, 429);
      assert.match(err.message, /simultan/i);
      return true;
    },
  );
  assert.equal(calls, 2, 'jamais plus de créneaux lancés que le plafond');

  // Les créneaux se libèrent : le compteur retombe, une nouvelle demande passe.
  gates.forEach((g) => g.resolve(ok5()));
  await Promise.all([a, b]);
  assert.equal(svc.pending(), 0, 'le compteur d’analyses en vol retombe à zéro');

  const c = svc.analyze('id', 'f.mp3', 0, 40);
  assert.equal(calls, 3, 'un créneau est disponible après libération');
  assert.equal(svc.pending(), 1);
  gates[2]!.resolve(ok5());
  await c;
  assert.equal(svc.pending(), 0, 'et retombe à zéro après la dernière réponse');
});

test('une fenêtre entièrement au-delà de la durée n’est jamais inversée', async () => {
  const runner: AnalysisRunner = async () => ({ pcm: Buffer.alloc(0), stderr: 'Duration: 00:00:10.00, start: 0.0' });
  const svc = createAnalysisService({ runner });
  const res = await svc.analyze('id', 'f.mp3', 50, 60);
  assert.equal(res.durationSec, 10);
  assert.equal(res.from, 50);
  assert.equal(res.to, 50, 'to bornée à from : jamais to < from');
  assert.ok(res.to >= res.from);
  assert.deepEqual(res.peaks, []);
  assert.deepEqual(res.silences, []);
});
