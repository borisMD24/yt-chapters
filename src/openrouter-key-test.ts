// Vérification d'une clé OpenRouter en DEUX temps :
//
//   1. `GET /api/v1/key` → état du COMPTE (usage, limite, restant,
//      `expires_at`, drapeaux `is_provisioning_key` / `is_management_key`) ;
//   2. une VRAIE sonde d'inférence minimale : `POST /chat/completions` avec le
//      modèle de chapitrage par défaut et `max_tokens: 1` (coût négligeable,
//      JAMAIS d'audio).
//
// Pourquoi la sonde : une clé de provisioning/administration authentifie très
// bien `GET /key` (donc l'ancien test la disait « valide ») mais OpenRouter
// refuse l'inférence avec un `401 {"message":"User not found."}` trompeur — le
// même 401 qu'une clé expirée ou révoquée. Seule une complétion réelle prouve
// que la clé peut transcrire et chapitrer.
//
// Le verdict est TOUJOURS un message français nettoyé : le corps brut de la
// réponse n'est jamais relayé (il pourrait refléter une partie de la requête)
// et la clé n'apparaît nulle part.
//
// Ce module n'importe NI la base NI le SDK : il reste utilisable hors ligne et
// sans effet de bord. Le modèle par défaut est un MIROIR de `LLM_MODEL`
// (`src/chapters.ts`) ; la route d'administration passe le vrai `LLM_MODEL`,
// de sorte que la sonde utilise toujours le modèle de chapitrage de l'app.
export const OPENROUTER_KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
export const OPENROUTER_INFERENCE_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

/** Modèle de repli si l'appelant n'en fournit pas (identique à `LLM_MODEL`). */
export const PROBE_MODEL_FALLBACK = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.5-27b';

/**
 * Verdicts, par ordre de précédence :
 * `provisioning` (drapeau vrai) > `inference-refused` (sonde 401) >
 * `expired` (date passée) > `no-credit` (402) > `rate-limited` (429) >
 * `unreachable` (réseau) > `ok`.
 */
export type OpenRouterKeyVerdict =
  | 'ok'
  | 'provisioning'
  | 'inference-refused'
  | 'expired'
  | 'no-credit'
  | 'rate-limited'
  | 'unreachable';

export type OpenRouterKeyTestResult = {
  ok: boolean;
  verdict: OpenRouterKeyVerdict;
  /** Message français nettoyé, jamais la clé. */
  message: string;
  /** Usage/limite/restant quand OpenRouter les fournit (nombres finis uniquement). */
  usage?: number;
  limit?: number;
  remaining?: number;
  /** Date d'expiration ISO quand OpenRouter la fournit. */
  expiresAt?: string;
  /** Drapeaux du compte, repris tels quels (informatif). */
  isProvisioning?: boolean;
  isManagement?: boolean;
};

export type OpenRouterKeyTestOptions = {
  /** Seam de test : `fetch` remplacé, jamais le réseau réel. */
  fetchImpl?: typeof fetch;
  /** URL de l'état du compte (test). */
  url?: string;
  /** URL de la sonde d'inférence (test). */
  inferenceUrl?: string;
  /** Modèle envoyé à la sonde (défaut : modèle de chapitrage de l'app). */
  model?: string;
};

/** Nombre fini extrait d'un champ, sinon `undefined`. */
function finiteNumber(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
}

/** Date ISO exploitable, sinon `undefined`. */
function isoString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Vrai si `expiresAt` est une date valide déjà passée. */
function isExpired(expiresAt: string | undefined): boolean {
  if (!expiresAt) return false;
  const t = Date.parse(expiresAt);
  return Number.isFinite(t) && t < Date.now();
}

/** Date lisible en français, avec repli sur la valeur brute. */
function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

const MESSAGE_UNREACHABLE =
  "Le service OpenRouter n'a pas pu être joint. Vérifiez votre connexion, puis réessayez.";
const MESSAGE_PROVISIONING =
  "Cette clé sert à administrer des clés, elle ne peut pas transcrire. Créez une clé d'API normale sur openrouter.ai/settings/keys, puis enregistrez-la ici.";
const MESSAGE_INFERENCE_REFUSED =
  "OpenRouter refuse cette clé pour transcrire (réponse 401 « User not found »). Trois causes possibles : c'est une clé d'administration (elle sert à administrer des clés, pas à transcrire), elle a expiré, ou elle a été révoquée. Vérifiez-la sur openrouter.ai/settings/keys, puis enregistrez une clé d'API normale.";
const MESSAGE_NO_CREDIT = 'Crédit OpenRouter insuffisant pour cette clé : rechargez votre compte, puis réessayez.';
const MESSAGE_RATE_LIMITED = "Trop de requêtes envoyées à OpenRouter d'un coup. Réessayez dans une minute.";
const MESSAGE_OK = "Clé acceptée par OpenRouter : l'inférence fonctionne.";

/**
 * Interroge l'état du compte, puis (si la clé n'est pas une clé
 * d'administration) sonde réellement l'inférence. Ne JAMAIS appeler sans avoir
 * une clé configurée, ni sur le chargement d'une page : uniquement sur demande.
 */
export async function testOpenRouterKey(
  key: string,
  options: OpenRouterKeyTestOptions = {},
): Promise<OpenRouterKeyTestResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? OPENROUTER_KEY_ENDPOINT;
  const inferenceUrl = options.inferenceUrl ?? OPENROUTER_INFERENCE_ENDPOINT;
  const model = options.model ?? PROBE_MODEL_FALLBACK;
  const authHeaders = { Authorization: `Bearer ${key}` };

  // ---------- 1. état du compte ----------
  let account: Response;
  try {
    account = await doFetch(url, { method: 'GET', headers: authHeaders });
  } catch {
    return { ok: false, verdict: 'unreachable', message: MESSAGE_UNREACHABLE };
  }

  if (account.status !== 200) {
    if (account.status === 401 || account.status === 403) {
      return { ok: false, verdict: 'inference-refused', message: MESSAGE_INFERENCE_REFUSED };
    }
    if (account.status === 402) return { ok: false, verdict: 'no-credit', message: MESSAGE_NO_CREDIT };
    if (account.status === 429) return { ok: false, verdict: 'rate-limited', message: MESSAGE_RATE_LIMITED };
    return {
      ok: false,
      verdict: 'unreachable',
      message: `Le service OpenRouter a répondu de façon inattendue (code ${account.status}). Réessayez plus tard.`,
    };
  }

  let payload: Record<string, unknown> = {};
  try {
    const data = (await account.json()) as { data?: Record<string, unknown> };
    payload = (data && data.data) || {};
  } catch {
    payload = {};
  }

  const usage = finiteNumber(payload.usage);
  const limit = finiteNumber(payload.limit);
  const remaining = finiteNumber(payload.limit_remaining);
  const expiresAt = isoString(payload.expires_at);
  const isProvisioning = payload.is_provisioning_key === true;
  const isManagement = payload.is_management_key === true;

  const accountState = {
    ...(usage !== undefined ? { usage } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(remaining !== undefined ? { remaining } : {}),
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    ...(isProvisioning ? { isProvisioning: true } : {}),
    ...(isManagement ? { isManagement: true } : {}),
  };

  // Clé d'administration : elle authentifie le compte mais ne transcrit pas.
  // Inutile (et trompeur) de lancer la sonde.
  if (isProvisioning || isManagement) {
    return { ok: false, verdict: 'provisioning', message: MESSAGE_PROVISIONING, ...accountState };
  }

  // ---------- 2. sonde d'inférence réelle (minimale) ----------
  let probe: Response;
  try {
    probe = await doFetch(inferenceUrl, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    });
  } catch {
    return { ok: false, verdict: 'unreachable', message: MESSAGE_UNREACHABLE, ...accountState };
  }

  // 401/403 : OpenRouter utilise ce même code pour une clé d'administration, une
  // clé expirée ou une clé révoquée (« User not found. »). Précédence prioritaire.
  if (probe.status === 401 || probe.status === 403) {
    return { ok: false, verdict: 'inference-refused', message: MESSAGE_INFERENCE_REFUSED, ...accountState };
  }
  if (isExpired(expiresAt)) {
    return {
      ok: false,
      verdict: 'expired',
      message: `Cette clé OpenRouter a expiré le ${formatDate(expiresAt!)}. Créez une nouvelle clé d'API sur openrouter.ai/settings/keys, puis enregistrez-la ici.`,
      ...accountState,
    };
  }
  if (probe.status === 402) return { ok: false, verdict: 'no-credit', message: MESSAGE_NO_CREDIT, ...accountState };
  if (probe.status === 429) return { ok: false, verdict: 'rate-limited', message: MESSAGE_RATE_LIMITED, ...accountState };
  if (probe.ok) return { ok: true, verdict: 'ok', message: MESSAGE_OK, ...accountState };
  return {
    ok: false,
    verdict: 'unreachable',
    message: `Le service OpenRouter a répondu de façon inattendue (code ${probe.status}). Réessayez plus tard.`,
    ...accountState,
  };
}
