// Envoi de fichier : assainissement du nom, écriture en flux dans un CACHE
// borné, empreinte de contenu. Aucune dépendance, aucun tampon intermédiaire :
// le flux de la requête est écrit au fur et à mesure.
//
// Contrat de rétention (remplace l'ancien « supprimé dès l'état terminal ») :
//  - le fichier reçu est écrit sous un nom TEMPORAIRE *dans* le dossier de cache,
//    puis renommé en `<sha1>.<ext>` une fois l'empreinte connue ;
//  - un second envoi des mêmes octets est un no-op (même identifiant `local:up-…`) ;
//  - le fichier est conservé `UPLOAD_RETENTION_DAYS` jours (7 par défaut), ce qui
//    permet d'ouvrir l'éditeur de bornes (`/edit`) et de réécouter les passages
//    sans réenvoyer le média ;
//  - il est supprimé au démarrage suivant (et opportunément) au-delà de cet âge,
//    ou immédiatement depuis l'administration (« Vider le cache »).
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { MEDIA_UNREADABLE_MESSAGE } from './media-check';

/** Préfixe des dossiers temporaires d'envoi (héritage : balayage de démarrage). */
export const UPLOAD_DIR_PREFIX = 'ckr-upload-';

/** Préfixe des fichiers TEMPORAIRES d'un envoi en cours (dans le cache). */
export const UPLOAD_TEMP_PREFIX = 'ckr-part-';

/**
 * Préfixe d'empreinte accepté pour un identifiant d'envoi : 12 à 40 caractères
 * hexadécimaux. Un préfixe plus court rendrait le cache énumérable.
 */
const CACHE_HASH_PREFIX = /^[0-9a-f]{12,40}$/i;

/** Extensions de médias acceptées (mêmes règles que la liste MEDIA_DIR). */
export const MEDIA_EXTENSIONS = [
  '.mp3',
  '.m4a',
  '.wav',
  '.flac',
  '.ogg',
  '.opus',
  '.aac',
  '.mp4',
  '.mkv',
  '.mov',
  '.webm',
  '.avi',
] as const;

const MEDIA_EXT_SET = new Set<string>(MEDIA_EXTENSIONS);
const EXTENSIONS_LISIBLES = MEDIA_EXTENSIONS.map((e) => e.slice(1)).join(', ');

/** Rétention par défaut du cache d'envoi (jours). */
export const DEFAULT_UPLOAD_RETENTION_DAYS = 7;

/** Âge au-delà duquel un envoi INCOMPLET (fichier temporaire) est abandonné. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Erreur d'envoi portant le code HTTP à renvoyer au navigateur. */
export class UploadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'UploadError';
  }
}

/**
 * Réduit un nom envoyé par le navigateur à un nom de fichier sûr :
 * nom de base uniquement (aucun séparateur, donc aucune évasion hors du
 * dossier temporaire), sans caractères de contrôle ni caractères réservés
 * Windows, et d'une longueur compatible avec un nom de fichier (255). Renvoie
 * `null` si rien d'exploitable ne reste.
 */
export function sanitizeUploadName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  // Au-delà de la limite d'un nom de fichier (255), le nom est refusé net : le
  // fichier du cache porte l'empreinte du contenu, pas ce nom, mais accepter un
  // nom impossible à écrire ailleurs serait trompeur.
  if (cleaned.length > 255) return null;
  return cleaned;
}

/** Vrai si l'extension fait partie des médias acceptés. */
export function isAllowedMediaName(name: string): boolean {
  return MEDIA_EXT_SET.has(extname(name).toLowerCase());
}

// ---------- cache d'envoi ----------

/** Dossier du cache d'envoi : `UPLOAD_CACHE_DIR` sinon `data/uploads` du projet. */
export function uploadCacheDir(): string {
  const fromEnv = process.env.UPLOAD_CACHE_DIR;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return resolve(process.cwd(), 'data', 'uploads');
}

/** Rétention du cache en jours (`UPLOAD_RETENTION_DAYS`, défaut 7 ; jamais ≤ 0). */
export function uploadRetentionDays(): number {
  const raw = process.env.UPLOAD_RETENTION_DAYS;
  const parsed = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPLOAD_RETENTION_DAYS;
}

/** Rétention du cache en millisecondes. */
export function uploadRetentionMs(): number {
  return uploadRetentionDays() * 24 * 60 * 60 * 1000;
}

export type CacheStats = { dir: string; files: number; bytes: number };

/** Nombre de fichiers et taille totale du cache. */
export async function uploadCacheStats(dir: string = uploadCacheDir()): Promise<CacheStats> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { dir, files: 0, bytes: 0 };
  }
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    try {
      bytes += (await stat(join(dir, entry.name))).size;
      files++;
    } catch {
      /* entrée disparue entre-temps : on l'ignore */
    }
  }
  return { dir, files, bytes };
}

/**
 * Balayage du cache : supprime les fichiers plus vieux que la rétention, ainsi
 * que les fichiers temporaires d'un envoi interrompu (plus d'une heure). Ne
 * touche jamais à un fichier récent. Ne jette jamais.
 */
export async function sweepUploadCache(
  opts: { maxAgeMs?: number; now?: number } = {},
): Promise<{ removed: number; bytes: number }> {
  const dir = uploadCacheDir();
  const maxAgeMs = opts.maxAgeMs ?? uploadRetentionMs();
  const now = opts.now ?? Date.now();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, bytes: 0 };
  }
  let removed = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = join(dir, entry.name);
    try {
      const info = await stat(full);
      const staleTemp = entry.name.startsWith(UPLOAD_TEMP_PREFIX) && now - info.mtimeMs >= STALE_TEMP_MS;
      const expired = now - info.mtimeMs >= maxAgeMs;
      if (!staleTemp && !expired) continue;
      await rm(full, { force: true });
      removed++;
      bytes += info.size;
    } catch {
      /* fichier disparu ou verrouillé : on réessaiera */
    }
  }
  return { removed, bytes };
}

/** Vide le cache (fichiers uniquement, le dossier est conservé) et chiffre l'opération. */
export async function clearUploadCache(): Promise<{ before: CacheStats; after: CacheStats }> {
  const dir = uploadCacheDir();
  const before = await uploadCacheStats(dir);
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { before, after: { dir, files: 0, bytes: 0 } };
  }
  for (const entry of entries) {
    try {
      await rm(join(dir, entry.name), { recursive: true, force: true });
    } catch {
      /* verrouillé : le prochain balayage reprendra la main */
    }
  }
  const after = await uploadCacheStats(dir);
  return { before, after };
}

/**
 * Retrouve un fichier du cache à partir d'un préfixe d'empreinte (identifiant
 * `local:up-<12 hex>`), sans connaître l'extension. `null` si rien ne correspond.
 *
 * Le préfixe doit faire **12 à 40** caractères hexadécimaux : un préfixe plus
 * court rendrait le cache énumérable (un seul caractère suffisait à retrouver un
 * envoi). Les fichiers TEMPORAIRES (`ckr-part-*`) ne sont jamais servis : ils
 * sont écartés explicitement (et « c » n'est pas suivi d'hexadécimal).
 */
export async function findCacheFileByHash(prefix: string): Promise<string | null> {
  if (!CACHE_HASH_PREFIX.test(prefix)) return null;
  const dir = uploadCacheDir();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const lower = prefix.toLowerCase();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(UPLOAD_TEMP_PREFIX)) continue; // envoi incomplet
    if (!isAllowedMediaName(entry.name)) continue;
    if (!entry.name.toLowerCase().startsWith(lower)) continue;
    return join(dir, entry.name);
  }
  return null;
}

// ---------- écriture d'un envoi ----------

export type SavedUpload = {
  /** Chemin absolu du fichier mis en cache (`<sha1>.<ext>`). */
  path: string;
  bytes: number;
  /** Empreinte du contenu (sha1) : identifiant stable entre deux envois identiques. */
  sha1: string;
  /** Extension (en minuscules, avec le point). */
  ext: string;
  /** Vrai si ces octets étaient déjà en cache (aucune écriture définitive). */
  deduplicated: boolean;
};

/**
 * Écrit `stream` dans le cache d'envoi sous un nom temporaire, puis le renomme
 * en `<sha1>.<ext>`. En cas de dépassement, d'erreur ou d'envoi vide, aucun
 * fichier ne subsiste. Un second envoi identique est un no-op.
 */
export async function saveUpload(
  stream: Readable,
  opts: { filename: string; maxBytes: number },
): Promise<SavedUpload> {
  const safeName = sanitizeUploadName(opts.filename);
  if (!safeName) {
    throw new UploadError('Le nom du fichier est invalide. Renommez-le, puis réessayez.', 400);
  }
  if (!isAllowedMediaName(safeName)) {
    throw new UploadError(`Ce format de fichier n'est pas pris en charge. Formats acceptés : ${EXTENSIONS_LISIBLES}.`, 415);
  }

  const dir = uploadCacheDir();
  await mkdir(dir, { recursive: true });
  const ext = extname(safeName).toLowerCase();
  const temp = join(dir, `${UPLOAD_TEMP_PREFIX}${randomUUID()}${ext}`);

  try {
    const hash = createHash('sha1');
    let bytes = 0;
    let position = 0;
    const handle = await open(temp, 'wx');
    try {
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        bytes += buf.length;
        if (bytes > opts.maxBytes) {
          throw new UploadError(
            `Ce fichier est trop volumineux (limite : ${Math.round(opts.maxBytes / (1024 * 1024))} Mo).`,
            413,
          );
        }
        hash.update(buf);
        await handle.write(buf, 0, buf.length, position);
        position += buf.length;
      }
    } finally {
      await handle.close();
    }

    if (bytes === 0) {
      // Un fichier vide (envoi interrompu, fichier fantôme) ne produira rien :
      // refus immédiat, et rien n'est conservé dans le cache.
      throw new UploadError(MEDIA_UNREADABLE_MESSAGE, 400);
    }

    const sha1 = hash.digest('hex');
    const finalPath = join(dir, `${sha1}${ext}`);
    // Déduplication : ces octets exacts sont-ils déjà en cache ? Le nom étant
    // l'empreinte du contenu, la cible ne peut être qu'identique. Seul un
    // FICHIER compte : un dossier homonyme ne doit pas passer pour un envoi.
    if (await isFile(finalPath)) {
      await rm(temp, { force: true });
      return { path: finalPath, bytes, sha1, ext, deduplicated: true };
    }
    try {
      await rename(temp, finalPath);
    } catch (err) {
      // Course avec un envoi identique : le fichier est apparu entre le test
      // ci-dessus et le rename. On renvoie le résultat DÉDUPLIQUÉ (jamais
      // l'erreur de fichier, qui serait un faux « nom trop long ou invalide »).
      if (await isFile(finalPath)) {
        await rm(temp, { force: true });
        return { path: finalPath, bytes, sha1, ext, deduplicated: true };
      }
      throw err;
    }
    return { path: finalPath, bytes, sha1, ext, deduplicated: false };
  } catch (err) {
    await rm(temp, { force: true }).catch(() => {});
    if (err instanceof UploadError) throw err;
    // Erreurs du système de fichiers (nom trop long, disque plein…) : réponse 400
    // en français, jamais le message brut (qui contient le chemin).
    if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
      throw new UploadError('Le nom du fichier est trop long ou invalide. Renommez-le, puis réessayez.', 400);
    }
    throw err;
  }
}

/** Vrai si un nom de fichier est un envoi INCOMPLET du cache (jamais servable). */
export function isPartialUploadName(name: string): boolean {
  return name.startsWith(UPLOAD_TEMP_PREFIX);
}

/** Vrai si le chemin est un FICHIER régulier (un dossier ne compte pas). */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// ---------- héritage : dossiers temporaires d'anciens envois ----------

/**
 * Age d'un dossier d'envoi : on prend la date de modification la PLUS RÉCENTE
 * entre le dossier et tous ses fichiers (écrire dans un fichier existant ne
 * change pas la date du dossier : s'y fier seul ferait supprimer un envoi en
 * cours par un second serveur démarré plus tard).
 */
async function newestMtimeMs(dir: string): Promise<number> {
  let newest: number;
  try {
    newest = (await stat(dir)).mtimeMs;
  } catch {
    return 0;
  }
  try {
    for (const entry of await readdir(dir)) {
      try {
        newest = Math.max(newest, (await stat(join(dir, entry))).mtimeMs);
      } catch {
        /* entrée disparue pendant le parcours : on l'ignore */
      }
    }
  } catch {
    /* dossier illisible : on se contente de sa propre date */
  }
  return newest;
}

/**
 * Nettoie les dossiers d'envoi `ckr-upload-*` laissés dans le dossier temporaire
 * par une version antérieure (ou un arrêt brutal). Ne touche qu'aux dossiers
 * dont l'activité la plus récente est plus vieille que `maxAgeMs` (1 h) : un
 * serveur concurrent, ou un envoi en cours, est donc toujours épargné.
 * Renvoie le nombre de dossiers supprimés.
 */
export async function sweepStaleUploads(maxAgeMs = 60 * 60 * 1000): Promise<number> {
  const dir = tmpdir();
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const now = Date.now();
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(UPLOAD_DIR_PREFIX)) continue;
    const full = join(dir, entry.name);
    try {
      if (now - (await newestMtimeMs(full)) < maxAgeMs) continue; // encore actif
      await rm(full, { recursive: true, force: true });
      removed++;
    } catch {
      /* dossier disparu ou verrouillé : on réessaiera au prochain démarrage */
    }
  }
  return removed;
}
