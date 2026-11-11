// Tests des helpers du pipeline local (identifiant synthétique stable).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { localVideoId } from '../src/local-chapters.ts';

test('localVideoId : préfixe local: + 16 hex, stable pour un même chemin', () => {
  const id = localVideoId('C:\\media\\reportage.mp3');
  assert.match(id, /^local:[0-9a-f]{16}$/);
  assert.equal(id, localVideoId('C:\\media\\reportage.mp3'));
  assert.notEqual(id, localVideoId('C:\\media\\autre.mp3'));
});

test('localVideoId normalise en chemin absolu (stable depuis un cwd donné)', () => {
  // resolve() rend l'id indépendant de la forme relative/absolue du même fichier.
  assert.equal(localVideoId('reportage.mp3'), localVideoId('.\\reportage.mp3'));
});
