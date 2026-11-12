// Persistance des mots horodatés d'un chapitrage local dans la table DÉDIÉE
// `media_words` : insertion, remplacement au second passage, insertion par lots,
// respect de l'absence de mots, et INVARIANT : `transcript_segments` reste vide.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { persistLocalChapters, WORDS_INSERT_BATCH, type LocalChaptersResult } from '../src/local-chapters.ts';
import { sqlite } from '../src/db/index.ts';

// Tables du schéma applicatif (hors `media_words`, créée automatiquement au
// démarrage) : même définition que les autres tests d'intégration.
sqlite.exec(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
  duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, media_path TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
  start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
sqlite.exec(`CREATE TABLE IF NOT EXISTS transcript_segments (id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL, start_sec REAL NOT NULL, end_sec REAL NOT NULL, text TEXT NOT NULL)`);

function result(videoId: string, words?: LocalChaptersResult['words']): LocalChaptersResult {
  return {
    videoId,
    title: 'Émission',
    durationSec: 600,
    mediaPath: 'C:/media/emission.mp3',
    segments: [],
    words,
    chapters: [{ startSec: 0, title: 'Intro' }],
    text: '',
    warnings: [],
  };
}

const rowsFor = (videoId: string) =>
  sqlite
    .prepare('SELECT start_ms, end_ms, text FROM media_words WHERE video_id = ? ORDER BY start_ms')
    .all(videoId) as { start_ms: number; end_ms: number; text: string }[];

const segmentCount = (videoId: string) =>
  (sqlite.prepare('SELECT count(*) AS n FROM transcript_segments WHERE video_id = ?').get(videoId) as { n: number }).n;

test('les mots sont insérés avec millisecondes et texte', () => {
  const id = 'local:persistwords01';
  persistLocalChapters(
    result(id, [
      { word: 'Bonjour', startSec: 0, endSec: 0.42 },
      { word: 'tout', startSec: 0.5, endSec: 0.82 },
      { word: 'le', startSec: 0.9, endSec: 1.0 },
    ]),
  );
  assert.deepEqual(rowsFor(id), [
    { start_ms: 0, end_ms: 420, text: 'Bonjour' },
    { start_ms: 500, end_ms: 820, text: 'tout' },
    { start_ms: 900, end_ms: 1000, text: 'le' },
  ]);
});

test('un second passage REMPLACE les mots (aucun doublon)', () => {
  const id = 'local:persistwords02';
  persistLocalChapters(result(id, [{ word: 'ancien', startSec: 1, endSec: 2 }]));
  persistLocalChapters(result(id, [{ word: 'nouveau', startSec: 3, endSec: 4 }]));
  assert.deepEqual(rowsFor(id), [{ start_ms: 3000, end_ms: 4000, text: 'nouveau' }]);
});

test('les mots sont insérés PAR LOTS (aucune insertion unitaire)', () => {
  const id = 'local:persistwords03';
  const total = WORDS_INSERT_BATCH * 2 + 7;
  const words = Array.from({ length: total }, (_, i) => ({
    word: 'mot' + i,
    startSec: i * 0.2,
    endSec: i * 0.2 + 0.15,
  }));
  persistLocalChapters(result(id, words));
  const rows = rowsFor(id);
  assert.equal(rows.length, total, 'tous les mots présents');
  assert.equal(rows[0].text, 'mot0');
  assert.equal(rows[total - 1].text, 'mot' + (total - 1));
  assert.deepEqual(
    rows.map((r) => r.start_ms),
    Array.from({ length: total }, (_, i) => Math.round(i * 0.2 * 1000)),
  );
});

test('sans mots, les anciens mots ne sont ni effacés ni écrasés', () => {
  const id = 'local:persistwords04';
  persistLocalChapters(result(id, [{ word: 'gardé', startSec: 5, endSec: 6 }]));

  // Champ absent…
  persistLocalChapters(result(id, undefined));
  assert.deepEqual(rowsFor(id), [{ start_ms: 5000, end_ms: 6000, text: 'gardé' }]);

  // … ou tableau vide.
  persistLocalChapters(result(id, []));
  assert.deepEqual(rowsFor(id), [{ start_ms: 5000, end_ms: 6000, text: 'gardé' }]);
});

test('INVARIANT : `transcript_segments` reste vide après persistance des mots', () => {
  const id = 'local:persistwords05';
  persistLocalChapters(
    result(id, [
      { word: 'un', startSec: 0, endSec: 0.3 },
      { word: 'deux', startSec: 0.4, endSec: 0.7 },
    ]),
  );
  assert.ok(rowsFor(id).length === 2, 'les mots sont bien écrits dans media_words');
  assert.equal(segmentCount(id), 0, 'transcript_segments reste vide');
});
