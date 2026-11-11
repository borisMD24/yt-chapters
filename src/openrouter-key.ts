// État de configuration de la clé OpenRouter, partagé par le pipeline de
// transcription, le chapitrage LLM, l'endpoint de santé et la section
// d'administration.
//
// La clé n'est JAMAIS renvoyée ni journalisée par ce module : on ne produit
// qu'un verdict (`ok` + raison), un masque court et le verdict de la source.
// Un `.env` resté à l'exemple (`sk-...`, `sk-or-...`) est traité comme NON
// configuré : c'est exactement ce qui produisait un 401 attribué à tort au
// découpage, sans message exploitable.
//
// RÉSOLVEUR UNIQUE (`resolveOpenRouterKey`) : la clé enregistrée dans la base
// (voir `app_settings`) prime, sinon `OPENROUTER_API_KEY` du `.env`, sinon rien.
// Le pipeline de transcription, le client de chapitrage, les contrôles de
// disponibilité et les routes d'administration passent tous par lui : aucune
// logique dupliquée.
import { sqlite } from './db';
import { deleteAppSetting, readAppSetting, writeAppSetting } from './db/app-settings';

/** Nom de la variable d'environnement (fichier `.env`). */
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';

/** Identifiant du réglage en base qui porte la clé OpenRouter. */
export const OPENROUTER_KEY_SETTING_ID = 'openrouter_api_key';

/**
 * Message français d'un refus de saisie : mêmes règles que la disponibilité
 * (`openRouterKeyStatus`), avec la formulation « vide ou contient encore un
 * exemple » déjà employée par l'interface.
 */
export const OPENROUTER_KEY_INVALID_MESSAGE =
  "La clé OpenRouter est vide ou contient encore un exemple. Collez une clé valide (elle commence par « sk-or- »).";

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

// ---------- résolution (base d'abord, puis `.env`) ----------

/** Origine de la clé effectivement retenue. */
export type OpenRouterKeySource = 'db' | 'env' | 'none';

export type ResolvedOpenRouterKey = {
  /** Valeur exploitable pour un appel réseau (jamais journalisée par les appelants). */
  key?: string;
  source: OpenRouterKeySource;
  /** Verdict de la valeur retenue (`ok`) ou raison du refus (`missing`/`placeholder`). */
  status: OpenRouterKeyStatus;
};

type KeyCandidate = { value?: string; source: 'db' | 'env' };

/** Candidats dans l'ordre de priorité : base d'abord, puis `.env`. */
function keyCandidates(): { stored?: { value: string; updatedAt: Date }; candidates: KeyCandidate[] } {
  const stored = readAppSetting(sqlite, OPENROUTER_KEY_SETTING_ID);
  return {
    stored,
    candidates: [
      { value: stored?.value, source: 'db' },
      { value: process.env[OPENROUTER_KEY_ENV], source: 'env' },
    ],
  };
}

/**
 * Clé effective : valeur de la base SI elle est acceptable, sinon
 * `OPENROUTER_API_KEY` du `.env` SI elle est acceptable, sinon rien (`none`).
 * La raison du refus est `placeholder` dès qu'une valeur (même refusée) existe,
 * `missing` si tout est vide — ce qui alimente le bandeau de la page.
 */
export function resolveOpenRouterKey(): ResolvedOpenRouterKey {
  const { candidates } = keyCandidates();
  for (const candidate of candidates) {
    // `?? ''` est indispensable : passer `undefined` déclencherait la valeur par
    // défaut de `openRouterKeyStatus`, qui relirait le `.env` (la base « vide »
    // serait alors prise pour la source, avec la valeur de l'environnement).
    const status = openRouterKeyStatus(candidate.value ?? '');
    if (status.ok) return { key: String(candidate.value).trim(), source: candidate.source, status };
  }
  const hasValue = candidates.some((c) => typeof c.value === 'string' && c.value.trim() !== '');
  return { source: 'none', status: { ok: false, reason: hasValue ? 'placeholder' : 'missing' } };
}

// ---------- masque et état (jamais la clé) ----------

/**
 * Masque court d'une clé, sûr à afficher : au plus 6 caractères de préfixe (la
 * partie publique et commune, ex. `sk-or-`) et les 4 derniers. Volontairement
 * sous 8 caractères de chaque côté : aucun fragment de 8 caractères ou plus de
 * la clé ne peut ainsi apparaître dans une réponse ou une trace.
 */
export function maskOpenRouterKey(value: string): string {
  const v = value.trim();
  if (v.length < 12) return v.length > 4 ? `…${v.slice(-4)}` : '…';
  return `${v.slice(0, 6)}…${v.slice(-4)}`;
}

/** État de la clé pour la page d'administration (jamais la clé elle-même). */
export type OpenRouterKeyReport = {
  configured: boolean;
  source: OpenRouterKeySource;
  reason?: OpenRouterKeyReason;
  hint?: string;
  /** Horodatage ISO de la dernière écriture en base (le cas échéant). */
  updatedAt?: string;
};

/** État affichable de la clé : verdict + source + masque + dernière mise à jour. */
export function openRouterKeyReport(): OpenRouterKeyReport {
  const { stored } = keyCandidates();
  const resolved = resolveOpenRouterKey();
  const report: OpenRouterKeyReport = { configured: resolved.status.ok, source: resolved.source };
  if (!resolved.status.ok && resolved.status.reason) report.reason = resolved.status.reason;

  if (resolved.source === 'env') {
    report.hint = maskOpenRouterKey(String(process.env[OPENROUTER_KEY_ENV] ?? ''));
    return report;
  }
  // Source base : masque + date. Valeur stockée mais refusée (source `none`) :
  // on montre aussi le masque et la date, ce qui explique le refus.
  if (stored && stored.value.trim()) {
    report.hint = maskOpenRouterKey(stored.value);
    report.updatedAt = stored.updatedAt.toISOString();
  }
  return report;
}

// ---------- écriture (section d'administration) ----------

/**
 * Enregistre la clé en base. L'appelant DOIT avoir validé la valeur avec
 * `openRouterKeyStatus` au préalable. Renvoie `false` si l'écriture échoue.
 */
export function storeOpenRouterKey(value: string): boolean {
  return writeAppSetting(sqlite, OPENROUTER_KEY_SETTING_ID, value.trim());
}

/** Supprime la clé enregistrée : le résolveur retombe alors sur le `.env`. */
export function clearOpenRouterKey(): boolean {
  return deleteAppSetting(sqlite, OPENROUTER_KEY_SETTING_ID);
}
