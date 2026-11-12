// Horodatage précis par MOT : parsing STT, découpage en phrases, alignement des
// débuts de chapitre et arrondi à la seconde (persistance/export).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveSegmentsFromWords,
  stitchWords,
  transcribeChunk,
  type Word,
} from '../src/transcribe.ts';
import {
  alignChapters,
  buildTranscriptLines,
  fmtTs,
  normalize,
} from '../src/chapters.ts';
import {
  fmtLineTs,
  groupWordsIntoSentences,
  normalizeToken,
  snapToWordStart,
} from '../src/words.ts';
import { persistLocalChapters } from '../src/local-chapters.ts';
import { sqlite } from '../src/db/index.ts';

const bytes = new Uint8Array([1, 2, 3, 4]);
const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Mots contigus à partir de `start`, un mot par entrée, 0,4 s chacun. */
function wordsAt(start: number, list: string[], step = 0.4): Word[] {
  return list.map((word, i) => ({ word, startSec: start + i * step, endSec: start + (i + 1) * step }));
}

// ---------- 1. parsing des mots + offsets absolus ----------

test('transcribeChunk parse les mots (offsets relatifs au chunk)', async () => {
  const fetchImpl: typeof fetch = async () =>
    jsonResponse({
      words: [
        { word: ' Et', start: 0, end: 0.16 },
        { word: ' promesses…', start: 21.62, end: 21.96 },
      ],
    });
  const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 22 });
  assert.deepEqual(res.words, [
    { word: 'Et', startSec: 0, endSec: 0.16 },
    { word: 'promesses…', startSec: 21.62, endSec: 21.96 },
  ]);
  // Aucun segment fourni : on en dérive des segments grossiers exploitables.
  assert.ok(res.segments.length >= 1);
  assert.match(res.segments.map((s) => s.text).join(' '), /Et promesses/);
});

test('stitchWords ajoute l’offset ABSOLU de chaque chunk et trie', () => {
  const out = stitchWords([
    { startSec: 0, segments: [], words: [{ word: 'a', startSec: 1, endSec: 1.2 }] },
    { startSec: 301.2, segments: [], words: [{ word: 'b', startSec: 0.5, endSec: 0.9 }] },
  ]);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  assert.deepEqual(
    out.map((w) => ({ word: w.word, startSec: r3(w.startSec), endSec: r3(w.endSec) })),
    [
      { word: 'a', startSec: 1, endSec: 1.2 },
      { word: 'b', startSec: 301.7, endSec: 302.1 },
    ],
  );
});

test('deriveSegmentsFromWords produit des segments non vides', () => {
  const segs = deriveSegmentsFromWords(wordsAt(0, ['Bonjour.', 'Comment', 'ça', 'va']));
  assert.ok(segs.length >= 1);
  assert.equal(segs[0].startSec, 0);
  assert.match(segs.map((s) => s.text).join(' '), /Bonjour/);
});

// ---------- 2. découpage en phrases ----------

test('groupWordsIntoSentences coupe sur la ponctuation de fin de phrase', () => {
  const lines = groupWordsIntoSentences(wordsAt(0, ['Bonjour.', 'Comment', 'ça', 'va', '?']));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'Bonjour.');
  assert.equal(lines[1].text, 'Comment ça va ?');
});

test('groupWordsIntoSentences coupe sur une pause > 0,6 s, pas en dessous', () => {
  const words: Word[] = [
    { word: 'un', startSec: 0, endSec: 0.3 },
    { word: 'deux', startSec: 0.5, endSec: 0.8 }, // pause 0,2 s : pas de coupe
    { word: 'trois', startSec: 1.6, endSec: 1.9 }, // pause 0,8 s : coupe
  ];
  const lines = groupWordsIntoSentences(words);
  assert.equal(lines.length, 2);
  assert.equal(lines[0].text, 'un deux');
  assert.equal(lines[1].text, 'trois');
});

test('groupWordsIntoSentences recoupe un long monologue sans ponctuation', () => {
  const words = wordsAt(0, Array.from({ length: 300 }, () => 'mot'), 0.1);
  const lines = groupWordsIntoSentences(words);
  assert.ok(lines.length >= 2, `attendu plusieurs lignes, reçu ${lines.length}`);
  // Aucun mot perdu : le texte total est préservé.
  const total = lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  assert.equal(total, words.map((w) => w.word).join(' '));
});

test('groupWordsIntoSentences : aucun mot -> aucune ligne', () => {
  assert.deepEqual(groupWordsIntoSentences([]), []);
});

test('buildTranscriptLines préfixe chaque ligne par son début EXACT et préserve le texte', () => {
  const words = wordsAt(0, ['Bonjour.', 'Comment', 'ça', 'va', '?']);
  const text = buildTranscriptLines([], words);
  const lines = text.split('\n');
  assert.equal(lines[0], '[0:00.0] Bonjour.');
  assert.match(lines[1], /^\[0:00\.4\] Comment ça va \?$/);
  // Texte total identique à celui des mots (seuls les horodatages changent).
  const joined = lines.map((l) => l.replace(/^\[[^\]]+\]\s*/, '')).join(' ');
  assert.equal(joined.replace(/\s+/g, ' ').trim(), words.map((w) => w.word).join(' '));
});

test('buildTranscriptLines : sans mot, repli sur l’ancien regroupement (et vide -> vide)', () => {
  assert.equal(buildTranscriptLines([], []), '');
  const legacy = buildTranscriptLines([{ startSec: 0, text: 'texte' }], []);
  assert.equal(legacy, '[0:00] texte');
});

test('fmtLineTs formate en m:ss.s', () => {
  assert.equal(fmtLineTs(0), '0:00.0');
  assert.equal(fmtLineTs(65.24), '1:05.2');
  assert.equal(fmtLineTs(3599.9), '59:59.9');
});

// ---------- 3. alignement sur les mots ----------

test('alignChapters : correspondance exacte -> début du premier mot', () => {
  const words = wordsAt(10, ['bonjour', 'tout', 'le', 'monde']);
  const out = alignChapters([{ startSec: 9, title: 'T', openingWords: 'bonjour tout le monde' }], words);
  assert.equal(out[0].startSec, 10);
});

test('alignChapters : ouverture légèrement paraphrasée (1 substitution) tolérée', () => {
  const words = wordsAt(10, ['bonjour', 'tout', 'le', 'monde']);
  const out = alignChapters([{ startSec: 9, title: 'T', openingWords: 'bonjour tous le monde' }], words);
  assert.equal(out[0].startSec, 10);
});

test('alignChapters : phrase répétée -> occurrence la plus proche de startSec', () => {
  const first = wordsAt(10, ['bonjour', 'tout', 'le', 'monde']);
  const second = wordsAt(100, ['bonjour', 'tout', 'le', 'monde']);
  const words = [...first, ...second];
  const near = alignChapters([{ startSec: 95, title: 'T', openingWords: 'bonjour tout le monde' }], words);
  const far = alignChapters([{ startSec: 5, title: 'T', openingWords: 'bonjour tout le monde' }], words);
  assert.equal(near[0].startSec, 100);
  assert.equal(far[0].startSec, 10);
});

test('alignChapters : accents, casse et ponctuation normalisés', () => {
  const words = wordsAt(20, ['Où', 'est', 'la', 'gare']);
  const out = alignChapters([{ startSec: 18, title: 'T', openingWords: 'ou EST la gare ?' }], words);
  assert.equal(out[0].startSec, 20);
  assert.equal(normalizeToken('Promesses…'), 'promesses');
  assert.equal(normalizeToken('Où'), 'ou');
});

test('alignChapters : échec sans mot -> valeur du LLM préservée', () => {
  const out = alignChapters([{ startSec: 42, title: 'T', openingWords: 'x y z' }], []);
  assert.deepEqual(out, [{ startSec: 42, title: 'T' }]);
});

test('alignChapters : échec du match complet -> début de la PHRASE du meilleur partiel', () => {
  const sentence1 = wordsAt(0, ['nous', 'parlons', 'de', 'la', 'meteo']);
  const sentence2 = wordsAt(30, ['ensuite', 'le', 'sujet', 'principal', 'commence', 'ici']);
  const words = [...sentence1, ...sentence2];
  const out = alignChapters(
    [{ startSec: 28, title: 'T', openingWords: 'le sujet principal tres important' }],
    words,
  );
  // Le match complet échoue (2 mots en trop) ; le partiel pointe dans la 2e
  // phrase, dont le début est le premier mot (« ensuite », à 30 s).
  assert.equal(out[0].startSec, 30);
});

test('alignChapters : un début ne tombe JAMAIS à l’intérieur d’un mot', () => {
  const words: Word[] = [
    { word: 'alpha', startSec: 10, endSec: 11 },
    { word: 'beta', startSec: 12, endSec: 13 },
  ];
  // Valeur du LLM au milieu du mot « alpha » -> recalée sur son début.
  const inside = alignChapters([{ startSec: 10.5, title: 'T' }], words);
  assert.equal(inside[0].startSec, 10);
  // Valeur dans un silence -> conservée telle quelle.
  const gap = alignChapters([{ startSec: 11.5, title: 'T' }], words);
  assert.equal(gap[0].startSec, 11.5);
  // Invariant générique : jamais strictement dans un intervalle.
  for (const c of [...inside, ...gap]) {
    for (const w of words) assert.ok(!(c.startSec > w.startSec && c.startSec < w.endSec));
  }
  assert.equal(snapToWordStart(12.7, words), 12);
});

test('alignChapters : alias opening_words toléré par le parsing', async () => {
  const { parseChaptersJson } = await import('../src/chapters.ts');
  const out = parseChaptersJson('{"chapters":[{"startSec":5,"title":"T","opening_words":"a b c"}]}');
  assert.equal(out[0].openingWords, 'a b c');
});

// ---------- 4. arrondi au plus proche (persistance / export) ----------

test('fmtTs arrondit au plus proche (3:19,6 -> 3:20, jamais 3:19)', () => {
  assert.equal(fmtTs(199.6), '3:20');
  assert.equal(fmtTs(199.4), '3:19');
  assert.equal(fmtTs(0), '0:00');
});

test('normalize arrondit au plus proche avant les garde-fous', () => {
  const out = normalize(
    [
      { startSec: 0, title: 'Intro' },
      { startSec: 199.6, title: 'Milieu' },
    ],
    600,
  );
  assert.equal(out[1].startSec, 200);
});

test('persistLocalChapters stocke des secondes ENTIÈRES arrondies au plus proche', () => {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS videos (id TEXT PRIMARY KEY, title TEXT NOT NULL, channel TEXT,
    duration_sec INTEGER NOT NULL DEFAULT 0, transcript_lang TEXT, media_path TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
  sqlite.exec(`CREATE TABLE IF NOT EXISTS chapters (id INTEGER PRIMARY KEY AUTOINCREMENT, video_id TEXT NOT NULL,
    start_sec INTEGER NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL, validated INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);

  const videoId = 'local:roundingtest01';
  persistLocalChapters({
    videoId,
    title: 'Arrondi',
    durationSec: 600,
    mediaPath: 'C:/media/arrondi.mp3',
    segments: [],
    words: [],
    chapters: [
      { startSec: 0, title: 'Intro' },
      { startSec: 199.6, title: 'Milieu' },
      { startSec: 400.4, title: 'Fin' },
    ],
    text: '',
    warnings: [],
  });

  const rows = sqlite
    .prepare('SELECT start_sec FROM chapters WHERE video_id = ? ORDER BY start_sec')
    .all(videoId) as { start_sec: number }[];
  assert.deepEqual(rows.map((r) => r.start_sec), [0, 200, 400]);
});
