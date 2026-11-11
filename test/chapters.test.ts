// Tests du parsing défensif du JSON de chapitres (clients LLM variés via OpenRouter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChaptersJson, buildWarnings, chaptersToText, normalize } from '../src/chapters.ts';

test('parseChaptersJson lit un JSON nu', () => {
  const out = parseChaptersJson('{"chapters":[{"startSec":0,"title":"Intro"},{"startSec":120,"title":"Suite"}]}');
  assert.deepEqual(out, [
    { startSec: 0, title: 'Intro' },
    { startSec: 120, title: 'Suite' },
  ]);
});

test('parseChaptersJson extrait le premier bloc JSON malgré du texte autour', () => {
  const raw = 'Voici le résultat :\n```json\n{"chapters":[{"startSec":10,"title":"A"}]}\n```\nVoilà.';
  assert.deepEqual(parseChaptersJson(raw), [{ startSec: 10, title: 'A' }]);
});

test('parseChaptersJson tolère les champs manquants/invalides en filtrant', () => {
  const raw = '{"chapters":[{"startSec":5,"title":"ok"},{"title":"sans start"},{"startSec":"12","title":"string"},{"startSec":9,"title":123}]}';
  // startSec "12" est coercé, titre non-string rejeté, start absent rejeté.
  assert.deepEqual(parseChaptersJson(raw), [
    { startSec: 5, title: 'ok' },
    { startSec: 12, title: 'string' },
  ]);
});

test('parseChaptersJson renvoie [] si aucun JSON exploitable', () => {
  assert.deepEqual(parseChaptersJson('désolé, je ne peux pas'), []);
  assert.deepEqual(parseChaptersJson('{pas du json}'), []);
});

test('buildWarnings reproduit les règles du /export existant', () => {
  const chs = [
    { startSec: 0, title: 'Intro', validated: true },
    { startSec: 5, title: 'Court', validated: false },
  ];
  const w = buildWarnings(chs, { includePending: true });
  assert.ok(w.some((x) => x.includes('au moins 3 chapitres')));
  assert.ok(w.some((x) => x.includes('"Intro" dure moins de 10s')));
  assert.ok(w.some((x) => x.includes('1 chapitre(s) pas encore validé(s)')));
  // Le warning "validé" est optionnel (pipeline local = toujours fraîchement généré).
  assert.ok(!buildWarnings(chs).some((x) => x.includes('validé')));
});

test('buildWarnings signale un premier chapitre ≠ 0:00', () => {
  const w = buildWarnings([{ startSec: 30, title: 'A' }]);
  assert.ok(w.some((x) => x.includes('doit commencer à 0:00')));
});

test('normalize force 0:00 en tête et respecte l’écart mini de 10s', () => {
  const out = normalize(
    [
      { startSec: 100, title: 'B' },
      { startSec: 105, title: 'trop proche' },
      { startSec: 10, title: 'A' },
    ],
    600,
  );
  assert.deepEqual(out, [
    { startSec: 0, title: 'A' },
    { startSec: 100, title: 'B' },
  ]);
});

test('chaptersToText formatte en description YouTube', () => {
  assert.equal(
    chaptersToText([
      { startSec: 0, title: 'Intro' },
      { startSec: 3725, title: 'Fin' },
    ]),
    '0:00 Intro\n1:02:05 Fin',
  );
});
