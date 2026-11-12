// Primitives de transcription à l'échelle du MOT.
//
// Depuis que le STT renvoie des horodatages par mot (sub-100 ms), le transcript
// n'est plus seulement une liste de segments grossiers : on dispose d'une suite
// de mots horodatés. Ce module REGROUPE ces mots en « phrases » (lignes) et
// fournit les opérations partagées par le client STT (dérivation de segments
// grossiers) et le chapitrage LLM (transcript lisible + alignement des débuts de
// chapitre). Aucune dépendance : module pur, testable hors ligne.

export type Word = { word: string; startSec: number; endSec: number };

/** Pause (secondes) au-delà de laquelle on coupe une ligne, même sans ponctuation. */
export const SENTENCE_PAUSE_SEC = 0.6;

/** Longueur cible (caractères) d'une ligne : au-delà, on cherche la prochaine pause. */
export const MAX_LINE_CHARS = 240;

/** Plafond dur (caractères) pour un monologue sans aucune pause : on coupe quand même. */
export const HARD_MAX_LINE_CHARS = MAX_LINE_CHARS * 2;

export type Sentence = {
  /** Début EXACT du premier mot de la ligne (jamais arrondi). */
  startSec: number;
  /** Fin du dernier mot. */
  endSec: number;
  /** Texte reconstruit (mots joints par une espace, espaces normalisés). */
  text: string;
  /** Index du premier mot (inclus) dans la liste d'origine. */
  startWordIndex: number;
  /** Index de fin (EXCLU). */
  endWordIndex: number;
};

/**
 * Forme comparable d'un token : minuscules, sans accents, sans ponctuation.
 * `"Promesses…"` et `"promesses"` se comparent égaux ; `"Où"` et `"ou"` aussi.
 */
export function normalizeToken(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

/** Horodatage `m:ss.s` (dixièmes), pour préfixer une ligne de transcript. */
export function fmtLineTs(sec: number): string {
  const tenths = Math.max(0, Math.round(sec * 10));
  const m = Math.floor(tenths / 600);
  const rem = tenths % 600;
  const s = Math.floor(rem / 10);
  const d = rem % 10;
  return `${m}:${String(s).padStart(2, '0')}.${d}`;
}

/** Vrai si le token termine une phrase (ponctuation forte, guillemets/parenthèses tolérés). */
const SENTENCE_END = /[.!?…]["'»)\]]*$/;
const endsSentence = (w: string) => SENTENCE_END.test(w.trim());

/** Vrai si les intervalles des mots sont ordonnés (le tri est fait en amont). */
function textOf(words: Word[]): string {
  return words.map((w) => w.word).join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Regroupe des mots horodatés en lignes :
 * - coupure sur ponctuation de fin de phrase ;
 * - coupure sur pause > `pauseSec` (défaut 0,6 s) ;
 * - filet de sécurité pour un monologue SANS aucune pause : un plafond dur
 *   (`HARD_MAX_LINE_CHARS`) évite une ligne géante où le modèle ne peut plus se
 *   repérer. (La coupure « ligne trop longue à la prochaine pause » a été
 *   supprimée : elle était subsumée par la règle de pause et `MAX_LINE_CHARS`
 *   n'agissait jamais.)
 * Le texte total est préservé : chaque mot appartient à exactement une ligne.
 */
export function groupWordsIntoSentences(
  words: Word[],
  opts: { pauseSec?: number; maxChars?: number; hardMaxChars?: number } = {},
): Sentence[] {
  const pause = opts.pauseSec ?? SENTENCE_PAUSE_SEC;
  const maxChars = opts.maxChars ?? MAX_LINE_CHARS;
  const hardMax = opts.hardMaxChars ?? Math.max(maxChars, HARD_MAX_LINE_CHARS);
  const out: Sentence[] = [];
  let cur: Word[] = [];
  let start = 0;
  const flush = (endIndex: number) => {
    if (!cur.length) return;
    out.push({
      startSec: cur[0].startSec,
      endSec: cur[cur.length - 1].endSec,
      text: textOf(cur),
      startWordIndex: start,
      endWordIndex: endIndex,
    });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    if (!cur.length) start = i;
    cur.push(words[i]);
    const next = words[i + 1];
    if (!next) {
      flush(i + 1);
      break;
    }
    const gap = next.startSec - words[i].endSec;
    const chars = cur.reduce((acc, w) => acc + w.word.length + 1, 0);
    const overHardMax = chars >= hardMax; // monologue sans pause : coupe dure
    if (endsSentence(words[i].word) || gap > pause || overHardMax) flush(i + 1);
  }
  return out;
}

/**
 * Ramène une position au DÉBUT du mot qui la contient (invariant : un début de
 * chapitre ne tombe JAMAIS à l'intérieur d'un intervalle de mot). Une position
 * déjà dans un silence entre deux mots est laissée telle quelle.
 */
export function snapToWordStart(sec: number, words: Word[]): number {
  for (const w of words) {
    if (sec < w.startSec) break; // mots supposés triés par début
    if (sec < w.endSec) return w.startSec; // strictement à l'intérieur
  }
  return sec;
}

/** Distance d'édition (Levenshtein, coût unitaire) entre deux suites de tokens. */
export function tokenEditDistance(a: string[], b: string[]): number {
  const n = a.length;
  const m = b.length;
  if (!n) return m;
  if (!m) return n;
  let prev: number[] = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur: number[] = [i];
    for (let j = 1; j <= m; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[m];
}
