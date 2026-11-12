import OpenAI from 'openai';
import { z } from 'zod';
import { resolveOpenRouterKey } from './openrouter-key';
import {
  fmtLineTs,
  groupWordsIntoSentences,
  MAX_LINE_CHARS,
  normalizeToken,
  SENTENCE_PAUSE_SEC,
  snapToWordStart,
  tokenEditDistance,
  type Sentence,
  type Word,
} from './words';

// Chaptering LLM via OpenRouter (SDK openai avec baseURL OpenRouter).
const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1';
export const LLM_MODEL = process.env.OPENROUTER_MODEL ?? 'qwen/qwen3.5-27b';

// Client créé paresseusement et INDEXÉ par la clé effective : une mise à jour de
// la clé depuis l'administration invalide donc le cache au prochain appel (aucun
// client périmé conservant l'ancienne clé).
let cached: { key: string; client: OpenAI } | null = null;
function getClient(): OpenAI {
  const { key } = resolveOpenRouterKey();
  if (!key) {
    // Sans ce garde-fou, le SDK retombe sur OPENAI_API_KEY et l'erreur nomme
    // la mauvaise variable (diagnostic trompeur).
    throw new Error(
      "OPENROUTER_API_KEY manquante : renseigne la clé OpenRouter dans l'environnement " +
        "(le SDK retomberait sinon sur OPENAI_API_KEY, d'où une erreur trompeuse).",
    );
  }
  if (!cached || cached.key !== key) cached = { key, client: new OpenAI({ apiKey: key, baseURL: BASE_URL }) };
  return cached.client;
}

export const MIN_GAP = 10; // règle YouTube : 10s min par chapitre

/**
 * Horodatage `h:mm:ss`/`m:ss` pour l'EXPORT YouTube et les en-têtes du
 * transcript. YouTube n'accepte que des secondes entières : on ARRONDIT au plus
 * proche (un chapitre aligné à 3:19,6 doit s'afficher 3:20, jamais 3:19).
 */
export function fmtTs(total: number): string {
  const s = Math.max(0, Math.round(total));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Regroupe le transcript en blocs de `bucket` secondes : repli historique,
 * utilisé seulement quand aucun mot horodaté n'est disponible.
 */
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

/**
 * Transcript lisible par le LLM, à horodatage PRÉCIS : une ligne par phrase,
 * préfixée par le début EXACT de son premier mot `[m:ss.s]`. Le texte total est
 * identique à celui d'avant (aucun mot perdu) : seuls les horodatages gagnent en
 * précision (l'ancien découpage en blocs de 20 s quantifiait les débuts).
 * Repli sur l'ancien regroupement par blocs si aucun mot n'est fourni.
 */
export function buildTranscriptLines(
  segs: { startSec: number; text: string }[],
  words?: Word[],
): string {
  if (words && words.length) {
    const lines = groupWordsIntoSentences(words, { pauseSec: SENTENCE_PAUSE_SEC, maxChars: MAX_LINE_CHARS });
    if (lines.length) return lines.map((l) => `[${fmtLineTs(l.startSec)}] ${l.text}`).join('\n');
  }
  return condense(segs);
}

export type Proposed = { startSec: number; title: string; openingWords?: string };

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
        required: ['startSec', 'title', 'openingWords'],
        properties: {
          startSec: { type: 'integer' },
          title: { type: 'string' },
          openingWords: { type: 'string' },
        },
      },
    },
  },
} as const;

/** Alias de clés tolérés : les providers routés dérivent (snake_case, abréviations). */
const START_KEYS = ['startSec', 'start_sec', 'start', 'start_seconds'] as const;
const TITLE_KEYS = ['title', 'titre'] as const;
const OPENING_KEYS = [
  'openingWords',
  'opening_words',
  'opening',
  'startWords',
  'start_words',
  'firstWords',
  'first_words',
  'mots_ouverture',
] as const;

/** Nombre exploitable depuis un champ numérique/coercible, sinon null. */
function toFiniteNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Première clé alias renseignée (null/undefined = absente). */
function pickAlias(item: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const k of keys) {
    const v = item[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

/** Enveloppe attendue : `{"chapters":[…]}`. */
const ChaptersSchema = z.object({ chapters: z.array(z.unknown()) });

/**
 * Convertit un item brut du modèle en chapitre en tolérant les alias de clés
 * (`start_sec`, `start`, `start_seconds`, `titre`, `opening_words`…). `null` si
 * inexploitable. `openingWords` est OPTIONNEL : son absence n'invalide pas le
 * chapitre (on retombe alors sur `startSec`), et il sert seulement à l'alignement.
 */
function toProposed(item: unknown): Proposed | null {
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
  const rec = item as Record<string, unknown>;
  const startSec = toFiniteNumber(pickAlias(rec, START_KEYS));
  const rawTitle = pickAlias(rec, TITLE_KEYS);
  if (startSec === null || typeof rawTitle !== 'string') return null;
  const title = rawTitle.trim();
  if (!title) return null;
  const rawOpening = pickAlias(rec, OPENING_KEYS);
  const openingWords = typeof rawOpening === 'string' && rawOpening.trim() ? rawOpening.trim() : undefined;
  return openingWords ? { startSec, title, openingWords } : { startSec, title };
}

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

/** Tous les blocs {...} équilibrés d'un texte, dans l'ordre d'apparition. */
export function extractJsonObjects(raw: string): string[] {
  const out: string[] = [];
  let start = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start !== -1) {
        out.push(raw.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Extrait le DERNIER bloc {...} équilibré (la réponse finale d'un scratchpad vient
 * souvent en dernier). Attention : un objet vide (`{"chapters":[]}`) ou de simples
 * métadonnées peut suivre la vraie réponse → pour sélectionner un payload de
 * chapitres, passer par `lastUsableChapters` (mode 'last' de `rawChapters`), qui
 * remonte jusqu'au dernier candidat réellement exploitable.
 */
export function extractLastJsonObject(raw: string): string | null {
  const all = extractJsonObjects(raw);
  return all.length ? all[all.length - 1] : null;
}

/**
 * Vrai quand le modèle a produit des chapitres mais qu'aucun n'est exploitable :
 * soit aucun item ne valide (dérive de clés), soit `normalize` les élimine tous
 * (tous les horodatages au-delà de `durationSec - MIN_GAP`). Un tableau vide
 * légitime (`produced === 0`) n'est pas une anomalie : il renvoie false.
 * Prédicat partagé par les deux étages de détection.
 */
function isUnusable(produced: number, usable: number): boolean {
  return produced > 0 && usable === 0;
}

/**
 * Balaie les candidats JSON d'un scratchpad DEPUIS LA FIN et renvoie le dernier
 * réellement exploitable (enveloppe `chapters` non vide + au moins un item
 * valide). On ne s'arrête donc pas au seul dernier bloc : `{"chapters":[]}` ou un
 * objet de métadonnées en fin de scratchpad ne doit pas masquer la vraie réponse
 * ni produire une liste vide silencieuse. `null` si aucun candidat n'est
 * exploitable → l'appelant poursuit le repli habituel.
 *
 * Risque résiduel assumé (non décidable par heuristique) : si le scratchpad se
 * termine par un EXEMPLE valide en apparence (items de chapitres valides) APRÈS
 * la vraie réponse, c'est l'exemple qui est retenu.
 */
function lastUsableChapters(raw: string): Proposed[] | null {
  const candidates = extractJsonObjects(raw);
  for (let i = candidates.length - 1; i >= 0; i--) {
    const parsed = rawChapters(candidates[i]);
    if (parsed && parsed.length > 0) return parsed;
  }
  return null;
}

/**
 * Chapitres bruts extraits d'un texte (sans normalize) : `null` si rien
 * d'exploitable.
 * - `mode: 'first'` (défaut, comportement historique) : le PREMIER objet fait foi.
 * - `mode: 'last'` : dernier candidat exploitable en remontant depuis la fin
 *   (scratchpad de raisonnement : l'exemple illustratif précède la réponse, un
 *   objet vide ou de métadonnées peut la suivre).
 */
function rawChapters(raw: string, mode: 'first' | 'last' = 'first'): Proposed[] | null {
  if (mode === 'last') return lastUsableChapters(raw);
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
  const items = shape.data.chapters;
  const out: Proposed[] = [];
  for (const item of items) {
    const one = toProposed(item);
    if (one) out.push(one);
  }
  if (isUnusable(items.length, out.length)) return null;
  return out;
}

/** Résultat d'analyse : liste finale (normalisée) + verdict d'exploitabilité. */
export type ChapterAnalysis = { chapters: Proposed[]; usable: boolean };

/** Tokens normalisés (minuscules, sans accents ni ponctuation) d'une phrase. */
function tokenize(text: string): string[] {
  return text.split(/\s+/).map(normalizeToken).filter(Boolean);
}

type WindowCandidate = { index: number; length: number; distance: number };

/**
 * Début aligné d'un chapitre, dans les mots du transcript :
 * 1. fenêtre de recherche glissante, distance d'édition sur tokens normalisés ;
 *    une fenêtre dans la tolérance (`maxDist`) est retenue, en PRÉFÉRANT
 *    l'occurrence la plus proche du `startSec` du modèle (les phrases répétées
 *    existent) ;
 * 2. sinon, repli documenté : si le meilleur match PARTIEL partage au moins un
 *    mot, on prend le DÉBUT DE LA PHRASE qui le contient ;
 * 3. sinon, la valeur du modèle est conservée, bornée sur un début de mot.
 * Le résultat est toujours un début de mot : jamais à l'intérieur d'un mot.
 */
function alignOneChapter(item: Proposed, words: Word[], tokens: string[], sentences: Sentence[]): number {
  const llm = item.startSec;
  const opening = item.openingWords ? tokenize(item.openingWords) : [];
  if (!opening.length || !words.length) return snapToWordStart(llm, words);

  const k = opening.length;
  const n = tokens.length;
  const maxDist = Math.max(1, Math.floor(k / 3));
  const minLen = Math.max(1, k - 1);
  const maxLen = Math.min(n, k + 1);
  let bestFull: WindowCandidate | null = null;
  let bestPartial: WindowCandidate | null = null;

  for (let i = 0; i < n; i++) {
    for (let len = minLen; len <= maxLen && i + len <= n; len++) {
      const win = tokens.slice(i, i + len);
      if (!win.some(Boolean)) continue;
      const distance = tokenEditDistance(opening, win);
      if (!bestPartial || distance < bestPartial.distance) bestPartial = { index: i, length: len, distance };
      if (distance <= maxDist) {
        const closer =
          !bestFull ||
          distance < bestFull.distance ||
          (distance === bestFull.distance &&
            Math.abs(words[i].startSec - llm) < Math.abs(words[bestFull.index].startSec - llm));
        if (closer) bestFull = { index: i, length: len, distance };
      }
    }
  }

  if (bestFull) return words[bestFull.index].startSec;
  const partial = bestPartial as WindowCandidate | null;
  if (partial && partial.length - partial.distance >= 1) {
    const sentence = sentences.find((s) => partial.index >= s.startWordIndex && partial.index < s.endWordIndex);
    if (sentence) return sentence.startSec;
  }
  return snapToWordStart(llm, words);
}

/**
 * Aligne les débuts de chapitre sur les mots horodatés, à partir de la phrase
 * d'ouverture verbatim demandée au modèle. Sans mot (transcript YouTube ou repli
 * `json`), les valeurs du modèle sont rendues telles quelles : le reste du
 * pipeline reste inchangé.
 */
export function alignChapters(items: Proposed[], words: Word[]): Proposed[] {
  if (!words.length) return items.map((c) => ({ startSec: c.startSec, title: c.title }));
  const tokens = words.map((w) => normalizeToken(w.word));
  const sentences = groupWordsIntoSentences(words, { pauseSec: SENTENCE_PAUSE_SEC, maxChars: MAX_LINE_CHARS });
  return items.map((c) => ({ startSec: alignOneChapter(c, words, tokens, sentences), title: c.title }));
}

/**
 * Analyse une réponse du LLM pour une durée connue : extraction tolérante aux
 * alias, ALIGNEMENT sur les mots (si fournis), puis normalize. `usable: false`
 * quand le modèle a produit des chapitres dont aucun ne survit (0 item valide,
 * ou tous hors durée) — à distinguer d'un `{"chapters":[]}` légitime, qui reste
 * `usable: true` avec 0 chapitre.
 */
export function analyzeChaptersJson(
  raw: string,
  durationSec: number,
  mode: 'first' | 'last' = 'first',
  words?: Word[],
): ChapterAnalysis {
  const parsed = rawChapters(raw, mode);
  if (!parsed) return { chapters: [], usable: false };
  // Alignement AVANT normalize : on cherche l'onset exact dans les mots, puis
  // normalize applique les garde-fous (0:00 en tête, 10 s, arrondi seconde).
  const aligned = words && words.length ? alignChapters(parsed, words) : parsed;
  const chapters = normalize(aligned, durationSec);
  if (isUnusable(parsed.length, chapters.length)) return { chapters: [], usable: false };
  return { chapters, usable: true };
}

/**
 * Idem extraction brute mais `[]` quand rien n'est exploitable (durée inconnue :
 * pas de normalize).
 */
export function parseChaptersJson(raw: string): Proposed[] {
  return rawChapters(raw) ?? [];
}

/**
 * Garde-fous YouTube : arrondi à la SECONDE LA PLUS PROCHE (jamais un
 * troncature), 0:00 en tête, écart minimal `MIN_GAP`, bornage par la durée.
 * `openingWords` est volontairement abandonné ici (il n'a servi qu'à
 * l'alignement et ne doit jamais atteindre la persistance).
 */
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

/** Texte exploitable d'une erreur (message + corps), pour qualifier un 400. */
function errorText(err: unknown): string {
  if (!err || typeof err !== 'object') return '';
  const e = err as { message?: unknown; error?: unknown };
  const parts = [typeof e.message === 'string' ? e.message : ''];
  try {
    if (e.error !== undefined) parts.push(JSON.stringify(e.error));
  } catch {
    /* corps non sérialisable : on se contente du message */
  }
  return parts.join(' ');
}

/**
 * Vrai seulement si l'erreur signifie que le provider ne supporte pas le
 * `response_format` demandé. 404/422 sont sans ambiguïté ; un 400 n'est retenu
 * que s'il mentionne `response_format`/`json_schema` (sinon : contexte dépassé,
 * modèle inconnu… et un second appel identique serait facturé pour rien).
 * Les erreurs d'auth, de quota, de serveur ou de réseau ne justifient jamais de
 * second appel : elles doivent remonter telles quelles.
 */
export function shouldFallbackToJsonObject(err: unknown): boolean {
  const status = (err as { status?: unknown } | null | undefined)?.status;
  if (status === 404 || status === 422) return true;
  if (status !== 400) return false;
  return /response_format|json_schema/i.test(errorText(err));
}

/** Appel réel au provider via le SDK (seule partie non testable hors ligne). */
const defaultCompleter: ChaptersCompleter = async (req) => getClient().chat.completions.create(req);

export type ProposeDeps = { complete?: ChaptersCompleter };

/** Métadonnées du chapitrage ; `words` (optionnel) active l'alignement précis. */
export type ProposeMeta = { title: string; durationSec: number; words?: Word[] };

export async function proposeChapters(
  meta: ProposeMeta,
  segs: { startSec: number; text: string }[],
  deps: ProposeDeps = {},
): Promise<Proposed[]> {
  const complete = deps.complete ?? defaultCompleter;
  const words = meta.words;

  const system = [
    'Tu découpes des vidéos YouTube en chapitres à partir de leur transcript horodaté.',
    'Règles de densité (impératives) :',
    '- Vise UN chapitre toutes les 3 à 8 minutes de vidéo.',
    '- Ne place JAMAIS deux chapitres à moins de 60 secondes d’écart.',
    '- Le premier chapitre commence à 0 seconde.',
    '- Un chapitre = un vrai changement de sujet ; startSec doit correspondre au début de ce sujet dans le transcript.',
    '- Chaque ligne du transcript est préfixée par son horodatage EXACT [m:ss.s] : choisis startSec au plus près du mot où le sujet commence.',
    '- Ajoute "openingWords" : 3 à 8 mots copiés VERBATIM dans le transcript, exactement ceux prononcés au début du chapitre (ils servent à recaler le début sur le mot précis).',
    '- Minimum 3 chapitres si la vidéo dépasse 1 minute.',
    '- Titres courts (60 caractères max), informatifs, dans la langue du transcript, sans numérotation ni emoji.',
    '- Format strict : {"chapters":[{"startSec": <entier en secondes>, "title": "<titre>", "openingWords": "<3 à 8 mots verbatim>"}]} — les clés sont exactement "startSec", "title" et "openingWords" (jamais snake_case ni un autre nom).',
    '- Réponds uniquement avec le JSON demandé.',
  ].join('\n');

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `Titre : ${meta.title}\nDurée : ${meta.durationSec}s\n\nTranscript :\n${buildTranscriptLines(segs, words)}`,
    },
  ];
  const base = { model: LLM_MODEL, temperature: 0.2 };

  let schemaError = '';
  try {
    const first = await complete({ ...base, messages, response_format: JSON_SCHEMA_FORMAT });
    const firstMessage = first.choices?.[0]?.message;
    // `content` reste autoritaire dès qu'il est exploitable.
    const fromContent = analyzeChaptersJson(firstMessage?.content ?? '', meta.durationSec, 'first', words);
    if (fromContent.usable) return fromContent.chapters;
    // Forme documentée par la probe live : `content:"[0]"` avec le JSON réel dans
    // le `reasoning` du MÊME appel → exploité ici, sans payer un second appel.
    // Le scratchpad est lu en partant de la FIN : l'exemple illustratif vient
    // avant la réponse finale. Un dernier objet sans chapitre exploitable est
    // rejeté (on poursuit vers json_object).
    const fromReasoning = analyzeChaptersJson(firstMessage?.reasoning ?? '', meta.durationSec, 'last', words);
    if (fromReasoning.usable) return fromReasoning.chapters;
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
  const fromSecondContent = analyzeChaptersJson(message?.content ?? '', meta.durationSec, 'first', words);
  if (fromSecondContent.usable) return fromSecondContent.chapters;
  // Dernier recours : certains modèles (raisonneurs) déposent le JSON réel dans
  // `reasoning` en laissant `content` inutilisable (même lecture depuis la fin).
  const fromSecondReasoning = analyzeChaptersJson(message?.reasoning ?? '', meta.durationSec, 'last', words);
  if (fromSecondReasoning.usable) return fromSecondReasoning.chapters;

  throw new UnusableChapterOutputError(
    `aucun objet JSON de chapitres extractible (model ${LLM_MODEL}` +
      `${schemaError ? `, json_schema refusé : ${schemaError}` : ''}` +
      `, content reçu : ${JSON.stringify(message?.content ?? null).slice(0, 160)})`,
  );
}
