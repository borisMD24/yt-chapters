import OpenAI from 'openai';
import { z } from 'zod';

// Chaptering LLM via OpenRouter (SDK openai avec baseURL OpenRouter).
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const LLM_MODEL = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.5-27b';

// Client créé paresseusement : évite d'exiger une clé tant qu'aucun chapitre n'est demandé.
let client: OpenAI | null = null;
function getClient(): OpenAI {
  client ??= new OpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: BASE_URL });
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

/** Extrait le premier bloc {...} équilibré (ignore les accolades dans les chaînes). */
function extractJsonObject(raw: string): string | null {
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
 * avec zod et ignore les items invalides. Renvoie [] si rien d'exploitable.
 */
export function parseChaptersJson(raw: string): Proposed[] {
  const block = extractJsonObject(raw);
  if (!block) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(block);
  } catch {
    return [];
  }
  const shape = ChaptersSchema.safeParse(parsed);
  if (!shape.success) return [];
  const out: Proposed[] = [];
  for (const item of shape.data.chapters) {
    const one = ProposedSchema.safeParse(item);
    if (!one.success) continue;
    out.push({ startSec: one.data.startSec, title: one.data.title.trim() });
  }
  return out;
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

export async function proposeChapters(
  meta: { title: string; durationSec: number },
  segs: { startSec: number; text: string }[],
): Promise<Proposed[]> {
  const system = [
    'Tu découpes des vidéos YouTube en chapitres à partir de leur transcript horodaté.',
    'Règles :',
    '- Le premier chapitre commence à 0 seconde.',
    '- Un chapitre = un vrai changement de sujet ; startSec doit correspondre au début de ce sujet dans le transcript.',
    '- Environ 1 chapitre toutes les 3 à 8 minutes (minimum 3 chapitres si la vidéo dépasse 1 minute).',
    '- Écart minimum de 10 secondes entre deux chapitres.',
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

  try {
    const res = await getClient().chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.2,
      messages,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'chapters', strict: true, schema: CHAPTERS_SCHEMA },
      },
    });
    return normalize(parseChaptersJson(res.choices[0]?.message?.content ?? ''), meta.durationSec);
  } catch {
    // Le support de json_schema varie selon le provider routé : repli json_object
    // avec le schéma décrit dans le prompt, puis parsing défensif.
    const res = await getClient().chat.completions.create({
      model: LLM_MODEL,
      temperature: 0.2,
      messages: [
        ...messages,
        { role: 'system', content: `Réponds avec un unique objet JSON conforme à ce schéma : ${JSON.stringify(CHAPTERS_SCHEMA)}` },
      ],
      response_format: { type: 'json_object' },
    });
    return normalize(parseChaptersJson(res.choices[0]?.message?.content ?? ''), meta.durationSec);
  }
}
