// Sonde « ce fichier contient-il une piste vidéo ? » : vraie ffprobe pour les
// formats lisibles, sonde injectable pour les tests unitaires.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeHasVideo } from '../src/media-check.ts';

test('probeHasVideo : vraie sonde injectée (piste vidéo présente ou non)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-vp-'));
  const file = join(dir, 'x.mp4');
  writeFileSync(file, 'x');

  assert.equal(await probeHasVideo(file, { probe: async () => true }), true);
  assert.equal(await probeHasVideo(file, { probe: async () => false }), false);
});

test('probeHasVideo : une sonde qui échoue répond false (jamais d’exception)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-vp-'));
  const file = join(dir, 'x.mp4');
  writeFileSync(file, 'x');

  assert.equal(
    await probeHasVideo(file, {
      probe: async () => {
        throw new Error('ffprobe absent');
      },
    }),
    false,
  );
  assert.equal(await probeHasVideo(join(dir, 'absent.mp4'), { probe: async () => true }), false);
});
