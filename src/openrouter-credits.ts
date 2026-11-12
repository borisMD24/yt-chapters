// Crédits du compte OpenRouter, pour l'administration et l'avertissement
// discret de la page principale.
//
// Source unique : `GET https://openrouter.ai/api/v1/key`, qui renvoie déjà
// `usage`, `limit`, `limit_remaining` et `expires_at`. La clé n'est JAMAIS
// recopiée dans un instantané : on ne garde que des chiffres, une date et un
// message français. Aucun appel n'est fait sans clé exploitable.
//
// Les chiffres sont mis en cache `CREDITS_CACHE_TTL_MS` (60 s) pour ne pas
// marteler l'API à chaque chargement de page ; l'action « Rafraîchir » force
// une relecture. Un échec réseau n'est jamais une exception : il devient un
// instantané en français que l'interface peut afficher tel quel.
import { OPENROUTER_KEY_ENDPOINT } from './openrouter-key-test';
import { resolveOpenRouterKey, type OpenRouterKeySource, type ResolvedOpenRouterKey } from './openrouter-key';

/** Durée de validité du cache (60 s). */
export const CREDITS_CACHE_TTL_MS = 60_000;

/** En dessous de ce montant restant (dollars), la page principale avertit. */
export const LOW_CREDIT_THRESHOLD_USD = 1;

export const CREDITS_MISSING_KEY_MESSAGE =
  "Aucune clé OpenRouter n'est configurée : les crédits ne peuvent pas être affichés.";
export const CREDITS_REFUSED_KEY_MESSAGE =
  "OpenRouter refuse cette clé : les crédits ne peuvent pas être lus. Vérifiez-la dans la page Administration.";
export const CREDITS_UNREACHABLE_MESSAGE =
  "Le service OpenRouter n'a pas pu être joint : les crédits sont indisponibles pour le moment. Vérifiez votre connexion, puis cliquez sur « Rafraîchir ».";

/** Instantané affichable : chiffres uniquement, jamais la clé. */
export type CreditsSnapshot = {
  /** `true` si les chiffres viennent réellement d'OpenRouter. */
  ok: boolean;
  /** Une clé exploitable est-elle configurée ? */
  configured: boolean;
  source: OpenRouterKeySource;
  usage?: number;
  limit?: number;
  limit_remaining?: number;
  expires_at?: string;
  /** Horodatage ISO de CETTE lecture (ou de la dernière tentative). */
  fetchedAt: string;
  /** Vrai si l'instantané vient du cache (aucun appel réseau à l'instant T). */
  cached: boolean;
  /** Phrase française prête à afficher. */
  summary: string;
  /** Avertissement « crédit presque épuisé », sinon `null`. */
  warning: string | null;
  /** Cause courte en français quand `ok` est faux. */
  message?: string;
};

/** Nombre fini extrait d'un champ (nombre ou chaîne numérique), sinon `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Date ISO non vide, sinon `undefined`. */
function isoString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/**
 * Convertit le corps de `GET /api/v1/key` (avec ou sans enveloppe `data`) en
 * chiffres utilisables. Les champs absents restent absents : on n'invente rien.
 */
export function mapCreditsPayload(payload: unknown): {
  usage?: number;
  limit?: number;
  limit_remaining?: number;
  expires_at?: string;
} {
  const root = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const inner =
    root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : root;

  const usage = finiteNumber(inner.usage);
  const limit = finiteNumber(inner.limit);
  let remaining = finiteNumber(inner.limit_remaining);
  // OpenRouter renvoie `limit_remaining: null` quand aucune limite n'est
  // définie ; si une limite et un usage existent, le restant est calculable.
  if (remaining === undefined && limit !== undefined && usage !== undefined) {
    remaining = Math.max(0, limit - usage);
  }
  const expiresAt = isoString(inner.expires_at);

  return {
    ...(usage !== undefined ? { usage } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { limit_remaining: remaining } : {}),
    ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
  };
}

/** Montant en dollars, format français : « 250 $ », « 12,40 $ ». */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 100) / 100;
  const text = Number.isInteger(rounded)
    ? rounded.toLocaleString('fr-FR')
    : rounded.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${text} $`;
}

/** Phrase française décrivant l'état des crédits. */
export function creditsSummary(snapshot: CreditsSnapshot): string {
  if (!snapshot.configured) return snapshot.message ?? CREDITS_MISSING_KEY_MESSAGE;
  if (!snapshot.ok) return snapshot.message ?? CREDITS_UNREACHABLE_MESSAGE;

  const remaining = snapshot.limit_remaining;
  const limit = snapshot.limit;
  if (remaining !== undefined) {
    if (limit !== undefined) return `Il vous reste ${formatUsd(remaining)} sur ${formatUsd(limit)}.`;
    return `Il vous reste ${formatUsd(remaining)} de crédit.`;
  }
  if (limit === undefined) return 'Aucune limite définie sur cette clé.';
  if (snapshot.usage !== undefined) return `${formatUsd(snapshot.usage)} utilisés sur ${formatUsd(limit)}.`;
  return `Limite : ${formatUsd(limit)}.`;
}

/**
 * Avertissement « crédit presque épuisé », uniquement quand le restant est
 * CONNU et strictement inférieur au seuil. Sans clé, sans chiffre ou en cas
 * d'erreur réseau, aucune alerte : on ne bloque jamais et on n'invente rien.
 */
export function lowCreditWarning(snapshot: CreditsSnapshot): string | null {
  if (!snapshot.configured || !snapshot.ok) return null;
  const remaining = snapshot.limit_remaining;
  if (remaining === undefined || remaining >= LOW_CREDIT_THRESHOLD_USD) return null;
  return `Crédit OpenRouter presque épuisé : il vous reste ${formatUsd(remaining)}. Rechargez votre compte sur openrouter.ai pour éviter une interruption.`;
}

export type CreditsProviderOptions = {
  /** `fetch` injectable (tests) : jamais le réseau réel dans la suite. */
  fetchImpl?: typeof fetch;
  /** Durée de cache en millisecondes. */
  ttlMs?: number;
  /** Horloge injectable (tests) : renvoie des millisecondes. */
  now?: () => number;
  /** Résolveur de clé injectable (tests) ; par défaut, base puis `.env`. */
  resolve?: () => ResolvedOpenRouterKey;
  /** URL de l'état du compte (tests). */
  url?: string;
};

export type CreditsProvider = {
  /** Instantané (cache si possible) ; `force` ignore le cache. */
  get(force?: boolean): Promise<CreditsSnapshot>;
  /** Vide le cache (tests, changement de clé). */
  clear(): void;
};

/**
 * Crée le fournisseur d'instantanés. Un seul appel réseau à la fois : les
 * demandes concurrentes partagent la même promesse.
 */
export function createCreditsProvider(options: CreditsProviderOptions = {}): CreditsProvider {
  const doFetch = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? CREDITS_CACHE_TTL_MS;
  const now = options.now ?? (() => Date.now());
  const resolve = options.resolve ?? resolveOpenRouterKey;
  const url = options.url ?? OPENROUTER_KEY_ENDPOINT;

  let cache: { snapshot: CreditsSnapshot; expiresAt: number } | null = null;
  let inflight: Promise<CreditsSnapshot> | null = null;

  /** Construit l'instantané final (résumé + avertissement) sans clé dedans. */
  function finalize(base: Omit<CreditsSnapshot, 'summary' | 'warning'>): CreditsSnapshot {
    const snapshot = { ...base } as CreditsSnapshot;
    snapshot.summary = creditsSummary(snapshot);
    snapshot.warning = lowCreditWarning(snapshot);
    return snapshot;
  }

  async function fetchNow(): Promise<CreditsSnapshot> {
    const resolved = resolve();
    const fetchedAt = new Date(now()).toISOString();

    if (!resolved.key || !resolved.status.ok) {
      return finalize({
        ok: false,
        configured: false,
        source: resolved.source,
        fetchedAt,
        cached: false,
        message:
          resolved.status.reason === 'placeholder'
            ? "La clé OpenRouter enregistrée est vide ou contient encore un exemple : les crédits ne peuvent pas être lus."
            : CREDITS_MISSING_KEY_MESSAGE,
      });
    }

    // La clé ne sort d'ici que dans l'en-tête HTTP : rien n'est conservé.
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${resolved.key}` },
      });
    } catch {
      return finalize({
        ok: false,
        configured: true,
        source: resolved.source,
        fetchedAt,
        cached: false,
        message: CREDITS_UNREACHABLE_MESSAGE,
      });
    }

    if (response.status === 401 || response.status === 403) {
      return finalize({
        ok: false,
        configured: true,
        source: resolved.source,
        fetchedAt,
        cached: false,
        message: CREDITS_REFUSED_KEY_MESSAGE,
      });
    }
    if (!response.ok) {
      return finalize({
        ok: false,
        configured: true,
        source: resolved.source,
        fetchedAt,
        cached: false,
        message: `OpenRouter a répondu de façon inattendue (code ${response.status}). Réessayez plus tard.`,
      });
    }

    let payload: unknown = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }

    return finalize({
      ok: true,
      configured: true,
      source: resolved.source,
      fetchedAt,
      cached: false,
      ...mapCreditsPayload(payload),
    });
  }

  function store(snapshot: CreditsSnapshot): CreditsSnapshot {
    cache = { snapshot, expiresAt: now() + ttlMs };
    return snapshot;
  }

  return {
    async get(force = false): Promise<CreditsSnapshot> {
      if (!force && cache && now() < cache.expiresAt) {
        return { ...cache.snapshot, cached: true };
      }
      if (inflight) return inflight;
      inflight = fetchNow()
        .then((snapshot) => store(snapshot))
        .catch(() =>
          store(
            finalize({
              ok: false,
              configured: true,
              source: 'none',
              fetchedAt: new Date(now()).toISOString(),
              cached: false,
              message: CREDITS_UNREACHABLE_MESSAGE,
            }),
          ),
        )
        .finally(() => {
          inflight = null;
        });
      return inflight;
    },
    clear() {
      cache = null;
      inflight = null;
    },
  };
}
