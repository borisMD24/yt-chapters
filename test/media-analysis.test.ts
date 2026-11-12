// Tests unitaires du module d'analyse de forme d'onde : validation de fenêtre,
// quantification, lecture du journal ffmpeg (pics, durée, silences), traduction
// des erreurs et cache du service. Aucun ffmpeg réel : le lanceur est injecté.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANALYSIS_FAILED_MESSAGE,
  ANALYSIS_TIMEOUT_MESSAGE,
  ANALYSIS_WINDOW_INVALID_MESSAGE,
  ANALYSIS_WINDOW_TOO_LONG_MESSAGE,
  AnalysisError,
  computePeaks,
  createAnalysisService,
  parseAnalysisQuery,
  parseMediaDurationSec,
  parseSilences,
  quantizeWindow,
  toAnalysisError,
  type AnalysisRunner,
} from '../src/media-analysis.ts';

// ---------- validation de la fenêtre ----------

test('parseAnalysisQuery accepte une fenêtre finie, positive et assez courte', () => {
  assert.deepEqual(parseAnalysisQuery({ from: '10', to: '40' }), { ok: true, from: 10, to: 40 });
  assert.deepEqual(parseAnalysisQuery({ from: 0, to: 120 }), { ok: true, from: 0, to: 120 });
});

test('parseAnalysisQuery refuse (message FR) une fenêtre négative, inversée, trop longue ou non finie', () => {
  for (const q of [
    { from: '-1', to: '10' },
    { from: '0', to: '0' },
    { from: '10', to: '5' },
    { from: 'abc', to: '10' },
    { from: '0', to: 'nope' },
    {},
  ]) {
    const res = parseAnalysisQuery(q);
    assert.equal(res.ok, false, `doit refuser ${JSON.stringify(q)}`);
    if (!res.ok) assert.equal(res.message, ANALYSIS_WINDOW_INVALID_MESSAGE);
  }
  const tooLong = parseAnalysisQuery({ from: '0', to: '121' });
  assert.equal(tooLong.ok, false);
  if (!tooLong.ok) assert.equal(tooLong.message, ANALYSIS_WINDOW_TOO_LONG_MESSAGE);
  assert.match(ANALYSIS_WINDOW_TOO_LONG_MESSAGE, /120 secondes/);
});

test('quantizeWindow aligne la fenêtre sur la grille de 0,5 s et borne à 120 s', () => {
  assert.deepEqual(quantizeWindow(0.24, 30.26), { from: 0, to: 30, len: 30 });
  assert.deepEqual(quantizeWindow(59.7, 60.1), { from: 59.5, to: 60, len: 0.5 });
  // Une longueur nulle (arrondi) retombe sur le pas minimal, jamais 0.
  assert.equal(quantizeWindow(10, 10.1).len, 0.5);
  // Jamais plus de 120 s.
  assert.equal(quantizeWindow(0, 119.9).len <= 120, true);
});

// ---------- pics ----------

test('computePeaks renvoie au plus 600 points [min,max] bornés et arrondis', () => {
  const pcm = Buffer.alloc(96000 * 2); // 96000 échantillons = 12 s à 8 kHz
  for (let i = 0; i < 96000; i++) pcm.writeInt16LE(((i % 200) - 100) * 300, i * 2);
  const peaks = computePeaks(pcm);
  assert.equal(peaks.length, 600);
  for (const [mn, mx] of peaks) {
    assert.ok(mn >= -1 && mn <= 1 && mx >= -1 && mx <= 1, 'borné dans [-1, 1]');
    assert.ok(mn <= mx, 'min ≤ max');
    for (const v of [mn, mx]) assert.ok(Math.abs(v * 100 - Math.round(v * 100)) < 1e-9, 'deux décimales');
  }
});

test('computePeaks respecte les extrêmes pleine échelle et un tampon vide', () => {
  const pcm = Buffer.alloc(4 * 2);
  pcm.writeInt16LE(-32768, 0);
  pcm.writeInt16LE(32767, 2);
  pcm.writeInt16LE(0, 4);
  pcm.writeInt16LE(16384, 6);
  assert.deepEqual(computePeaks(pcm), [
    [-1, -1],
    [1, 1],
    [0, 0],
    [0.5, 0.5],
  ]);
  assert.deepEqual(computePeaks(Buffer.alloc(0)), []);
});

// ---------- journal ffmpeg ----------

test('parseMediaDurationSec lit la durée annoncée, sinon null', () => {
  assert.equal(parseMediaDurationSec('Duration: 00:02:55.30, start: 0.0'), 175.3);
  assert.equal(parseMediaDurationSec('Duration: 01:00:00.00'), 3600);
  assert.equal(parseMediaDurationSec('Duration: N/A'), null);
  assert.equal(parseMediaDurationSec('rien'), null);
});

test('parseSilences renvoie des intervalles ABSOLUS arrondis à 0,01 s', () => {
  const stderr = [
    'Duration: 00:02:00.00, start: 0.000000, bitrate: 8 kb/s',
    '[silencedetect @ 0x1] silence_start: 10.5',
    '[silencedetect @ 0x1] silence_end: 12.25 | silence_duration: 1.75',
    '[silencedetect @ 0x1] silence_start: 30.001',
    '[silencedetect @ 0x1] silence_end: 31.999 | silence_duration: 1.998',
  ].join('\n');
  assert.deepEqual(parseSilences(stderr, 60, 60), [
    { startSec: 70.5, endSec: 72.25 },
    { startSec: 90, endSec: 92 },
  ]);
});

test('parseSilences referme un silence courant à la fin de la tranche', () => {
  const stderr = '[silencedetect @ 0x1] silence_start: 5.5';
  assert.deepEqual(parseSilences(stderr, 0, 20), [{ startSec: 5.5, endSec: 20 }]);
});

// ---------- traduction des erreurs ----------

test('toAnalysisError traduit délai, outil absent et échec générique en messages FR', () => {
  const timeout = toAnalysisError(Object.assign(new Error('killed'), { killed: true, signal: 'SIGTERM' }));
  assert.equal(timeout.kind, 'timeout');
  assert.equal(timeout.status, 504);
  assert.equal(timeout.message, ANALYSIS_TIMEOUT_MESSAGE);

  const missing = toAnalysisError(Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' }));
  assert.equal(missing.kind, 'missing-tools');
  assert.equal(missing.status, 503);

  const failed = toAnalysisError(new Error('boom'));
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.status, 500);
  assert.equal(failed.message, ANALYSIS_FAILED_MESSAGE);
});

// ---------- service (cache, troncature, propagation) ----------

const STDERR = ['Duration: 00:01:00.00, start: 0.0', '[silencedetect @ 0x1] silence_start: 12.5', '[silencedetect @ 0x1] silence_end: 14'].join(
  '\n',
);

function pcmSeconds(seconds: number): Buffer {
  const samples = Math.round(seconds * 8000);
  const b = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) b.writeInt16LE(((i % 80) - 40) * 500, i * 2);
  return b;
}

test('le service ne relance PAS le lanceur pour une fenêtre identique (cache)', async () => {
  let calls = 0;
  const runner: AnalysisRunner = async () => {
    calls++;
    return { pcm: pcmSeconds(30), stderr: STDERR };
  };
  const svc = createAnalysisService({ runner });
  const a = await svc.analyze('local:x', 'f.mp3', 0, 30);
  const b = await svc.analyze('local:x', 'f.mp3', 0, 30);
  assert.equal(calls, 1, 'une seule exécution');
  assert.deepEqual(a, b);
  assert.equal(svc.cacheSize(), 1);

  await svc.analyze('local:x', 'f.mp3', 30, 60);
  assert.equal(calls, 2, 'une autre fenêtre relance le lanceur');
});

test('le service tronque « to » au-delà de la durée du média et expose durée + silences', async () => {
  const runner: AnalysisRunner = async (_file, from, len) => ({
    pcm: pcmSeconds(len),
    stderr: ['Duration: 00:00:10.00, start: 0.0', '[silencedetect @ 0x1] silence_start: 2', '[silencedetect @ 0x1] silence_end: 3.4'].join('\n'),
  });
  const svc = createAnalysisService({ runner });
  const res = await svc.analyze('local:t', 'f.mp3', 5, 15);
  assert.equal(res.to, 10, 'to tronquée à la durée');
  assert.equal(res.durationSec, 10);
  assert.deepEqual(res.silences, [{ startSec: 7, endSec: 8.4 }]);
  assert.equal(res.peaks.length, 600);
});

test('le service propage une AnalysisError telle quelle (délai)', async () => {
  const runner: AnalysisRunner = async () => {
    throw new AnalysisError('timeout', ANALYSIS_TIMEOUT_MESSAGE);
  };
  const svc = createAnalysisService({ runner });
  await assert.rejects(() => svc.analyze('local:to', 'f.mp3', 0, 20), (err: unknown) => {
    assert.ok(err instanceof AnalysisError);
    assert.equal(err.kind, 'timeout');
    assert.match(err.message, /délai/i);
    return true;
  });
});

test('le service plafonne la taille du cache (éviction du plus ancien)', async () => {
  let calls = 0;
  const runner: AnalysisRunner = async () => {
    calls++;
    return { pcm: pcmSeconds(5), stderr: STDERR };
  };
  const svc = createAnalysisService({ runner, maxEntries: 2 });
  await svc.analyze('id', 'f', 0, 5);
  await svc.analyze('id', 'f', 0, 10);
  await svc.analyze('id', 'f', 0, 15);
  assert.equal(svc.cacheSize(), 2);
  // La première fenêtre a été évincée : elle est recalculée.
  await svc.analyze('id', 'f', 0, 5);
  assert.equal(calls, 4);
});
