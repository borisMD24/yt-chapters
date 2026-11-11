// Tests du découpage audio : offsets réels (somme des durées) et intégration ffmpeg.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeChunkOffsets, probeDurationSec, chunkToMp3, MIN_CHUNK_SEC } from '../src/audio.ts';

const run = promisify(execFile);

test('computeChunkOffsets cumule les durées réelles (dérive != 300s)', () => {
  // On ne doit jamais supposer index * 300 : les durées mesurées dérivent.
  const offsets = computeChunkOffsets([301.2, 298.7, 300.0, 12.5]);
  assert.equal(offsets.length, 4);
  assert.equal(offsets[0], 0);
  const r1 = (n: number) => Math.round(n * 10) / 10;
  assert.equal(r1(offsets[1]), 301.2);
  assert.equal(r1(offsets[2]), 599.9);
  assert.equal(r1(offsets[3]), 899.9);
});

test('computeChunkOffsets gère la liste vide', () => {
  assert.deepEqual(computeChunkOffsets([]), []);
});

test('INTEGRATION: chunkToMp3 découpe un mp3 synthétique et démarre à 0', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-audio-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Audio réel de 7s via lavfi (sine 440Hz).
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-ac', '1', src]);

  const duration = await probeDurationSec(src);
  assert.ok(duration > 6 && duration < 9, `durée inattendue: ${duration}`);

  // chunkSec par défaut (300s) => un seul chunk, offset 0.
  const single = await chunkToMp3(src);
  try {
    assert.equal(single.chunks.length, 1);
    assert.equal(single.chunks[0].startSec, 0);
    assert.ok(single.chunks[0].durationSec > 6);
  } finally {
    await single.cleanup();
  }

  // chunkSec=3 => 3 chunks, offsets croissants démarrant à 0.
  const cut = await chunkToMp3(src, { chunkSec: 3 });
  try {
    assert.equal(cut.chunks.length, 3);
    assert.equal(cut.chunks[0].startSec, 0);
    assert.ok(cut.chunks[1].startSec >= 2.5 && cut.chunks[1].startSec <= 3.5, `offset1=${cut.chunks[1].startSec}`);
    assert.ok(cut.chunks[2].startSec >= 5.5 && cut.chunks[2].startSec <= 6.5, `offset2=${cut.chunks[2].startSec}`);
    // Les offsets sont la somme des durées réelles, pas index * 3.
    assert.equal(cut.chunks[1].startSec, cut.chunks[0].durationSec);
  } finally {
    await cut.cleanup();
  }
});

test('INTEGRATION: chunkToMp3 écarte le chunk résiduel final (<1s) même sans maxChunks', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-audio-residue-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  // Source 9.04s = quasi-multiple de chunkSec=3 : le muxer "segment" émet alors un
  // dernier chunk d'une trame mp3 (<1s) après le dernier segment plein.
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9.04', '-ac', '1', src]);

  // Fixture : on rejoue la même ligne ffmpeg que chunkToMp3 pour prouver que le
  // résidu existe bien sans correctif (sinon l'assertion serait vide de sens).
  const raw = join(dir, 'raw');
  await mkdir(raw);
  await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-i', src, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'libmp3lame', '-b:a', '64k',
    '-f', 'segment', '-segment_time', '3', '-reset_timestamps', '1', join(raw, 'chunk_%04d.mp3'),
  ]);
  const rawFiles = (await readdir(raw)).filter((f) => f.endsWith('.mp3')).sort();
  const rawDurations: number[] = [];
  for (const f of rawFiles) rawDurations.push(await probeDurationSec(join(raw, f)));
  const tail = rawDurations[rawDurations.length - 1];
  assert.ok(tail < 1, `fixture inattendue : dernier chunk brut = ${tail}s (résidu <1s attendu)`);

  const cut = await chunkToMp3(src, { chunkSec: 3 });
  try {
    // Le résidu final est écarté : un chunk de moins que la sortie brute.
    assert.equal(cut.chunks.length, rawDurations.length - 1);
    assert.equal(cut.chunks.length, 3);
    for (const c of cut.chunks) assert.ok(c.durationSec >= 1, `chunk ${c.index} trop court : ${c.durationSec}s`);
    assert.equal(cut.chunks[0].startSec, 0);
    assert.equal(cut.chunks[1].startSec, cut.chunks[0].durationSec);
    assert.equal(cut.chunks[2].startSec, cut.chunks[0].durationSec + cut.chunks[1].durationSec);
  } finally {
    await cut.cleanup();
  }
});

test('chunkToMp3 refuse un chunkSec inférieur à MIN_CHUNK_SEC', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-audio-floor-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-ac', '1', src]);

  // 0.5s < plancher : mieux vaut refuser net que produire 0 chunk.
  await assert.rejects(() => chunkToMp3(src, { chunkSec: 0.5 }), /minimum 1s/);
  await assert.rejects(() => chunkToMp3(src, { chunkSec: MIN_CHUNK_SEC / 2 }), /minimum 1s/);
  // Le plancher exact reste accepté.
  const ok = await chunkToMp3(src, { chunkSec: MIN_CHUNK_SEC });
  try {
    assert.ok(ok.chunks.length >= 1);
  } finally {
    await ok.cleanup();
  }
});

test('INTEGRATION: maxChunks borne le nombre de chunks produits', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-audio-max-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-ac', '1', src]);

  const cut = await chunkToMp3(src, { chunkSec: 2, maxChunks: 2 });
  try {
    assert.equal(cut.chunks.length, 2);
    assert.equal(cut.chunks[0].startSec, 0);
  } finally {
    await cut.cleanup();
  }
});
