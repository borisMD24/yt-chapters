// État de configuration de la clé OpenRouter, partagé par le pipeline de
// transcription, le chapitrage LLM et l'endpoint de santé.
//
// La clé n'est JAMAIS renvoyée ni journalisée par ce module : on ne produit
// qu'un verdict (`ok` + raison) exploitable par la page et les messages d'erreur.
// Un `.env` resté à l'exemple (`sk-...`, `sk-or-...`) est traité comme NON
// configuré : c'est exactement ce qui produisait un 401 attribué à tort au
// découpage, sans message exploitable.

/** Nom de la variable d'environnement (fichier `.env`). */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

/**
 * Longueur en dessous de laquelle une valeur ne peut pas être une vraie clé
 * (les clés OpenRouter réelles font plusieurs dizaines de caractères) : une
 * valeur plus courte est un exemple ou une saisie tronquée.
 */
export const MIN_OPENROUTER_KEY_LENGTH = 20;

export type OpenRouterKeyReason = 'missing' | 'placeholder';

/** Verdict de configuration, sans jamais porter la valeur de la clé. */
export type OpenRouterKeyStatus = { ok: boolean; reason?: OpenRouterKeyReason };

/**
 * Motifs d'exemple évidents. Volontairement restreints à des lettres absentes
 * d'une clé hexadécimale (`votre`, `your`, `change`, `todo`…) ou à une suite de
 * points, pour ne jamais rejeter une vraie clé au hasard.
 */
const PLACEHOLDER_PATTERNS = /\.\.\.|…|votre|your|change|remplace|replace|exemple|example|placeholder|todo|xxx/i;

/**
 * Verdict pour une valeur de clé (par défaut : `OPENROUTER_API_KEY`).
 * - absente ou vide → `missing` ;
 * - exemple manifeste ou trop courte pour être une vraie clé → `placeholder` ;
 * - sinon → `ok`.
 */
export function openRouterKeyStatus(raw: string | undefined = process.env[OPENROUTER_KEY_ENV]): OpenRouterKeyStatus {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'missing' };
  if (value.length < MIN_OPENROUTER_KEY_LENGTH || PLACEHOLDER_PATTERNS.test(value)) {
    return { ok: false, reason: 'placeholder' };
  }
  return { ok: true };
}

/**
 * Clé exploitable pour un appel réseau, ou `undefined` si elle est absente ou
 * manifestement un exemple (auquel cas l'appelant doit échouer AVANT tout appel
 * HTTP, avec un message actionnable plutôt qu'un 401 attribué à la mauvaise phase).
 */
export function openRouterApiKey(raw?: string): string | undefined {
  const source = raw ?? process.env[OPENROUTER_KEY_ENV];
  if (!openRouterKeyStatus(source).ok) return undefined;
  return String(source).trim();
}
