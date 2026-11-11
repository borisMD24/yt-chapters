// Tests du module « fichiers média » : type MIME, résolution sécurisée d'un
// chemin (jamais fourni par le client) et analyse d'un en-tête `Range` unique.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  MEDIA_NOT_FOUND_MESSAGE,
  resolveMediaFile,
  mediaContentType,
  parseSingleRange,
} from '../src/media-files.ts';

test('mediaContentType couvre les formats audio et vidéo acceptés', () => {
  assert.equal(mediaContentType('.mp3'), 'audio/mpeg');
  assert.equal(mediaContentType('.MP4'), 'video/mp4');
  assert.equal(mediaContentType('.mkv'), 'video/x-matroska');
  assert.equal(mediaContentType('.webm'), 'video/webm');
  assert.equal(mediaContentType('.m4a'), 'audio/mp4');
  assert.equal(mediaContentType('.wav'), 'audio/wav');
  assert.equal(mediaContentType('.mov'), 'video/quicktime');
  assert.equal(mediaContentType('.inconnu'), 'application/octet-stream');
});

test('parseSingleRange : requête complète, plage explicite, suffixe et bornes', () => {
  assert.deepEqual(parseSingleRange(undefined, 5000), { kind: 'full' });
  assert.deepEqual(parseSingleRange('bytes=0-1023', 5000), { kind: 'partial', start: 0, end: 1023 });
  assert.deepEqual(parseSingleRange('bytes=0-', 5000), { kind: 'partial', start: 0, end: 4999 });
  assert.deepEqual(parseSingleRange('bytes=-1024', 5000), { kind: 'partial', start: 3976, end: 4999 });
  // Suffixe plus grand que le fichier : tout le fichier.
  assert.deepEqual(parseSingleRange('bytes=-99999', 5000), { kind: 'partial', start: 0, end: 4999 });
  // Fin au-delà du fichier : bornée.
  assert.deepEqual(parseSingleRange('bytes=4000-9999', 5000), { kind: 'partial', start: 4000, end: 4999 });
});

test('parseSingleRange : plages insatisfaisables et syntaxes ignorées', () => {
  assert.deepEqual(parseSingleRange('bytes=5000-', 5000), { kind: 'unsatisfiable' });
  assert.deepEqual(parseSingleRange('bytes=6000-7000', 5000), { kind: 'unsatisfiable' });
  assert.deepEqual(parseSingleRange('bytes=-0', 5000), { kind: 'unsatisfiable' });
  // Multi-plages : choix documenté = servir le fichier entier (200).
  assert.deepEqual(parseSingleRange('bytes=0-1,5-6', 5000), { kind: 'full' });
  assert.deepEqual(parseSingleRange('items=0-1', 5000), { kind: 'full' });
  assert.deepEqual(parseSingleRange('bytes=abc', 5000), { kind: 'full' });
  assert.deepEqual(parseSingleRange('bytes=100-50', 5000), { kind: 'full' });
  // Fichier vide : une plage n'a pas de sens, on sert l'entier.
  assert.deepEqual(parseSingleRange('bytes=0-10', 0), { kind: 'full' });
});

test('resolveMediaFile : accepte un fichier média dans une racine autorisée', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckr-mf-root-'));
  const file = join(root, 'clip.mp3');
  writeFileSync(file, Buffer.alloc(2048, 3));

  const res = await resolveMediaFile(file, [root]);
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.path, file);
    assert.equal(res.ext, '.mp3');
    assert.equal(res.size, 2048);
  }
});

test('resolveMediaFile : refuse un chemin hors des racines autorisées (403)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckr-mf-root-'));
  const outside = mkdtempSync(join(tmpdir(), 'ckr-mf-out-'));
  const file = join(outside, 'evil.mp3');
  writeFileSync(file, 'x');

  const res = await resolveMediaFile(file, [root]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 403);
});

test('resolveMediaFile : refuse une extension non média (403)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckr-mf-root-'));
  const file = join(root, 'notes.txt');
  writeFileSync(file, 'pas un média');

  const res = await resolveMediaFile(file, [root]);
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.status, 403);
});

test('resolveMediaFile : refuse un dossier et un fichier absent (404)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckr-mf-root-'));
  mkdirSync(join(root, 'dossier-media.mp3')); // dossier à extension média

  const dir = await resolveMediaFile(join(root, 'dossier-media.mp3'), [root]);
  assert.equal(dir.ok, false);
  if (!dir.ok) assert.equal(dir.status, 404);

  const missing = await resolveMediaFile(join(root, 'absent.mp3'), [root]);
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.status, 404);
    assert.equal(missing.message, MEDIA_NOT_FOUND_MESSAGE);
  }
});

test('resolveMediaFile : une racine égale au fichier n’est pas « dedans »', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ckr-mf-root-'));
  const res = await resolveMediaFile(root, [root]);
  assert.equal(res.ok, false);
});
