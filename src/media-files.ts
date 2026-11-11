// Résolution sécurisée d'un identifiant média vers un fichier réel, et
// analyse d'un en-tête HTTP `Range`.
//
// Principe : le client ne fournit JAMAIS de chemin. Il fournit un identifiant
// (`local:up-<hash>` pour le cache d'envoi, `local:<sha1>` pour un fichier de
// MEDIA_DIR) ; le serveur retrouve le chemin (colonne `media_path` ou scan du
// cache), puis vérifie que ce chemin est bien un fichier média situé DANS l'une
// des racines autorisées. Toute autre situation est refusée par un message
// français, sans jamais révéler de chemin.
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve } from 'node:path';

/** Type MIME servi pour chaque extension média acceptée. */
export const MEDIA_MIME_TYPES: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aac': 'audio/aac',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
};

/** Message (français) : le média demandé n'est pas dans un dossier autorisé. */
export const MEDIA_FORBIDDEN_MESSAGE =
  "Ce média est en dehors des dossiers autorisés. L'accès a été refusé.";

/** Message (français) : le fichier est absent, déplacé ou n'est pas un fichier. */
export const MEDIA_NOT_FOUND_MESSAGE =
  'Ce média est introuvable : le fichier a peut-être été supprimé ou déplacé. Rechargez la liste.';

/** Type MIME d'une extension (`.mp3`, `.MP4`…) ; repli générique sinon. */
export function mediaContentType(ext: string): string {
  return MEDIA_MIME_TYPES[ext.toLowerCase()] ?? 'application/octet-stream';
}

/** Vrai si `target` (résolu) est un fichier situé dans `dir` (déjà résolu). */
export function isInsideDir(target: string, dir: string): boolean {
  const rel = relative(dir, target);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

export type MediaResolution =
  | { ok: true; path: string; ext: string; size: number }
  | { ok: false; status: 403 | 404; message: string };

/**
 * Vérifie qu'un chemin candidat est un média servable :
 *  - d'extension média reconnue (sinon 403) ;
 *  - réellement présent (sinon 404) ;
 *  - dont le chemin RÉEL (`realpath`, liens et jonctions résolus) est
 *    strictement à l'intérieur du chemin RÉEL de l'une des racines autorisées
 *    (sinon 403) — une jonction placée dans une racine et sortant de celle-ci
 *    est donc refusée, la comparaison n'étant pas seulement lexicale ;
 *  - et qui est un fichier régulier (sinon 404).
 * Le chemin renvoyé est le chemin réel, celui effectivement ouvert.
 */
export async function resolveMediaFile(candidate: string, roots: string[]): Promise<MediaResolution> {
  const target = resolve(candidate);
  const ext = extname(target).toLowerCase();
  if (!(ext in MEDIA_MIME_TYPES)) return { ok: false, status: 403, message: MEDIA_FORBIDDEN_MESSAGE };

  let realTarget: string;
  try {
    realTarget = await realpath(target);
  } catch {
    return { ok: false, status: 404, message: MEDIA_NOT_FOUND_MESSAGE };
  }

  // Chemin réel de chaque racine : une racine inexistante ne peut rien contenir.
  const realRoots = await Promise.all(roots.map((root) => realpath(resolve(root)).catch(() => null)));
  const allowed = realRoots.some((root) => root !== null && isInsideDir(realTarget, root));
  if (!allowed) return { ok: false, status: 403, message: MEDIA_FORBIDDEN_MESSAGE };

  let info;
  try {
    info = await stat(realTarget);
  } catch {
    return { ok: false, status: 404, message: MEDIA_NOT_FOUND_MESSAGE };
  }
  if (!info.isFile()) return { ok: false, status: 404, message: MEDIA_NOT_FOUND_MESSAGE };

  return { ok: true, path: realTarget, ext, size: info.size };
}

/** Résultat de l'analyse d'un en-tête `Range`. */
export type RangeResult =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Analyse un en-tête `Range` pour une réponse à UNE plage.
 *
 * Choix documentés :
 *  - plusieurs plages (`bytes=0-1,5-6`) ou une syntaxe non reconnue sont
 *    IGNORÉES : on répond `200` avec le fichier entier (jamais de multipart) ;
 *  - une plage hors du fichier (début au-delà de la taille, suffixe nul) est
 *    `unsatisfiable` → l'appelant répond `416` ;
 *  - un fichier vide ne peut satisfaire aucune plage : on sert l'entier.
 */
export function parseSingleRange(header: string | undefined, size: number): RangeResult {
  if (!header) return { kind: 'full' };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: 'full' };
  if (size <= 0) return { kind: 'full' };

  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return { kind: 'full' };

  if (rawStart === '') {
    // Suffixe : `bytes=-n` = les n derniers octets.
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    const start = Math.max(0, size - suffix);
    return { kind: 'partial', start, end: size - 1 };
  }

  const start = Number(rawStart);
  if (!Number.isFinite(start) || start >= size) return { kind: 'unsatisfiable' };
  if (rawEnd === '') return { kind: 'partial', start, end: size - 1 };

  const end = Number(rawEnd);
  if (!Number.isFinite(end) || end < start) return { kind: 'full' };
  return { kind: 'partial', start, end: Math.min(end, size - 1) };
}
