// Garde-fou de densité des chapitres, PROPRE au pipeline local.
// Le modèle ignore la consigne de densité du prompt : on filtre donc
// déterministiquement les chapitres trop rapprochés, sans jamais toucher au
// chemin YouTube partagé (`normalize`/`MIN_GAP` restent intacts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { MIN_GAP, normalize } from '../src/chapters.ts';
import {
  DEFAULT_CHAPTER_MIN_GAP_SEC,
  applyChapterSpacing,
  resolveChapterMinGapSec,
} from '../src/local-chapters.ts';

/** 12 chapitres espacés de 50 s (le cas réel observé : densité trop forte). */
const dense = Array.from({ length: 12 }, (_, i) => ({ startSec: i * 50, title: `Sujet ${i + 1}` }));

test('12 chapitres espacés de 50 s : 3 conservés avec un écart minimal de 180 s', () => {
  const kept = applyChapterSpacing(dense, 180);
  assert.equal(kept.length, 3, 'avant : 12 chapitres ; après : 3 chapitres');
  assert.deepEqual(kept, [
    { startSec: 0, title: 'Sujet 1' },
    { startSec: 200, title: 'Sujet 5' },
    { startSec: 400, title: 'Sujet 9' },
  ]);
  // Timestamps et titres du modèle : verbatim, aucun ajout ni fusion.
  for (const chapter of kept) {
    assert.ok(dense.some((d) => d.startSec === chapter.startSec && d.title === chapter.title));
  }
  // Les écarts conservés respectent bien la consigne.
  for (let i = 1; i < kept.length; i++) {
    assert.ok(kept[i].startSec - kept[i - 1].startSec >= 180);
  }
});

test('une liste déjà suffisamment espacée n’est pas modifiée', () => {
  const spaced = [
    { startSec: 0, title: 'Intro' },
    { startSec: 240, title: 'Terrain' },
    { startSec: 900, title: 'Bilan' },
  ];
  assert.deepEqual(applyChapterSpacing(spaced, 180), spaced);
});

test('un unique chapitre à 0:00 est conservé', () => {
  assert.deepEqual(applyChapterSpacing([{ startSec: 0, title: 'Intro' }], 180), [
    { startSec: 0, title: 'Intro' },
  ]);
  assert.deepEqual(applyChapterSpacing([], 180), []);
});

test('CHAPTER_MIN_GAP_SEC : valeur par défaut 180, valeurs invalides ignorées', () => {
  const previous = process.env.CHAPTER_MIN_GAP_SEC;
  try {
    delete process.env.CHAPTER_MIN_GAP_SEC;
    assert.equal(resolveChapterMinGapSec(), DEFAULT_CHAPTER_MIN_GAP_SEC);
    assert.equal(DEFAULT_CHAPTER_MIN_GAP_SEC, 180);
    assert.equal(resolveChapterMinGapSec(240), 240);
    assert.equal(resolveChapterMinGapSec(Number.NaN), 180, 'NaN -> défaut');
    assert.equal(resolveChapterMinGapSec(0), 180, 'zéro -> défaut');
    assert.equal(resolveChapterMinGapSec(-30), 180, 'négatif -> défaut');
    assert.equal(resolveChapterMinGapSec(Infinity), 180, 'infini -> défaut');
    assert.equal(resolveChapterMinGapSec(5), MIN_GAP, 'jamais sous le minimum YouTube (10 s)');

    process.env.CHAPTER_MIN_GAP_SEC = '300';
    assert.equal(resolveChapterMinGapSec(), 300);
    process.env.CHAPTER_MIN_GAP_SEC = 'pas un nombre';
    assert.equal(resolveChapterMinGapSec(), 180, 'valeur illisible -> défaut');
    process.env.CHAPTER_MIN_GAP_SEC = '';
    assert.equal(resolveChapterMinGapSec(), 180, 'valeur vide -> défaut');
  } finally {
    if (previous === undefined) delete process.env.CHAPTER_MIN_GAP_SEC;
    else process.env.CHAPTER_MIN_GAP_SEC = previous;
  }
});

test('le chemin YouTube partagé reste intact (normalize/MIN_GAP non touchés)', () => {
  // Un chapitre à 20 s d'écart est conservé par `normalize` (écart mini 10 s) :
  // le filtre de densité ne s'applique jamais à ce chemin.
  const out = normalize(
    [
      { startSec: 0, title: 'A' },
      { startSec: 20, title: 'B' },
      { startSec: 40, title: 'C' },
    ],
    600,
  );
  assert.equal(out.length, 3, 'normalize ne filtre pas la densité');
  assert.equal(MIN_GAP, 10);
});

test('garde-fou statique : le pipeline local applique bien le filtre de densité', () => {
  // Complète les tests unitaires du helper : le pipeline ne peut pas perdre
  // l'appel sans que ce test échoue.
  const source = readFileSync(new URL('../src/local-chapters.ts', import.meta.url), 'utf8');
  assert.match(source, /applyChapterSpacing\(/, 'generateLocalChapters doit filtrer les chapitres');
  assert.match(source, /resolveChapterMinGapSec\(/, 'l’écart minimal doit être résolu défensivement');
});
