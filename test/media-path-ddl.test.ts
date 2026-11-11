// Auto-réparation de la colonne `media_path` sur la table `videos` : un
// `db:push` oublié ne doit pas casser l'éditeur ni la route média.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { ensureVideosMediaPathColumn } from '../src/db/media-path.ts';

function makeDb(withTable: boolean): InstanceType<typeof Database> {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-ddl-'));
  const raw = new Database(join(dir, 'ddl.db'));
  if (withTable) {
    raw.exec('CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
  }
  return raw;
}

test('la colonne media_path est ajoutée si elle manque, puis l’appel est idempotent', () => {
  const raw = makeDb(true);
  try {
    assert.equal(ensureVideosMediaPathColumn(raw), true);
    const cols = raw.prepare('PRAGMA table_info(videos)').all() as { name: string }[];
    assert.ok(cols.some((c) => c.name === 'media_path'), 'colonne présente après réparation');
    // Deuxième appel : ne doit rien casser.
    assert.equal(ensureVideosMediaPathColumn(raw), true);
    const again = raw.prepare('PRAGMA table_info(videos)').all() as { name: string }[];
    assert.equal(again.filter((c) => c.name === 'media_path').length, 1, 'pas de doublon');

    // La colonne est bien utilisable (nullable).
    raw.prepare('INSERT INTO videos (id, title, media_path) VALUES (?, ?, ?)').run('local:x', 't', 'C:/m/a.mp3');
    const row = raw.prepare('SELECT media_path FROM videos WHERE id = ?').get('local:x') as { media_path: string };
    assert.equal(row.media_path, 'C:/m/a.mp3');
  } finally {
    raw.close();
  }
});

test('sans table videos, la réparation échoue proprement (jamais d’exception)', () => {
  const raw = makeDb(false);
  try {
    assert.equal(ensureVideosMediaPathColumn(raw), false);
  } finally {
    raw.close();
  }
});
