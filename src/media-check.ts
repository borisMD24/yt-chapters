// Contrôle d'un média AVANT tout découpage ffmpeg.
//
// Le découpage échouait jusqu'ici avec un message générique et la ligne de
// commande ffmpeg complète (chemins absolus compris) : l'utilisateur ne pouvait
// pas savoir si son fichier était muet, corrompu, ou si ffmpeg manquait. On
// interroge donc ffprobe une fois, avant de créer le moindre fichier temporaire,
// et on lève une erreur typée portant un message français actionnable.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat } from 'node:fs/promises';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };

/** Message : le média n'a aucune piste audio exploitable. */
export const MEDIA_NO_AUDIO_MESSAGE =
  "Ce fichier ne contient pas de piste audio. Le chapitrage a besoin du son : vérifiez que la vidéo n'est pas muette.";

/** Message : fichier vide, tronqué ou au format non reconnu. */
export const MEDIA_UNREADABLE_MESSAGE =
  'Ce fichier est illisible ou incomplet (téléchargement interrompu, ou format non reconnu). Rouvrez-le ou reconvertissez-le, puis réessayez.';

/** Message : ffmpeg/ffprobe absent de la machine. */
export const MEDIA_TOOLS_MISSING_MESSAGE =
  'ffmpeg est introuvable sur cet ordinateur. Installez-le (ou ajoutez-le au PATH), puis relancez le serveur.';

export type MediaCheckKind = 'no-audio' | 'unreadable' | 'missing-tools';

/** Erreur de contrôle média : `message` est destiné tel quel à l'utilisateur. */
export class MediaValidationError extends Error {
  constructor(
    readonly kind: MediaCheckKind,
    message: string,
  ) {
    super(message);
    this.name = 'MediaValidationError';
  }
}

export type MediaProbe = {
  /** Durée annoncée par ffprobe (0 si indéterminée). */
  durationSec: number;
  /** Vrai si le média contient au moins une piste audio. */
  hasAudio: boolean;
};

/** Interrogation d'un média (injectable pour les tests, sans ffprobe réel). */
export type MediaProbeRunner = (file: string) => Promise<MediaProbe>;

export type ToolName = 'ffmpeg' | 'ffprobe';
export type ToolStatus = { ok: boolean; version?: string };

/** Vérification de disponibilité d'un outil (injectable pour les tests). */
export type ToolChecker = (tool: ToolName) => Promise<ToolStatus>;

/** Vrai si l'erreur vient d'un binaire absent (`spawn ffmpeg ENOENT`). */
export function isToolMissingError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as NodeJS.ErrnoException;
  if (e.code === 'ENOENT') return true;
  return /\bENOENT\b/.test(e.message ?? '') && /\bspawn\b/.test(e.message ?? '');
}

/** ffprobe : présence d'une piste audio (`-select_streams a`) + durée du format. */
export const defaultMediaProbe: MediaProbeRunner = async (file) => {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=codec_type:format=duration', '-of', 'json', file],
    BIG,
  );
  const parsed = JSON.parse(String(stdout) || '{}') as {
    streams?: { codec_type?: string }[];
    format?: { duration?: string };
  };
  const hasAudio = (parsed.streams ?? []).some((s) => s.codec_type === 'audio');
  const duration = Number.parseFloat(String(parsed.format?.duration ?? ''));
  return { durationSec: Number.isFinite(duration) && duration > 0 ? duration : 0, hasAudio };
};

/** Sonde « piste vidéo présente » (injectable pour les tests). */
export type VideoProbeRunner = (file: string) => Promise<boolean>;

/**
 * ffprobe : le fichier contient-il au moins une piste VIDÉO ? Sert à choisir
 * `<video>` ou `<audio>` dans l'éditeur de bornes. Un échec (outil absent,
 * fichier illisible) répond `false` : le média reste écoutable en audio.
 */
export const defaultVideoProbe: VideoProbeRunner = async (file) => {
  const { stdout } = await run(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v', '-show_entries', 'stream=codec_type', '-of', 'json', file],
    BIG,
  );
  const parsed = JSON.parse(String(stdout) || '{}') as { streams?: { codec_type?: string }[] };
  return (parsed.streams ?? []).some((s) => s.codec_type === 'video');
};

/**
 * Vrai si le fichier porte une piste vidéo. Ne jette jamais : une sonde en
 * échec (ou un fichier absent) répond `false`.
 */
export async function probeHasVideo(
  file: string,
  opts: { probe?: VideoProbeRunner } = {},
): Promise<boolean> {
  const probe = opts.probe ?? defaultVideoProbe;
  try {
    await stat(file);
    return await probe(file);
  } catch {
    return false;
  }
}

/** `ffmpeg -version` / `ffprobe -version` : présence + version du premier segment. */
export const defaultToolChecker: ToolChecker = async (tool) => {
  try {
    const { stdout } = await run(tool, ['-version'], BIG);
    const firstLine = String(stdout).split(/\r?\n/, 1)[0];
    const version = /version\s+(\S+)/i.exec(firstLine)?.[1];
    return version ? { ok: true, version } : { ok: true };
  } catch (err) {
    if (isToolMissingError(err)) return { ok: false };
    // Binaire présent mais qui échoue : considéré comme indisponible.
    return { ok: false };
  }
};

/**
 * Vérifie qu'un fichier est exploitable AVANT découpage :
 *  - fichier absent, non régulier ou de 0 octet → « illisible » SANS lancer ffprobe ;
 *  - ffprobe absent → « outils manquants » ;
 *  - ffprobe en échec → « illisible » ;
 *  - aucune piste audio → « pas d'audio ».
 * Renvoie la sonde (durée + présence audio) si tout est bon.
 */
export async function checkMedia(file: string, opts: { probe?: MediaProbeRunner } = {}): Promise<MediaProbe> {
  const probe = opts.probe ?? defaultMediaProbe;
  let size: number;
  try {
    const st = await stat(file);
    if (!st.isFile()) throw new Error('pas un fichier');
    size = st.size;
  } catch {
    throw new MediaValidationError('unreadable', MEDIA_UNREADABLE_MESSAGE);
  }
  if (size === 0) throw new MediaValidationError('unreadable', MEDIA_UNREADABLE_MESSAGE);

  let probed: MediaProbe;
  try {
    probed = await probe(file);
  } catch (err) {
    if (isToolMissingError(err)) throw new MediaValidationError('missing-tools', MEDIA_TOOLS_MISSING_MESSAGE);
    throw new MediaValidationError('unreadable', MEDIA_UNREADABLE_MESSAGE);
  }
  if (!probed.hasAudio) throw new MediaValidationError('no-audio', MEDIA_NO_AUDIO_MESSAGE);
  return probed;
}

/** Disponibilité et version de ffmpeg et ffprobe (endpoint de santé, préflight). */
export async function checkTools(checker: ToolChecker = defaultToolChecker): Promise<Record<ToolName, ToolStatus>> {
  // Un contrôleur qui jette (binaire absent, PATH cassé) ne doit JAMAIS faire
  // échouer l'appelant : l'endpoint de santé doit toujours répondre.
  const safe = async (tool: ToolName): Promise<ToolStatus> => {
    try {
      return await checker(tool);
    } catch {
      return { ok: false };
    }
  };
  const [ffmpeg, ffprobe] = await Promise.all([safe('ffmpeg'), safe('ffprobe')]);
  return { ffmpeg, ffprobe };
}
