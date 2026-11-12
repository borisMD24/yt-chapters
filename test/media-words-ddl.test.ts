// Auto-réparation de la table `media_words` : un `db:push` oublié ne doit pas
// casser la lecture des mots horodatés ni l'éditeur de bornes. On vérifie la
// création sur une base NEUVE et sur une base EXISTANTE sans la table, le
// schéma conforme, l'index et l'idempotence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureMediaWordsTable, MEDIA_WORDS_DDL } from '../src/db/media-words.ts';

function makeDb(withVideos: boolean): InstanceType<typeof Database> {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-mwords-'));
  const raw = new Database(join(dir, 'ddl.db'));
  if (withVideos) {
    raw.exec("CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL)");
  }
  return raw;
}

type Column = { name: string; type: string; notnull: number; pk: number };

test('la table media_words est créée sur une base NEUVE', () => {
  const raw = makeDb(false);
  try {
    assert.equal(ensureMediaWordsTable(raw), true);
    const cols = raw.prepare('PRAGMA table_info(media_words)').all() as Column[];
    assert.deepEqual(
      cols.map((c) => c.name),
      ['id', 'video_id', 'idx', 'start_ms', 'end_ms', 'text'],
    );
  } finally {
    raw.close();
  }
});

test('la table media_words est créée sur une base EXISTANTE sans elle', () => {
  const raw = makeDb(true);
  try {
    assert.equal(ensureMediaWordsTable(raw), true);
    const tables = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    assert.ok(tables.some((t) => t.name === 'media_words'));
  } finally {
    raw.close();
  }
});

test('schéma conforme : colonnes typées, clés et index sur (video_id, start_ms)', () => {
  const raw = makeDb(true);
  try {
    ensureMediaWordsTable(raw);
    const cols = raw.prepare('PRAGMA table_info(media_words)').all() as Column[];
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    assert.equal(byName.id.pk, 1, 'id est la clé primaire');
    assert.equal(byName.video_id.type, 'TEXT');
    assert.equal(byName.video_id.notnull, 1);
    assert.equal(byName.idx.type, 'INTEGER');
    assert.equal(byName.idx.notnull, 1);
    assert.equal(byName.start_ms.type, 'INTEGER');
    assert.equal(byName.start_ms.notnull, 1);
    assert.equal(byName.end_ms.type, 'INTEGER');
    assert.equal(byName.end_ms.notnull, 1);
    assert.equal(byName.text.type, 'TEXT');
    assert.equal(byName.text.notnull, 1);

    // Index attendu, posé sur (video_id, start_ms) dans cet ordre.
    const idx = raw.prepare('PRAGMA index_info(media_words_video_idx)').all() as {
      seqno: number;
      name: string;
    }[];
    assert.deepEqual(
      idx.sort((a, b) => a.seqno - b.seqno).map((i) => i.name),
      ['video_id', 'start_ms'],
    );
  } finally {
    raw.close();
  }
});

test('l’appel est idempotent (pas de doublon de table ni d’index)', () => {
  const raw = makeDb(true);
  try {
    ensureMediaWordsTable(raw);
    assert.equal(ensureMediaWordsTable(raw), true);
    const idx = raw
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'media_words_video_idx'")
      .all() as { name: string }[];
    assert.equal(idx.length, 1, 'un seul index');
  } finally {
    raw.close();
  }
});

test('le DDL déclaré est idempotent (CREATE TABLE IF NOT EXISTS)', () => {
  assert.match(MEDIA_WORDS_DDL, /CREATE TABLE IF NOT EXISTS media_words/);
});
