// Tests des coutures ajoutées à generateLocalChapters : progression optionnelle
// et annulation coopérative (sans appel OpenRouter ; ffmpeg requis, comme le
// reste de la suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLocalChapters } from '../src/local-chapters.ts';

const run = promisify(execFile);

test('generateLocalChapters signale "chunking" avant puis après le découpage', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-lc-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=7', '-ac', '1', src]);

  const events: { phase: string; doneChunks: number; totalChunks: number }[] = [];
  const sentinel = new Error('stop-avant-transcription');

  await assert.rejects(
    () =>
      generateLocalChapters(src, {
        chunkSec: 3,
        // On interrompt dès que le nombre de morceaux est connu, pour ne jamais
        // atteindre l'appel de transcription (pas de coût API).
        onProgress: (e) => {
          events.push(e);
          if (e.phase === 'chunking' && e.totalChunks > 0) throw sentinel;
        },
      }),
    (err: unknown) => err === sentinel,
  );

  assert.equal(events.length, 2);
  assert.deepEqual(events[0], { phase: 'chunking', doneChunks: 0, totalChunks: 0 });
  assert.equal(events[1].phase, 'chunking');
  assert.equal(events[1].totalChunks, 3);
  assert.equal(events[1].doneChunks, 3);
});

test('generateLocalChapters est sans effet de bord quand onProgress est absent', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-lc-progress-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-ac', '1', src]);
  // Sans onProgress ni signal : on doit atteindre la transcription (et échouer
  // faute de clé), ce qui prouve que les coutures sont bien optionnelles.
  const previousKey = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t.after(() => {
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });
  await assert.rejects(() => generateLocalChapters(src, { chunkSec: 1 }), /OPENROUTER_API_KEY|clé/i);
});

test('generateLocalChapters s\'arrête proprement sur un signal déjà annulé', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => generateLocalChapters('C:\\media\\jamais-ouvert.mp3', { signal: controller.signal }),
    (err: unknown) => err instanceof Error && err.name === 'AbortError',
  );
});
