// Hygiène du dossier temporaire : la suite ne doit pas y accumuler ses dossiers
// de fixtures d'une exécution à l'autre (voir `test/setup.mts`).
//
// Ces tests utilisent une racine DÉDIÉE : le vrai dossier temporaire n'est jamais
// modifié par le balayage testé ici.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cleanupRunFixtureDirs } from './run-tests.mjs';
import { sweepStaleTestDirs } from './setup.mts';

const HOUR = 60 * 60 * 1000;

/** Racine jetable, propre à ce test (préfixe du namespace, donc suivie). */
function scratchRoot(): string {
  return mkdtempSync(join(tmpdir(), 'ckr-hygiene-'));
}

/** Crée un dossier daté de `ageMs` (dossier ET contenu, comme la réalité). */
function makeDir(root: string, name: string, ageMs: number): string {
  const dir = join(root, name);
  mkdirSync(dir);
  const date = new Date(Date.now() - ageMs);
  utimesSync(dir, date, date);
  return dir;
}

test('le balayage supprime un dossier ckr-* ancien et épargne un récent', () => {
  const root = scratchRoot();
  const old = makeDir(root, 'ckr-fixture-old-1', 2 * HOUR);
  const fresh = makeDir(root, 'ckr-fixture-new-1', 0);

  const removed = sweepStaleTestDirs(Date.now(), HOUR, root);

  assert.deepEqual(removed, [old], 'seul le dossier périmé est supprimé');
  assert.equal(existsSync(old), false);
  assert.equal(existsSync(fresh), true, 'un dossier récent (exécution en cours) est épargné');
});

test('le balayage épargne un dossier ancien dont un fichier a été écrit récemment', () => {
  const root = scratchRoot();
  const dir = makeDir(root, 'ckr-fixture-live-1', 2 * HOUR);
  writeFileSync(join(dir, 'en-cours.mp3'), 'x'); // écriture récente dans un dossier ancien

  const removed = sweepStaleTestDirs(Date.now(), HOUR, root);

  assert.deepEqual(removed, [], 'l’activit�� la plus récente fait foi');
  assert.equal(existsSync(dir), true);
});

test('le balayage ne touche jamais un frère hors du préfixe applicatif', () => {
  const root = scratchRoot();
  const other = makeDir(root, 'autre-namespace-old', 2 * HOUR);
  const otherFile = join(root, 'ckr-fichier-old.txt'); // fichier, pas dossier
  writeFileSync(otherFile, 'x');
  const old = new Date(Date.now() - 2 * HOUR);
  utimesSync(otherFile, old, old);

  const removed = sweepStaleTestDirs(Date.now(), HOUR, root);

  assert.deepEqual(removed, []);
  assert.equal(existsSync(other), true, 'un dossier hors préfixe est ignoré');
  assert.equal(existsSync(otherFile), true, 'un fichier est ignoré (seuls les dossiers le sont)');
});

test('le balayage ne jette jamais quand la racine ou un candidat ne peut pas être supprimé', () => {
  // Racine inexistante : aucun argument d'erreur ne doit remonter.
  assert.deepEqual(sweepStaleTestDirs(Date.now(), HOUR, join(tmpdir(), `ckr-absente-${randomUUID()}`)), []);

  const root = scratchRoot();
  // Candidat verrouillé : sous Windows, un fichier ouvert empêche la suppression
  // du dossier. La fonction ne doit pas jeter, et doit poursuivre le balayage.
  const locked = makeDir(root, 'ckr-fixture-locked-1', 2 * HOUR);
  const fd = openSync(join(locked, 'garde.bin'), 'w');
  try {
    const after = makeDir(root, 'ckr-fixture-old-2', 2 * HOUR);
    const removed = sweepStaleTestDirs(Date.now(), HOUR, root);
    assert.ok(Array.isArray(removed), 'un tableau est toujours renvoyé');
    assert.equal(existsSync(after), false, 'le balayage continue après un candidat récalcitrant');
  } finally {
    closeSync(fd);
    rmSync(locked, { recursive: true, force: true });
  }
});

test('le nettoyage de fin d’exécution enlève les fixtures du run et épargne le reste', () => {
  const root = scratchRoot();
  const before = makeDir(root, 'ckr-fixture-avant-1', 3 * HOUR); // antérieur au run
  const other = makeDir(root, 'autre-namespace-1', 0); // hors préfixe applicatif
  const during = join(root, 'ckr-fixture-pendant-1');
  const since = Date.now();
  mkdirSync(during); // créé APRÈS le début du run simulé

  const removed = cleanupRunFixtureDirs(since, root);

  assert.deepEqual(removed, [during], 'seul le dossier de l’exécution est enlevé');
  assert.equal(existsSync(during), false);
  assert.equal(existsSync(before), true, 'un dossier antérieur est laissé au balayage d’âge');
  assert.equal(existsSync(other), true, 'un dossier hors préfixe n’est jamais touché');
});

test('le nettoyage de fin d’exécution ne jette jamais (racine absente, candidat récalcitrant)', () => {
  assert.deepEqual(cleanupRunFixtureDirs(Date.now(), join(tmpdir(), `ckr-absente-${randomUUID()}`)), []);

  const root = scratchRoot();
  const since = Date.now();
  const locked = join(root, 'ckr-fixture-verrouillee-1');
  mkdirSync(locked);
  const fd = openSync(join(locked, 'garde.bin'), 'w');
  try {
    const second = join(root, 'ckr-fixture-pendant-2');
    mkdirSync(second);
    const removed = cleanupRunFixtureDirs(since, root);
    assert.ok(Array.isArray(removed), 'un tableau est toujours renvoyé');
    assert.equal(existsSync(second), false, 'le nettoyage continue après un candidat récalcitrant');
  } finally {
    closeSync(fd);
    rmSync(locked, { recursive: true, force: true });
  }
});
