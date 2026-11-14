// Tests de l'éditeur de consignes du chapitrage (prompt LLM) : résolution
// « base d'abord, sinon défaut », validation de saisie et branchement dans
// `proposeChapters`. Aucun réseau : le completer est simulé.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CHAPTER_PROMPT,
  MAX_CHAPTER_PROMPT_LENGTH,
  CHAPTER_PROMPT_EMPTY_MESSAGE,
  CHAPTER_PROMPT_TOO_SHORT_MESSAGE,
  CHAPTER_PROMPT_TOO_LONG_MESSAGE,
  chapterPromptReport,
  clearChapterPrompt,
  resolveChapterPrompt,
  storeChapterPrompt,
  validateChapterPrompt,
} from '../src/chapter-prompt.ts';
import { proposeChapters, type ChaptersCompleter, type ChaptersRequest } from '../src/chapters.ts';

test('sans réglage enregistré, les consignes par défaut sont utilisées', () => {
  clearChapterPrompt();
  const resolved = resolveChapterPrompt();
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.text, DEFAULT_CHAPTER_PROMPT);
  assert.equal(chapterPromptReport().customized, false);
});

test('un texte enregistré prime sur le défaut et le rapport signale la personnalisation', () => {
  const custom = 'Découpe selon mes règles maison : une section par idée forte, en français.';
  assert.equal(storeChapterPrompt(custom), true);
  try {
    const resolved = resolveChapterPrompt();
    assert.equal(resolved.source, 'db');
    assert.equal(resolved.text, custom);

    const report = chapterPromptReport();
    assert.equal(report.customized, true);
    assert.equal(report.text, custom);
    assert.equal(report.default, DEFAULT_CHAPTER_PROMPT);
    assert.ok(report.updatedAt && !Number.isNaN(Date.parse(report.updatedAt)));
  } finally {
    clearChapterPrompt();
  }
});

test('une valeur stockée vide ou blanche retombe sur le défaut', () => {
  assert.equal(storeChapterPrompt('   '), true);
  const resolved = resolveChapterPrompt();
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.text, DEFAULT_CHAPTER_PROMPT);
  clearChapterPrompt();
});

test('validation : vide, trop court et trop long sont refusés en français', () => {
  assert.deepEqual(validateChapterPrompt(''), { ok: false, message: CHAPTER_PROMPT_EMPTY_MESSAGE });
  assert.deepEqual(validateChapterPrompt('   '), { ok: false, message: CHAPTER_PROMPT_EMPTY_MESSAGE });
  assert.deepEqual(validateChapterPrompt('court'), { ok: false, message: CHAPTER_PROMPT_TOO_SHORT_MESSAGE });
  assert.deepEqual(validateChapterPrompt('x'.repeat(MAX_CHAPTER_PROMPT_LENGTH + 1)), {
    ok: false,
    message: CHAPTER_PROMPT_TOO_LONG_MESSAGE,
  });
  // Valeurs acceptées : défaut, et texte à la borne haute exacte.
  assert.deepEqual(validateChapterPrompt(DEFAULT_CHAPTER_PROMPT), { ok: true });
  assert.deepEqual(validateChapterPrompt('x'.repeat(MAX_CHAPTER_PROMPT_LENGTH)), { ok: true });
  // Entrée non textuelle : traitée comme vide (jamais une exception).
  assert.deepEqual(validateChapterPrompt(123), { ok: false, message: CHAPTER_PROMPT_EMPTY_MESSAGE });
});

test('le chapitrage envoie les consignes enregistrées ET garde la partie technique verrouillée', async () => {
  const custom = 'Mes consignes personnalisées : une idée par chapitre, sans emoji ni numérotation.';
  storeChapterPrompt(custom);
  try {
    let system = '';
    const complete: ChaptersCompleter = async (req: ChaptersRequest) => {
      system = String(req.messages[0]?.content ?? '');
      return { choices: [{ message: { content: '{"chapters":[]}' } }] };
    };
    await proposeChapters({ title: 'T', durationSec: 600 }, [], { complete });

    assert.ok(system.includes(custom), 'les consignes personnalisées doivent être envoyées au modèle');
    assert.ok(!system.includes('3 à 8 minutes'), 'le texte par défaut ne doit plus être présent');
    // Partie technique imposée par le code, quoi qu'il arrive aux consignes.
    assert.match(system, /"startSec"/);
    assert.match(system, /"openingWords"/);
    assert.match(system, /snake_case/);
    assert.match(system, /Réponds uniquement avec le JSON demandé/);
  } finally {
    clearChapterPrompt();
  }
});

test('réinitialiser après personnalisation rétablit exactement le défaut', () => {
  storeChapterPrompt('Un texte personnalisé suffisamment long pour être valide.');
  assert.equal(resolveChapterPrompt().source, 'db');
  clearChapterPrompt();
  const resolved = resolveChapterPrompt();
  assert.equal(resolved.source, 'default');
  assert.equal(resolved.text, DEFAULT_CHAPTER_PROMPT);
});
