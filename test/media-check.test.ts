// Tests de la validation d'un média AVANT découpage : erreurs typées portant un
// message français actionnable, refus d'un fichier vide sans lancer ffmpeg, et
// détection d'un ffprobe/ffmpeg introuvable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  checkMedia,
  checkTools,
  isToolMissingError,
  MediaValidationError,
  MEDIA_NO_AUDIO_MESSAGE,
  MEDIA_TOOLS_MISSING_MESSAGE,
  MEDIA_UNREADABLE_MESSAGE,
  type MediaProbe,
} from '../src/media-check.ts';
import { chunkToMp3 } from '../src/audio.ts';

const run = promisify(execFile);

/** Erreur imitant un `spawn ffprobe ENOENT` (binaire absent du PATH). */
function enoent(tool: string): NodeJS.ErrnoException {
  const err = new Error(`spawn ${tool} ENOENT`) as NodeJS.ErrnoException;
  err.code = 'ENOENT';
  return err;
}

test('checkMedia refuse un fichier de 0 octet SANS appeler ffprobe', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-empty-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const empty = join(dir, 'vide.mp4');
  await writeFile(empty, '');

  let called = 0;
  const probe = async (): Promise<MediaProbe> => {
    called++;
    return { durationSec: 5, hasAudio: true };
  };

  await assert.rejects(
    () => checkMedia(empty, { probe }),
    (err: unknown) => {
      assert.ok(err instanceof MediaValidationError, 'une MediaValidationError est attendue');
      assert.equal((err as MediaValidationError).kind, 'unreadable');
      assert.equal((err as MediaValidationError).message, MEDIA_UNREADABLE_MESSAGE);
      return true;
    },
  );
  assert.equal(called, 0, 'ffprobe ne doit jamais être lancé pour un fichier vide');
});

test('checkMedia refuse un média illisible/corrompu (message français exact)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const fake = join(dir, 'faux.mp4');
  await writeFile(fake, 'ceci n est pas une video mais un fichier de taille non nulle');

  // ffprobe échoue sur un contenu non reconnu (code 1, stderr « moov atom ... »).
  const probe = async (): Promise<MediaProbe> => {
    const err = new Error('ffprobe exited with code 1') as NodeJS.ErrnoException;
    err.code = '1';
    throw err;
  };

  await assert.rejects(
    () => checkMedia(fake, { probe }),
    (err: unknown) => {
      assert.ok(err instanceof MediaValidationError);
      assert.equal((err as MediaValidationError).kind, 'unreadable');
      assert.equal((err as MediaValidationError).message, MEDIA_UNREADABLE_MESSAGE);
      return true;
    },
  );
});

test('checkMedia signale un média sans piste audio (message français exact)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-noaudio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const video = join(dir, 'muet.mp4');
  await writeFile(video, 'peu importe', 'utf8');

  const probe = async (): Promise<MediaProbe> => ({ durationSec: 12, hasAudio: false });

  await assert.rejects(
    () => checkMedia(video, { probe }),
    (err: unknown) => {
      assert.ok(err instanceof MediaValidationError);
      assert.equal((err as MediaValidationError).kind, 'no-audio');
      assert.equal((err as MediaValidationError).message, MEDIA_NO_AUDIO_MESSAGE);
      return true;
    },
  );
});

test('checkMedia traduit un ffprobe introuvable (message français exact)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-missing-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'ok.mp4');
  await writeFile(file, 'contenu');

  await assert.rejects(
    () => checkMedia(file, { probe: async () => Promise.reject(enoent('ffprobe')) }),
    (err: unknown) => {
      assert.ok(err instanceof MediaValidationError);
      assert.equal((err as MediaValidationError).kind, 'missing-tools');
      assert.equal((err as MediaValidationError).message, MEDIA_TOOLS_MISSING_MESSAGE);
      return true;
    },
  );
});

test('checkMedia refuse un fichier absent (illisible, sans lancer ffprobe)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-absent-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let called = 0;
  await assert.rejects(
    () => checkMedia(join(dir, 'jamais-la.mp4'), { probe: async () => (called++, { durationSec: 1, hasAudio: true }) }),
    (err: unknown) => err instanceof MediaValidationError && err.message === MEDIA_UNREADABLE_MESSAGE,
  );
  assert.equal(called, 0);
});

test('isToolMissingError reconnaît ENOENT et rien d’autre', () => {
  assert.equal(isToolMissingError(enoent('ffmpeg')), true);
  assert.equal(isToolMissingError(new Error('ffprobe exited with code 1')), false);
  assert.equal(isToolMissingError(undefined), false);
});

test('checkTools marque ok:false (sans version) quand l’outil est absent', async () => {
  const status = await checkTools(async (tool) => {
    if (tool === 'ffprobe') throw enoent('ffprobe');
    return { ok: true, version: '6.1.1' };
  });
  assert.deepEqual(status.ffmpeg, { ok: true, version: '6.1.1' });
  assert.deepEqual(status.ffprobe, { ok: false });
});

test('INTEGRATION: checkTools détecte les versions réelles', async () => {
  const status = await checkTools();
  assert.equal(status.ffmpeg.ok, true);
  assert.equal(status.ffprobe.ok, true);
  assert.match(String(status.ffmpeg.version), /\d+\.\d+/);
  assert.match(String(status.ffprobe.version), /\d+\.\d+/);
});

test('INTEGRATION: checkMedia accepte un audio réel et signale une vidéo muette', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-real-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const audio = join(dir, 'ok.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-ac', '1', audio]);
  const ok = await checkMedia(audio);
  assert.equal(ok.hasAudio, true);
  assert.ok(ok.durationSec > 2 && ok.durationSec < 4, `durée inattendue : ${ok.durationSec}`);

  const silent = join(dir, 'muet.mp4');
  await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10',
    '-c:v', 'libx264', '-an', silent,
  ]);
  await assert.rejects(
    () => checkMedia(silent),
    (err: unknown) => err instanceof MediaValidationError && err.message === MEDIA_NO_AUDIO_MESSAGE,
  );
});

test('INTEGRATION: chunkToMp3 refuse une vidéo sans piste audio avec le message français', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-mc-chunk-noaudio-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const silent = join(dir, 'muet.mp4');
  await run('ffmpeg', [
    '-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'testsrc=duration=3:size=160x120:rate=10',
    '-c:v', 'libx264', '-an', silent,
  ]);

  await assert.rejects(
    () => chunkToMp3(silent, { chunkSec: 3 }),
    (err: unknown) => err instanceof MediaValidationError && err.message === MEDIA_NO_AUDIO_MESSAGE,
  );
});
