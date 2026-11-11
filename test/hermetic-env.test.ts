// Garde-fou d'herméticité : la suite tourne sur une base et un dossier
// TEMPORAIRES propres à l'exécution (voir `test/setup.mts`, préchargé par le
// script `test`), jamais sur la base du développeur (`data/chapters.db`) ni sur
// un dossier partagé. Ces tests échouent si le préchargement disparaît ou si une
// base partagée est réintroduite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { dbPath } from '../src/db/index.ts';
import { clearOpenRouterKey, resolveOpenRouterKey, storeOpenRouterKey } from '../src/openrouter-key.ts';

const tmp = resolve(tmpdir());

test('DB_PATH est un fichier temporaire propre à l’exécution, pas la base du dépôt', () => {
  const value = process.env.DB_PATH;
  assert.ok(value, 'test/setup.mts doit fixer DB_PATH avant les imports applicatifs');
  assert.ok(resolve(value).startsWith(tmp + sep), `DB_PATH hors du dossier temporaire : ${value}`);
  assert.match(value, /ckr-test-/, 'le dossier doit être propre à l’exécution (jamais un fichier fixe partagé)');
  // Le chemin réellement utilisé par l'application est bien celui-là.
  assert.equal(resolve(dbPath), resolve(value));
  assert.ok(!resolve(dbPath).includes(join('data', 'chapters.db')), 'jamais la base livrée');
});

test('MEDIA_DIR pointe vers un dossier temporaire existant de l’exécution', () => {
  const value = process.env.MEDIA_DIR;
  assert.ok(value, 'test/setup.mts doit fixer MEDIA_DIR');
  assert.ok(resolve(value).startsWith(tmp + sep), `MEDIA_DIR hors du dossier temporaire : ${value}`);
  assert.ok(existsSync(value), 'le dossier temporaire doit exister');
});

test('une clé écrite par un test ne sort que dans la base temporaire', () => {
  const key = 'sk-or-v1-' + 'deadbeef'.repeat(8);
  clearOpenRouterKey();
  assert.equal(storeOpenRouterKey(key), true);
  assert.equal(resolveOpenRouterKey().key, key, 'la clé doit être relue depuis la base temporaire');
  assert.ok(existsSync(process.env.DB_PATH!));
  assert.ok(!resolve(process.env.DB_PATH!).includes(join('data', 'chapters.db')));
  clearOpenRouterKey();
  assert.equal(resolveOpenRouterKey().source, 'none');
});
