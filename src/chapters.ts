import OpenAI from 'openai';
import { z } from 'zod';

// Chaptering LLM via OpenRouter (SDK openai avec baseURL OpenRouter).
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const LLM_MODEL = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.5-27b';

// Client créé paresseusement : évite d'exiger une clé tant qu'aucun chapitre n'est demandé.
let client: OpenAI | null = null;
function getClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Sans ce garde-fou, le SDK retombe sur OPENAI_API_KEY et l'erreur nomme
    // la mauvaise variable (diagnostic trompeur).
    throw new Error(
      "OPENROUTER_API_KEY manquante : renseigne la clé OpenRouter dans l'environnement " +
        "(le SDK retomberait sinon sur OPENAI_API_KEY, d'où une erreur trompeuse).",
    );
  }
  client ??= new OpenAI({ apiKey, baseURL: BASE_URL });
  return client;
}

export const MIN_GAP = 10; // règle YouTube : 10s min par chapitre

export function fmtTs(total: number): string {
  const s = Math.max(0, Math.floor(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/** Regroupe le transcript en blocs de `bucket` secondes pour limiter les tokens */
function condense(segs: { startSec: number; text: string }[], bucket = 20): string {
  const groups = new Map<number, string[]>();
  for (const s of segs) {
    const k = Math.floor(s.startSec / bucket) * bucket;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(s.text);
  }
  return [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([k, texts]) => `[${fmtTs(k)}] ${texts.join(' ')}`)
    .join('\n');
}

export type Proposed = { startSec: number; title: string };

/** Schéma JSON attendu du LLM (startSec coerçable, titre strictement string). */
export const CHAPTERS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['chapters'],
  properties: {
    chapters: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['startSec', 'title'],
        properties: {
          startSec: { type: 'integer' },
          title: { type: 'string' },
        },
      },
    },
  },
} as const;

const ProposedSchema = z.object({
  startSec: z.coerce.number().finite(),
  title: z.string().min(1),
});
const ChaptersSchema = z.object({ chapters: z.array(z.unknown()) });

/** Erreur métier : la réponse du modèle ne contient aucun JSON de chapitres exploitable. */
export class UnusableChapterOutputError extends Error {
  constructor(detail: string) {
    super(`Réponse du modèle inexploitable : ${detail}`);
    this.name = 'UnusableChapterOutputError';
  }
}

/** Extrait le premier bloc {...} équilibré (ignore les accolades dans les chaînes). */
export function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Parse défensivement la réponse du LLM : extrait le premier objet JSON, valide
 * avec zod et ignore les items invalides.
 * Renvoie `null` si aucun objet JSON de chapitres n'est exploitable (réponse
 * hors-sujet, JSON tronqué, `[0]`…) — à distinguer d'un résultat valide vide
 * `{"chapters":[]}` qui, lui, est un vrai résultat.
 */
function analyzeChaptersJson(raw: string): Proposed[] | null {
  const block = extractJsonObject(raw);
  if (!block) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return null;
  }
  const shape = ChaptersSchema.safeParse(parsed);
  if (!shape.success) return null;
  const out: Proposed[] = [];
  for (const item of shape.data.chapters) {
    const one = ProposedSchema.safeParse(item);
    if (!one.success) continue;
    out.push({ startSec: one.data.startSec, title: one.data.title.trim() });
  }
  return out;
}

/** Idem `analyzeChaptersJson` mais `[]` quand rien n'est exploitable. */
export function parseChaptersJson(raw: string): Proposed[] {
  return analyzeChaptersJson(raw) ?? [];
}

export function normalize(items: Proposed[], durationSec: number): Proposed[] {
  const max = durationSec > 0 ? durationSec - MIN_GAP : Infinity;
  const sorted = items
    .map((c) => ({ startSec: Math.max(0, Math.round(c.startSec)), title: c.title.trim() }))
    .filter((c) => c.title && c.startSec <= max)
    .sort((a, b) => a.startSec - b.startSec);
  if (!sorted.length) return [];
  sorted[0].startSec = 0; // YouTube exige 0:00 en premier
  const out: Proposed[] = [sorted[0]];
  for (const c of sorted.slice(1)) {
    if (c.startSec - out[out.length - 1].startSec >= MIN_GAP) out.push(c);
  }
  return out;
}

/** Format description YouTube : "0:00 Titre" par ligne. */
export function chaptersToText(chs: { startSec: number; title: string }[]): string {
  return chs.map((c) => `${fmtTs(c.startSec)} ${c.title}`).join('\n');
}

/** Règles YouTube partagées (export existant + pipeline local). */
export function buildWarnings(
  chs: { startSec: number; title: string; validated?: boolean }[],
  opts: { includePending?: boolean } = {},
): string[] {
  const warnings: string[] = [];
  if (chs.length < 3) warnings.push('YouTube exige au moins 3 chapitres');
  if (chs[0] && chs[0].startSec !== 0) warnings.push('Le premier chapitre doit commencer à 0:00');
  chs.slice(1).forEach((c, i) => {
    if (c.startSec - chs[i].startSec < MIN_GAP) {
      warnings.push(`"${chs[i].title}" dure moins de ${MIN_GAP}s`);
    }
  });
  if (opts.includePending) {
    const pending = chs.filter((c) => !c.validated).length;
    if (pending) warnings.push(`${pending} chapitre(s) pas encore validé(s)`);
  }
  return warnings;
}

/** Forme minimale d'une réponse de complétion (SDK OpenAI ou faux client de test). */
export type ChatCompletionLike = {
  choices?: { message?: { content?: string | null; reasoning?: string | null } }[];
};

/** Corps de requête réellement envoyé au provider (injectable en test). */
export type ChaptersRequest = {
  model: string;
  temperature: number;
  messages: OpenAI.Chat.ChatCompletionMessageParam[];
  response_format: ResponseFormat;
};

type ResponseFormat = NonNullable<OpenAI.Chat.ChatCompletionCreateParamsNonStreaming['response_format']>;

export type ChaptersCompleter = (req: ChaptersRequest) => Promise<ChatCompletionLike>;

/** Format demandé en premier choix : JSON strict garanti par le provider. */
const JSON_SCHEMA_FORMAT = {
  type: 'json_schema',
  json_schema: { name: 'chapters', strict: true, schema: CHAPTERS_SCHEMA },
} as const satisfies ResponseFormat;

const SCHEMA_HINT: OpenAI.Chat.ChatCompletionMessageParam = {
  role: 'system',
  content: `Réponds avec un unique objet JSON conforme à ce schéma : ${JSON.stringify(CHAPTERS_SCHEMA)}`,
};

/**
 * Vrai seulement si l'erreur signifie que le provider ne supporte pas le
 * `response_format` demandé (400/404/422). Les erreurs d'auth, de quota, de
 * serveur ou de réseau ne justifient PAS un second appel facturé : elles doivent
 * remonter telles quelles.
 */
export function shouldFallbackToJsonObject(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  return status === 400 || status === 404 || status === 422;
}

/** Appel réel au provider via le SDK (seule partie non testable hors ligne). */
const defaultCompleter: ChaptersCompleter = async (req) => getClient().chat.completions.create(req);

export type ProposeDeps = { complete?: ChaptersCompleter };

export async function proposeChapters(
  meta: { title: string; durationSec: number },
  segs: { startSec: number; text: string }[],
  deps: ProposeDeps = {},
): Promise<Proposed[]> {
  const complete = deps.complete ?? defaultCompleter;

  const system = [
    'Tu découpes des vidéos YouTube en chapitres à partir de leur transcript horodaté.',
    'Règles de densité (impératives) :',
    '- Vise UN chapitre toutes les 3 à 8 minutes de vidéo.',
    '- Ne place JAMAIS deux chapitres à moins de 60 secondes d’écart.',
    '- Le premier chapitre commence à 0 seconde.',
    '- Un chapitre = un vrai changement de sujet ; startSec doit correspondre au début de ce sujet dans le transcript.',
    '- Minimum 3 chapitres si la vidéo dépasse 1 minute.',
    '- Titres courts (60 caractères max), informatifs, dans la langue du transcript, sans numérotation ni emoji.',
    '- Réponds uniquement avec le JSON demandé.',
  ].join('\n');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Titre : ${meta.title}\nDurée : ${meta.durationSec}s\n\nTranscript :\n${condense(segs)}`,
    },
  ];
  const base = { model: LLM_MODEL, temperature: 0.2 };

  let schemaError = '';
  try {
    const first = await complete({ ...base, messages, response_format: JSON_SCHEMA_FORMAT });
    const chapters = analyzeChaptersJson(first.choices?.[0]?.message?.content ?? '');
    if (chapters) return normalize(chapters, meta.durationSec);
    // 200 mais `content` inexploitable (payload réel dans `reasoning`, cf.
    // qwen3.5-27b routé AtlasCloud qui renvoie `"[0]"`) : on tente json_object.
  } catch (err) {
    if (!shouldFallbackToJsonObject(err)) throw err;
    schemaError = err instanceof Error ? err.message : String(err);
  }

  const second = await complete({
    ...base,
    messages: [...messages, SCHEMA_HINT],
    response_format: { type: 'json_object' },
  });
  const message = second.choices?.[0]?.message;
  const fromContent = analyzeChaptersJson(message?.content ?? '');
  if (fromContent) return normalize(fromContent, meta.durationSec);
  // Dernier recours : certains modèles (raisonneurs) déposent le JSON réel dans
  // `reasoning` en laissant `content` inutilisable.
  const fromReasoning = analyzeChaptersJson(message?.reasoning ?? '');
  if (fromReasoning) return normalize(fromReasoning, meta.durationSec);

  throw new UnusableChapterOutputError(
    `aucun objet JSON de chapitres extractible (model ${LLM_MODEL}` +
      `${schemaError ? `, json_schema refusé : ${schemaError}` : ''}` +
      `, content reçu : ${JSON.stringify(message?.content ?? null).slice(0, 160)})`,
  );
}
