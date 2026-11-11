// Tests du cache d'envoi borné : nom dérivé de l'empreinte du contenu,
// déduplication, rétention (balayage), statistiques et vidage.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import {
  DEFAULT_UPLOAD_RETENTION_DAYS,
  UPLOAD_TEMP_PREFIX,
  clearUploadCache,
  findCacheFileByHash,
  sanitizeUploadName,
  saveUpload,
  sweepUploadCache,
  uploadCacheDir,
  uploadCacheStats,
  uploadRetentionDays,
  uploadRetentionMs,
} from '../src/upload.ts';

/** Cache isolé et propre par test (UPLOAD_CACHE_DIR relu à chaque appel). */
function freshCache(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ckr-cache-'));
  process.env.UPLOAD_CACHE_DIR = dir;
  return dir;
}

const sha1 = (buf: Buffer) => createHash('sha1').update(buf).digest('hex');

test('le nom du fichier mis en cache est l’empreinte du contenu + extension', async () => {
  const dir = freshCache();
  const payload = Buffer.from('contenu du reportage');
  const saved = await saveUpload(Readable.from([payload]), { filename: 'reportage final.mp3', maxBytes: 1e6 });

  assert.equal(saved.sha1, sha1(payload));
  assert.equal(saved.ext, '.mp3');
  assert.equal(saved.path, join(dir, `${sha1(payload)}.mp3`));
  assert.equal(saved.bytes, payload.length);
  assert.equal(saved.deduplicated, false);
  assert.deepEqual(readdirSync(dir), [`${sha1(payload)}.mp3`], 'un seul fichier, nommé par son empreinte');
});

test('un second envoi identique ne duplique rien et ne corrompt pas le fichier', async () => {
  const dir = freshCache();
  const payload = Buffer.from('mêmes octets exactement');

  const first = await saveUpload(Readable.from([payload]), { filename: 'clip.mp3', maxBytes: 1e6 });
  const second = await saveUpload(Readable.from([payload]), { filename: 'clip.mp3', maxBytes: 1e6 });

  assert.equal(readdirSync(dir).length, 1, 'aucun doublon');
  assert.equal(second.path, first.path);
  assert.equal(second.deduplicated, true);
  assert.equal(statSync(second.path).size, payload.length, 'contenu intact');
});

test('deux contenus différents coexistent (extensions différentes comprises)', async () => {
  const dir = freshCache();
  await saveUpload(Readable.from([Buffer.from('aaa')]), { filename: 'a.mp3', maxBytes: 1e6 });
  await saveUpload(Readable.from([Buffer.from('bbb')]), { filename: 'b.m4a', maxBytes: 1e6 });
  const names = readdirSync(dir).sort();
  assert.equal(names.length, 2);
  assert.ok(names[0].endsWith('.m4a') || names[0].endsWith('.mp3'));
});

test('le balayage ne supprime QUE les entrées plus vieilles que la rétention', async () => {
  const dir = freshCache();
  const old = join(dir, 'a'.repeat(40) + '.mp3');
  const fresh = join(dir, 'b'.repeat(40) + '.mp3');
  writeFileSync(old, 'vieux');
  writeFileSync(fresh, 'neuf');
  const longAgo = new Date(Date.now() - (DEFAULT_UPLOAD_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000);
  utimesSync(old, longAgo, longAgo);

  const res = await sweepUploadCache();
  assert.equal(res.removed, 1);
  assert.deepEqual(readdirSync(dir), [fresh.split(/[\\/]/).pop()], 'seule l’entrée périmée est supprimée');
});

test('le balayage supprime aussi un fichier temporaire abandonné (envoi interrompu)', async () => {
  const dir = freshCache();
  const temp = join(dir, `${UPLOAD_TEMP_PREFIX}${randomUUID()}.mp3`);
  writeFileSync(temp, 'partiel');
  const longAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  utimesSync(temp, longAgo, longAgo);

  await sweepUploadCache();
  assert.deepEqual(readdirSync(dir), []);
});

test('« vider le cache » renvoie les chiffres avant/après et vide le dossier', async () => {
  const dir = freshCache();
  await saveUpload(Readable.from([Buffer.alloc(1000, 1)]), { filename: 'a.mp3', maxBytes: 1e6 });
  await saveUpload(Readable.from([Buffer.alloc(2000, 2)]), { filename: 'b.mp3', maxBytes: 1e6 });

  const before = await uploadCacheStats();
  assert.equal(before.files, 2);
  assert.equal(before.bytes, 3000);

  const cleared = await clearUploadCache();
  assert.equal(cleared.before.files, 2);

  const after = await uploadCacheStats();
  assert.equal(after.files, 0);
  assert.equal(after.bytes, 0);
  assert.deepEqual(readdirSync(dir), []);
});

test('un identifiant d’envoi retrouve le fichier du cache par préfixe d’empreinte', async () => {
  freshCache();
  const payload = Buffer.from('retrouve-moi');
  const saved = await saveUpload(Readable.from([payload]), { filename: 'x.mp3', maxBytes: 1e6 });

  const found = await findCacheFileByHash(saved.sha1.slice(0, 12));
  assert.equal(found, saved.path);
  assert.equal(await findCacheFileByHash(saved.sha1), saved.path, 'empreinte complète acceptée');
  assert.equal(await findCacheFileByHash('000000000000'), null);
});

test('findCacheFileByHash exige 12 à 40 caractères hexadécimaux (pas d’énumération)', async () => {
  freshCache();
  const payload = Buffer.from('prefixe strict');
  const saved = await saveUpload(Readable.from([payload]), { filename: 'x.mp3', maxBytes: 1e6 });

  // Trop court : un seul caractère suffisait à retrouver un envoi.
  for (const len of [1, 2, 6, 11]) {
    assert.equal(await findCacheFileByHash(saved.sha1.slice(0, len)), null, `préfixe de ${len} refusé`);
  }
  // Non hexadécimal, trop long, ou vide.
  assert.equal(await findCacheFileByHash('zzzzzzzzzzzz'), null);
  assert.equal(await findCacheFileByHash(saved.sha1 + 'a'), null);
  assert.equal(await findCacheFileByHash(''), null);
  // Bornes acceptées.
  assert.equal(await findCacheFileByHash(saved.sha1.slice(0, 12)), saved.path);
  assert.equal(await findCacheFileByHash(saved.sha1.slice(0, 40)), saved.path);
});

test('findCacheFileByHash ne renvoie jamais un fichier TEMPORAIRE (ckr-part-*)', async () => {
  const dir = freshCache();
  const payload = Buffer.from('temporaire interdit');
  const sha = createHash('sha1').update(payload).digest('hex');
  writeFileSync(join(dir, `${UPLOAD_TEMP_PREFIX}${sha}.mp3`), payload);

  assert.equal(await findCacheFileByHash(sha), null, 'un temporaire n’est pas atteint par l’empreinte');
  assert.equal(await findCacheFileByHash(`${UPLOAD_TEMP_PREFIX}${sha}`.slice(0, 12)), null);
  // L'empreinte seule (12 hex) ne doit pas non plus attraper ce nom.
  assert.equal(await findCacheFileByHash(`${UPLOAD_TEMP_PREFIX}${sha}`.slice(0, 12)), null);
});

test('dépassement du plafond : 413 et aucun résidu dans le cache', async () => {
  const dir = freshCache();
  await assert.rejects(
    () => saveUpload(Readable.from([Buffer.alloc(8192, 6)]), { filename: 'gros.mp3', maxBytes: 1024 }),
    (err: { status?: number }) => err.status === 413,
  );
  assert.deepEqual(readdirSync(dir), [], 'aucun fichier temporaire ni définitif');
});

test('envoi vide : refusé sans rien laisser dans le cache', async () => {
  const dir = freshCache();
  await assert.rejects(
    () => saveUpload(Readable.from([Buffer.alloc(0)]), { filename: 'vide.mp3', maxBytes: 1e6 }),
    (err: { status?: number }) => err.status === 400,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('extension non média : 415 sans rien écrire', async () => {
  const dir = freshCache();
  await assert.rejects(
    () => saveUpload(Readable.from([Buffer.from('x')]), { filename: 'notes.txt', maxBytes: 1e6 }),
    (err: { status?: number }) => err.status === 415,
  );
  assert.deepEqual(readdirSync(dir), []);
});

test('deux envois identiques SIMULTANÉS aboutissent tous les deux (déduplication)', async () => {
  const dir = freshCache();
  const payload = Buffer.from('concurrence sur des octets identiques');
  const [a, b] = await Promise.all([
    saveUpload(Readable.from([payload]), { filename: 'x.mp3', maxBytes: 1e6 }),
    saveUpload(Readable.from([payload]), { filename: 'x.mp3', maxBytes: 1e6 }),
  ]);
  assert.equal(a.path, b.path, 'même fichier de cache');
  assert.equal(a.sha1, b.sha1);
  assert.deepEqual(readdirSync(dir), [`${a.sha1}.mp3`], 'un seul fichier, aucun temporaire');
  assert.equal(statSync(a.path).size, payload.length, 'contenu intact');
});

test('un DOSSIER occupant le nom du cache échoue proprement (jamais de faux « dédupliqué »)', async () => {
  const dir = freshCache();
  const payload = Buffer.from('nom de cache occupe par un dossier');
  const sha = createHash('sha1').update(payload).digest('hex');
  mkdirSync(join(dir, `${sha}.mp3`)); // dossier, pas un fichier

  await assert.rejects(
    () => saveUpload(Readable.from([payload]), { filename: 'x.mp3', maxBytes: 1e6 }),
    (err: { status?: number }) => err.status === 400,
    'un dossier occupant le nom ne doit pas être annoncé comme un envoi réussi',
  );
  assert.deepEqual(readdirSync(dir), [`${sha}.mp3`], 'aucun fichier temporaire laissé');
});

test('sanitizeUploadName : 255 caractères acceptés, 256 refusés', async () => {
  const name255 = 'a'.repeat(251) + '.mp3'; // 255 caractères
  const name256 = 'a'.repeat(252) + '.mp3'; // 256 caractères
  assert.equal(sanitizeUploadName(name255), name255);
  assert.equal(sanitizeUploadName(name256), null);

  const dir = freshCache();
  const payload = Buffer.from('nom long accepte');
  const ok = await saveUpload(Readable.from([payload]), { filename: name255, maxBytes: 1e6 });
  assert.equal(ok.path, join(dir, `${createHash('sha1').update(payload).digest('hex')}.mp3`));
  await assert.rejects(
    () => saveUpload(Readable.from([Buffer.from('refuse')]), { filename: name256, maxBytes: 1e6 }),
    (err: { status?: number }) => err.status === 400,
  );
});

test('rétention par défaut : 7 jours, surchargeable et jamais absurde', () => {
  delete process.env.UPLOAD_RETENTION_DAYS;
  assert.equal(uploadRetentionDays(), 7);
  assert.equal(uploadRetentionMs(), 7 * 24 * 60 * 60 * 1000);
  process.env.UPLOAD_RETENTION_DAYS = '2';
  assert.equal(uploadRetentionDays(), 2);
  process.env.UPLOAD_RETENTION_DAYS = 'n’importe quoi';
  assert.equal(uploadRetentionDays(), 7);
  process.env.UPLOAD_RETENTION_DAYS = '0';
  assert.equal(uploadRetentionDays(), 7);
  delete process.env.UPLOAD_RETENTION_DAYS;
});

test('l’emplacement du cache suit UPLOAD_CACHE_DIR', () => {
  const dir = freshCache();
  assert.equal(uploadCacheDir(), dir);
  delete process.env.UPLOAD_CACHE_DIR;
  assert.equal(uploadCacheDir(), join(process.cwd(), 'data', 'uploads'));
});
