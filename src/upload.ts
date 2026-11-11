// Envoi de fichier : assainissement du nom, écriture en flux dans un dossier
// temporaire privé, empreinte de contenu. Aucune dépendance, aucun tampon
// intermédiaire : le flux de la requête est écrit au fur et à mesure.
import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';

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
 * Windows. Renvoie `null` si rien d'exploitable ne reste.
 */
export function sanitizeUploadName(raw: string): string | null {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[<>:"/\\|?*]/g, '')
    .trim()
    .replace(/[. ]+$/, '');
  if (!cleaned || cleaned === '.' || cleaned === '..') return null;
  return cleaned;
}

/** Vrai si l'extension fait partie des médias acceptés. */
export function isAllowedMediaName(name: string): boolean {
  return MEDIA_EXT_SET.has(extname(name).toLowerCase());
}

export type SavedUpload = {
  /** Chemin absolu du fichier temporaire. */
  path: string;
  /** Dossier temporaire privé à supprimer (idempotent). */
  dir: string;
  bytes: number;
  /** Empreinte du contenu (sha1) : identifiant stable entre deux envois identiques. */
  sha1: string;
  cleanup: () => Promise<void>;
};

/**
 * écrit `stream` dans un dossier temporaire privé en respectant `maxBytes`.
 * En cas de dépassement ou d'erreur, le dossier temporaire est supprimé.
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

  const dir = await mkdtemp(join(tmpdir(), 'ckr-upload-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  try {
    const target = join(dir, safeName);
    const hash = createHash('sha1');
    let bytes = 0;
    let position = 0;
    const handle = await open(target, 'wx');
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
    return { path: target, dir, bytes, sha1: hash.digest('hex'), cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
