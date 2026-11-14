// Consignes (éditoriales) du chapitrage LLM, éditables depuis l'administration.
//
// RÉSOLVEUR UNIQUE (`resolveChapterPrompt`) : le texte enregistré dans la base
// (`app_settings`) prime, sinon le texte par défaut de ce module. Aucun texte
// n'est journalisé ici.
//
// La PARTIE TECHNIQUE du prompt (contrat JSON, consigne « réponds uniquement au
// JSON ») est VOLONTAIREMENT hors de ce module : elle reste imposée par le code
// (`src/chapters.ts`), si bien qu'une mauvaise édition des consignes ne peut
// jamais casser l'extraction. On n'édite donc que les règles éditoriales
// (densité, changement de sujet, style des titres…).
import { sqlite } from './db';
import { deleteAppSetting, readAppSetting, writeAppSetting } from './db/app-settings';

/** Identifiant du réglage en base qui porte les consignes du chapitrage. */
export const CHAPTER_PROMPT_SETTING_ID = 'chapter_prompt';

/**
 * Consignes par défaut (édition possible depuis `/admin`). Elles restent la
 * référence quand rien n'est enregistré en base ou que la valeur stockée est
 * vide : le comportement du chapitrage est alors exactement celui d'avant
 * l'ajout de cet éditeur.
 */
export const DEFAULT_CHAPTER_PROMPT = [
  'Tu découpes des vidéos YouTube en chapitres à partir de leur transcript horodaté.',
  'Règles de densité (impératives) :',
  '- Vise UN chapitre toutes les 3 à 8 minutes de vidéo.',
  '- Ne place JAMAIS deux chapitres à moins de 60 secondes d’écart.',
  '- Le premier chapitre commence à 0 seconde.',
  '- Un chapitre = un vrai changement de sujet ; startSec doit correspondre au début de ce sujet dans le transcript.',
  '- Chaque ligne du transcript est préfixée par son horodatage EXACT [m:ss.s] : choisis startSec au plus près du mot où le sujet commence.',
  '- Minimum 3 chapitres si la vidéo dépasse 1 minute.',
  '- Titres courts (60 caractères max), informatifs, dans la langue du transcript, sans numérotation ni emoji.',
].join('\n');

/** Bornes de saisie : assez large pour écrire, assez strict pour rester utile. */
export const MIN_CHAPTER_PROMPT_LENGTH = 20;
export const MAX_CHAPTER_PROMPT_LENGTH = 8000;

/** Messages français de refus de saisie (affichés tels quels dans la page). */
export const CHAPTER_PROMPT_EMPTY_MESSAGE =
  'Les consignes du chapitrage sont vides. Écrivez au moins une phrase, ou cliquez sur « Réinitialiser » pour revenir aux consignes par défaut.';
export const CHAPTER_PROMPT_TOO_SHORT_MESSAGE = `Les consignes du chapitrage sont trop courtes (au moins ${MIN_CHAPTER_PROMPT_LENGTH} caractères).`;
export const CHAPTER_PROMPT_TOO_LONG_MESSAGE = `Les consignes du chapitrage sont trop longues (au plus ${MAX_CHAPTER_PROMPT_LENGTH} caractères).`;

/** Verdict d'une saisie de consignes. */
export type ChapterPromptValidation = { ok: true } | { ok: false; message: string };

/**
 * Valide des consignes collées dans l'administration : refus d'une valeur vide
 * (ou d'espaces seuls), trop courte pour guider le modèle, ou démesurée.
 * Aucun jugement de contenu : c'est un texte libre, seul le format est borné.
 */
export function validateChapterPrompt(raw: unknown): ChapterPromptValidation {
  const value = typeof raw === 'string' ? raw : '';
  if (!value.trim()) return { ok: false, message: CHAPTER_PROMPT_EMPTY_MESSAGE };
  if (value.trim().length < MIN_CHAPTER_PROMPT_LENGTH) {
    return { ok: false, message: CHAPTER_PROMPT_TOO_SHORT_MESSAGE };
  }
  if (value.length > MAX_CHAPTER_PROMPT_LENGTH) {
    return { ok: false, message: CHAPTER_PROMPT_TOO_LONG_MESSAGE };
  }
  return { ok: true };
}

/** Origine des consignes effectivement retenues. */
export type ChapterPromptSource = 'db' | 'default';

export type ResolvedChapterPrompt = {
  /** Consignes à envoyer au modèle (jamais le texte par défaut si personnalisé). */
  text: string;
  source: ChapterPromptSource;
  /** Horodatage ISO de la dernière écriture en base (le cas échéant). */
  updatedAt?: Date;
};

/**
 * Consignes effectives : la valeur de la base si elle est exploitable (non
 * vide), sinon le texte par défaut. Une table absente ou illisible dégrade
 * proprement vers le défaut (voir `readAppSetting`).
 */
export function resolveChapterPrompt(): ResolvedChapterPrompt {
  const stored = readAppSetting(sqlite, CHAPTER_PROMPT_SETTING_ID);
  const value = stored?.value;
  if (value !== undefined && value.trim()) {
    return { text: value, source: 'db', updatedAt: stored!.updatedAt };
  }
  return { text: DEFAULT_CHAPTER_PROMPT, source: 'default' };
}

/** État affichable des consignes pour l'administration (jamais un secret). */
export type ChapterPromptReport = {
  /** Consignes actives (personnalisées ou par défaut). */
  text: string;
  /** Consignes par défaut du programme : proposées par « Réinitialiser ». */
  default: string;
  source: ChapterPromptSource;
  customized: boolean;
  updatedAt?: string;
};

export function chapterPromptReport(): ChapterPromptReport {
  const resolved = resolveChapterPrompt();
  const report: ChapterPromptReport = {
    text: resolved.text,
    default: DEFAULT_CHAPTER_PROMPT,
    source: resolved.source,
    customized: resolved.source === 'db',
  };
  if (resolved.updatedAt) report.updatedAt = resolved.updatedAt.toISOString();
  return report;
}

// ---------- écriture (section d'administration) ----------

/**
 * Enregistre les consignes en base (valeur déjà validée par l'appelant avec
 * `validateChapterPrompt`). Renvoie `false` si l'écriture échoue.
 */
export function storeChapterPrompt(value: string): boolean {
  return writeAppSetting(sqlite, CHAPTER_PROMPT_SETTING_ID, value.trim());
}

/** Supprime les consignes personnalisées : retour au texte par défaut. */
export function clearChapterPrompt(): boolean {
  return deleteAppSetting(sqlite, CHAPTER_PROMPT_SETTING_ID);
}
