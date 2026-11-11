// Tests du payload `--json` du CLI : il doit exposer les segments (produits en
// mémoire par le pipeline, jamais persistés) pour permettre une vérification
// indépendante. L'import du module ne doit PAS exécuter le CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { jsonPayload, parseArgs, isEntryPoint, validateChunkSec } from '../src/cli.ts';
import { MIN_CHUNK_SEC } from '../src/audio.ts';
import type { LocalChaptersResult } from '../src/local-chapters.ts';

const sample: LocalChaptersResult = {
  videoId: 'local:0123456789abcdef',
  title: 'reportage.mp3',
  durationSec: 9.09,
  segments: [
    { startSec: 0, endSec: 3.024, text: 'Bonjour' },
    { startSec: 3.024, endSec: 6.012, text: 'Suite' },
  ],
  chapters: [{ startSec: 0, title: 'Intro' }],
  text: '0:00 Intro',
  warnings: [],
};

test('jsonPayload expose les segments et garde les clés historiques', () => {
  const p = jsonPayload(sample) as Record<string, unknown>;
  assert.deepEqual(p.segments, sample.segments);
  assert.equal((p.segments as unknown[]).length, 2);
  for (const k of ['videoId', 'title', 'durationSec', 'text', 'warnings', 'chapters']) {
    assert.ok(k in p, `clé manquante dans le payload --json : ${k}`);
  }
  assert.deepEqual(p.chapters, sample.chapters);
});

test('jsonPayload reste sérialisable tel quel (console.log(JSON.stringify(...)))', () => {
  const round = JSON.parse(JSON.stringify(jsonPayload(sample))) as { segments: unknown[] };
  assert.equal(round.segments.length, 2);
});

test('parseArgs : options existantes inchangées (--json, --chunk, --lang, --max-chunks)', () => {
  const a = parseArgs(['film.mp4', '--chunk', '120', '--lang', 'fr', '--max-chunks', '3', '--json']);
  assert.deepEqual(a, { file: 'film.mp4', chunkSec: 120, lang: 'fr', maxChunks: 3, json: true });
  assert.deepEqual(parseArgs([]), { json: false });
});

test('isEntryPoint : vrai seulement pour le script lancé (module importable sans effet de bord)', () => {
  const here = resolve('src/cli.ts');
  const url = pathToFileURL(here).href;
  assert.equal(isEntryPoint(here, url), true);
  assert.equal(isEntryPoint('src/cli.ts', url), true); // relatif résolu depuis le cwd
  assert.equal(isEntryPoint(undefined, url), false);
  assert.equal(isEntryPoint(resolve('src/other.ts'), url), false);
});

test('validateChunkSec : refuse un chunk plus court que MIN_CHUNK_SEC', () => {
  // Sans ce garde-fou : 0 chunk produit et message trompeur "aucun chunk produit".
  assert.equal(validateChunkSec(undefined), null);
  assert.equal(validateChunkSec(300), null);
  assert.equal(validateChunkSec(MIN_CHUNK_SEC), null);
  assert.match(String(validateChunkSec(0.5)), /1/);
  assert.match(String(validateChunkSec(0.5)), /--chunk/);
  assert.match(String(validateChunkSec(0)), /--chunk/);
  assert.match(String(validateChunkSec(Number.NaN)), /--chunk/);
  assert.match(String(validateChunkSec(Number.POSITIVE_INFINITY)), /--chunk/);
});
