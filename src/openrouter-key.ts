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
 *
 * Le mot-clé doit être un JETON — entouré de non-alphanumériques (ou aux bords) :
 * sans cette contrainte, une clé aléatoire était refusée à tort (`xxx` apparaît
 * par hasard dans une suite base64 : un fuzz de 6 000 clés réalistes a produit
 * 8 rejets, tous dus à `xxx`). Avec la contrainte, un bloc hexadécimal, base64 ou
 * alphanumérique ne peut plus correspondre, tout en gardant les exemples
 * documentés (`sk-votre-cle-…`, `CHANGE_ME_…`, `sk-xxx-…`).
 */
const PLACEHOLDER_PATTERN =
  /(?:^|[^A-Za-z0-9])(votre|your|change|remplace|replace|exemple|example|placeholder|todo|xxx)(?:$|[^A-Za-z0-9])/i;

/**
 * Verdict pour une valeur de clé (par défaut : `OPENROUTER_API_KEY`).
 * - absente ou vide → `missing` ;
 * - exemple manifeste ou trop courte pour être une vraie clé → `placeholder` ;
 * - sinon → `ok`.
 */
export function openRouterKeyStatus(raw: string | undefined = process.env[OPENROUTER_KEY_ENV]): OpenRouterKeyStatus {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: false, reason: 'missing' };
  if (
    value.length < MIN_OPENROUTER_KEY_LENGTH ||
    value.includes('...') ||
    value.includes('…') ||
    PLACEHOLDER_PATTERN.test(value)
  ) {
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
