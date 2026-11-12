// Validation de la fenêtre de `GET /videos/:id/words` : lecture des mots
// horodatés d'un média, depuis la table `media_words` (aucun ffmpeg).
//
// Module PUR (aucune dépendance, aucune E/S) : la route peut l'appeler et
// répondre `400` en français sur toute fenêtre invalide, sans accéder à la base.
// La troncature à la durée du média et à la fin se font côté route, après
// validation.

/** Durée maximale d'une fenêtre demandable (secondes). */
export const WORDS_MAX_WINDOW_SEC = 120;

/** Plafond du nombre de mots renvoyés (fenêtre large et dense). */
export const WORDS_MAX_COUNT = 2000;

/** Message : fenêtre invalide (absente, négative, inversée, non finie). */
export const WORDS_WINDOW_INVALID_MESSAGE =
  'Fenêtre invalide : indiquez un début positif ou nul et une fin strictement supérieure au début.';

/** Message : fenêtre trop longue. */
export const WORDS_WINDOW_TOO_LONG_MESSAGE = `Fenêtre trop longue : la durée maximale est de ${WORDS_MAX_WINDOW_SEC} secondes.`;

export type WordsQueryResult = { ok: true; from: number; to: number } | { ok: false; message: string };

/** Lit un paramètre de requête (chaîne ou nombre) en nombre fini, sinon `NaN`. */
function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return NaN;
}

/**
 * Valide `?from=&to=` : finis, `from ≥ 0`, `0 < to − from ≤ 120`. Toute autre
 * situation est refusée par un message français (l'appelant répond `400`).
 */
export function parseWordsQuery(query: unknown): WordsQueryResult {
  const q = (query ?? {}) as { from?: unknown; to?: unknown };
  const from = toNumber(q.from);
  const to = toNumber(q.to);
  if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || !(to > from)) {
    return { ok: false, message: WORDS_WINDOW_INVALID_MESSAGE };
  }
  if (to - from > WORDS_MAX_WINDOW_SEC) return { ok: false, message: WORDS_WINDOW_TOO_LONG_MESSAGE };
  return { ok: true, from, to };
}
