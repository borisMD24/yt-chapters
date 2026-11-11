import OpenAI from 'openai';

const openai = new OpenAI(); // lit OPENAI_API_KEY
const MODEL = process.env.OPENAI_MODEL ?? 'gpt-4.1';

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

  const res = await openai.chat.completions.create({
    model: MODEL,
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      {
        role: 'user',
        content: `Titre : ${meta.title}\nDurée : ${meta.durationSec}s\n\nTranscript :\n${condense(segs)}`,
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'chapters',
        strict: true,
        schema: {
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
        },
      },
    },
  });

  const parsed = JSON.parse(res.choices[0].message.content ?? '{"chapters":[]}');
  return normalize(parsed.chapters ?? [], meta.durationSec);
}
