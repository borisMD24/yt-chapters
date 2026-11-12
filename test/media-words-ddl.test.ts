// Auto-réparation de la table `media_words` : un `db:push` oublié ne doit pas
// casser la lecture des mots horodatés ni l'éditeur de bornes. On vérifie la
// création sur une base NEUVE et une base EXISTANTE, le schéma conforme, l'index,
// l'idempotence, la FORME CANONIQUE Drizzle (sinon `db:push` reconstruit la table
// et échoue sur l'index) et le classement des erreurs « table indisponible ».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import {
  ensureMediaWordsTable,
  isMediaWordsUnavailable,
  MEDIA_WORDS_DDL,
} from '../src/db/media-words.ts';

function makeDb(withVideos: boolean): InstanceType<typeof Database> {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-mwords-'));
  const raw = new Database(join(dir, 'ddl.db'));
  if (withVideos) {
    raw.exec('CREATE TABLE videos (id TEXT PRIMARY KEY, title TEXT NOT NULL)');
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
      ['id', 'video_id', 'start_ms', 'end_ms', 'text'],
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

test('la contrainte de clé étrangère est une CONTRAINTE DE TABLE (forme Drizzle)', () => {
  // Une clé étrangère « en ligne » (sur la colonne) est introspectée différemment
  // par Drizzle : `db:push` reconstruisait alors `media_words` et échouait.
  const raw = makeDb(true);
  try {
    ensureMediaWordsTable(raw);
    const normalized = MEDIA_WORDS_DDL.replace(/\s+/g, ' ').trim();
    assert.match(normalized, /video_id text NOT NULL, start_ms integer NOT NULL/);
    assert.match(
      normalized,
      /FOREIGN KEY \(video_id\) REFERENCES videos\(id\) ON UPDATE no action ON DELETE cascade/,
    );
    assert.ok(!/REFERENCES videos\(id\) ON DELETE cascade,/.test(normalized), 'pas de FK en ligne');
  } finally {
    raw.close();
  }
});

test('isMediaWordsUnavailable : table/colonne de media_words oui, autre erreur non', () => {
  assert.equal(isMediaWordsUnavailable(new Error('no such table: media_words')), true);
  assert.equal(isMediaWordsUnavailable(new Error('no such column: start_ms')), true);
  assert.equal(isMediaWordsUnavailable(new Error('disk I/O error')), false);
  assert.equal(isMediaWordsUnavailable(new Error('no such table: videos')), false);
});

/**
 * Verrou d'intégration : après que l'application a posé le DDL auto-réparateur,
 * `drizzle-kit push` ne doit voir AUCUN changement. Avant le correctif, il
 * reconstruisait la table et sortait en 1 (`index media_words_video_idx already
 * exists`). On utilise le binaire local (jamais `npx`) : hors ligne et rapide.
 */
test('db:push ne détecte aucun changement après le DDL applicatif de media_words', () => {
  const cwd = process.cwd();
  const bin = join(cwd, 'node_modules', 'drizzle-kit', 'bin.cjs');
  const dir = mkdtempSync(join(tmpdir(), 'ckr-push-'));
  const dbPath = join(dir, 'push.db');
  const runPush = () => {
    const r = spawnSync(process.execPath, [bin, 'push'], {
      cwd,
      env: { ...process.env, DB_PATH: dbPath },
      encoding: 'utf8',
    });
    return { status: r.status, out: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
  };
  try {
    // 1) Schéma complet créé par Drizzle.
    const first = runPush();
    assert.equal(first.status, 0, first.out);

    // 2) La table est recréée par le DDL auto-réparateur de l'application.
    const raw = new Database(dbPath);
    raw.exec('DROP TABLE media_words');
    assert.equal(ensureMediaWordsTable(raw), true);
    raw.close();

    // 3) `db:push` ne doit plus rien voir à changer.
    const second = runPush();
    assert.equal(second.status, 0, second.out);
    assert.match(second.out, /No changes detected/i, second.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
