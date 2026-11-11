// Vérification « à blanc » d'une clé OpenRouter : `GET /api/v1/key` (aucun jeton
// consommé, aucun appel de complétion). Le verdict est TOUJOURS un message
// français nettoyé : le corps brut de la réponse n'est jamais relayé (il
// pourrait refléter une partie de la requête) et la clé n'apparaît nulle part.
export const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';

export type OpenRouterKeyVerdict = 'valid' | 'refused' | 'insufficient_credit' | 'rate_limited' | 'unreachable';

export type OpenRouterKeyTestResult = {
  ok: boolean;
  verdict: OpenRouterKeyVerdict;
  /** Message français nettoyé, jamais la clé. */
  message: string;
  /** Usage/limite/restant quand OpenRouter les fournit (nombres finis uniquement). */
  usage?: number;
  limit?: number;
  remaining?: number;
};

export type OpenRouterKeyTestOptions = {
  /** Seam de test : `fetch` remplacé, jamais le réseau réel. */
  fetchImpl?: typeof fetch;
  url?: string;
};

/** Nombre fini extrait d'un champ, sinon `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

export async function testOpenRouterKey(
  key: string,
  options: OpenRouterKeyTestOptions = {},
): Promise<OpenRouterKeyTestResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? OPENROUTER_KEY_ENDPOINT;

  let res: Response;
  try {
    res = await doFetch(url, { method: 'GET', headers: { Authorization: `Bearer ${key}` } });
  } catch {
    return {
      ok: false,
      verdict: 'unreachable',
      message: "Le service OpenRouter n'a pas pu être joint. Vérifiez votre connexion, puis réessayez.",
    };
  }

  if (res.status === 200) {
    let data: { data?: Record<string, unknown> } | undefined;
    try {
      data = (await res.json()) as { data?: Record<string, unknown> };
    } catch {
      data = undefined;
    }
    const payload = (data && data.data) || {};
    const usage = finiteNumber(payload.usage);
    const limit = finiteNumber(payload.limit);
    const remaining = finiteNumber(payload.limit_remaining);
    return {
      ok: true,
      verdict: 'valid',
      message: 'Clé acceptée par OpenRouter.',
      ...(usage !== undefined ? { usage } : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(remaining !== undefined ? { remaining } : {}),
    };
  }

  if (res.status === 401 || res.status === 403) {
    return { ok: false, verdict: 'refused', message: 'Clé refusée par OpenRouter (authentification invalide).' };
  }
  if (res.status === 402) {
    return { ok: false, verdict: 'insufficient_credit', message: 'Crédit OpenRouter insuffisant pour cette clé.' };
  }
  if (res.status === 429) {
    return {
      ok: false,
      verdict: 'rate_limited',
      message: "Trop de requêtes envoyées à OpenRouter d'un coup. Réessayez dans une minute.",
    };
  }
  return {
    ok: false,
    verdict: 'unreachable',
    message: `Le service OpenRouter a répondu de façon inattendue (code ${res.status}). Réessayez plus tard.`,
  };
}
