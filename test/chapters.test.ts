// Tests du parsing défensif du JSON de chapitres (clients LLM variés via OpenRouter).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseChaptersJson,
  buildWarnings,
  chaptersToText,
  normalize,
  extractJsonObject,
  proposeChapters,
  shouldFallbackToJsonObject,
  UnusableChapterOutputError,
  type ChatCompletionLike,
  type ChaptersCompleter,
  type ChaptersRequest,
} from '../src/chapters.ts';

/** Réponse simulée du SDK (content + éventuel champ reasoning hors typage SDK). */
function msg(content: string | null, reasoning?: string): ChatCompletionLike {
  return { choices: [{ message: reasoning === undefined ? { content } : { content, reasoning } }] };
}

/**
 * Faux completer : rejoue `responses` dans l'ordre et enregistre les
 * `response_format` demandés (json_schema puis json_object) pour vérifier la
 * séquence sans aucun appel réseau.
 */
function recorder(responses: ChatCompletionLike[]): { complete: ChaptersCompleter; formats: string[] } {
  const formats: string[] = [];
  const complete: ChaptersCompleter = async (req: ChaptersRequest) => {
    formats.push(req.response_format.type);
    const res = responses[Math.min(formats.length - 1, responses.length - 1)];
    if (!res) throw new Error('test: aucune réponse simulée disponible');
    return res;
  };
  return { complete, formats };
}

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

test('parseChaptersJson tolère les clés snake_case du provider (dérive live)', () => {
  // Payload réellement observé en re-validation : bon enveloppe, clés d'items en
  // snake_case → tous les items étaient rejetés (0 chapitre, aucune erreur).
  const live =
    '{"chapters":[{"start_sec":0,"title":"Introduction"},{"start_sec":312,"title":"  Suite  "},{"start":"600","titre":"Fin"},{"start_seconds":900,"title":"Bonus"}]}';
  assert.deepEqual(parseChaptersJson(live), [
    { startSec: 0, title: 'Introduction' },
    { startSec: 312, title: 'Suite' },
    { startSec: 600, title: 'Fin' },
    { startSec: 900, title: 'Bonus' },
  ]);
});

test('parseChaptersJson accepte un tableau mixte et filtre ce qui reste invalide', () => {
  const mixed =
    '{"chapters":[{"startSec":0,"title":"A"},{"start_sec":120,"title":"B"},{"start_seconds":240,"titre":"C"},{"title":"sans start"},{"start":300},{"startSec":420,"title":"   "}]}';
  assert.deepEqual(parseChaptersJson(mixed), [
    { startSec: 0, title: 'A' },
    { startSec: 120, title: 'B' },
    { startSec: 240, title: 'C' },
  ]);
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

test('extractJsonObject isole le premier objet équilibré (accolades dans les chaînes ignorées)', () => {
  assert.equal(extractJsonObject('bla {"a":"} {","b":1} fin'), '{"a":"} {","b":1}');
  assert.equal(extractJsonObject('pas de json ici'), null);
  // "[0]" ne contient aucune accolade : rien d'extractible.
  assert.equal(extractJsonObject('[0]'), null);
  assert.equal(extractJsonObject('{"a":1}'), '{"a":1}');
});

test('shouldFallbackToJsonObject : 400 seulement si response_format/json_schema est en cause', () => {
  assert.equal(shouldFallbackToJsonObject({ status: 400, message: 'Unsupported response_format: json_schema' }), true);
  assert.equal(shouldFallbackToJsonObject({ status: 400, message: 'this model does not support json_schema' }), true);
  // 400 sans rapport (contexte dépassé, modèle inconnu) : ne pas payer un 2e appel.
  assert.equal(shouldFallbackToJsonObject({ status: 400, message: 'context length exceeded' }), false);
  assert.equal(shouldFallbackToJsonObject({ status: 400, message: 'model not found' }), false);
  assert.equal(shouldFallbackToJsonObject({ status: 404 }), true);
  assert.equal(shouldFallbackToJsonObject({ status: 422 }), true);
  // Auth / quota / serveur / réseau : jamais de second appel facturé.
  assert.equal(shouldFallbackToJsonObject({ status: 401, message: 'response_format' }), false);
  assert.equal(shouldFallbackToJsonObject({ status: 403 }), false);
  assert.equal(shouldFallbackToJsonObject({ status: 429 }), false);
  assert.equal(shouldFallbackToJsonObject({ status: 500 }), false);
  assert.equal(shouldFallbackToJsonObject(new TypeError('fetch failed')), false);
  assert.equal(shouldFallbackToJsonObject(undefined), false);
});

test('proposeChapters : 400 hors response_format relayée telle quelle, sans second appel', async () => {
  const ctxErr = Object.assign(new Error('400 context length exceeded'), { status: 400 });
  const formats: string[] = [];
  const complete: ChaptersCompleter = async (req) => {
    formats.push(req.response_format.type);
    throw ctxErr;
  };
  await assert.rejects(() => proposeChapters({ title: 'T', durationSec: 600 }, [], { complete }), (err) => err === ctxErr);
  assert.deepEqual(formats, ['json_schema']);
});

test('proposeChapters : résultat JSON valide mais vide accepté (pas d’erreur)', async () => {
  const { complete, formats } = recorder([msg('{"chapters":[]}')]);
  const out = await proposeChapters({ title: 'T', durationSec: 600 }, [], { complete });
  assert.deepEqual(out, []);
  assert.deepEqual(formats, ['json_schema']); // aucun repli inutile
});

test('proposeChapters rejette si aucun objet JSON extractible (plus de perte silencieuse)', async () => {
  const { complete } = recorder([msg('désolé, je ne peux pas'), msg('[0]')]);
  await assert.rejects(
    () => proposeChapters({ title: 'T', durationSec: 600 }, [], { complete }),
    (err: unknown) => {
      assert.ok(err instanceof UnusableChapterOutputError, `type inattendu: ${String(err)}`);
      assert.match(err.message, /inexploitable/);
      return true;
    },
  );
});

test('proposeChapters : erreur d’auth (401) relayée telle quelle, une seule requête', async () => {
  const authErr = Object.assign(new Error('401 unauthorized'), { status: 401 });
  const formats: string[] = [];
  const complete: ChaptersCompleter = async (req) => {
    formats.push(req.response_format.type);
    throw authErr;
  };
  await assert.rejects(() => proposeChapters({ title: 'T', durationSec: 600 }, [], { complete }), (err) => err === authErr);
  assert.deepEqual(formats, ['json_schema']); // pas de second appel facturé
});

test('proposeChapters : repli json_object si le provider refuse json_schema (400)', async () => {
  const bad = Object.assign(new Error('400 unsupported response_format'), { status: 400 });
  const formats: string[] = [];
  const complete: ChaptersCompleter = async (req) => {
    formats.push(req.response_format.type);
    if (req.response_format.type === 'json_schema') throw bad;
    return msg('{"chapters":[{"startSec":0,"title":"Intro"}]}');
  };
  const out = await proposeChapters({ title: 'T', durationSec: 600 }, [], { complete });
  assert.deepEqual(out, [{ startSec: 0, title: 'Intro' }]);
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('proposeChapters : payload live snake_case → chapitres (plus de liste vide silencieuse)', async () => {
  // Reproduit la défaillance de re-validation : bonne enveloppe, clés d'items en
  // snake_case, provider Alibaba → renvoyait 0 chapitre sans erreur ni retry.
  const live =
    '{"chapters":[{"start_sec":0,"title":"Introduction"},{"start_sec":312,"title":"Deuxième partie"},{"start_sec":600,"title":"Conclusion"}]}';
  const { complete, formats } = recorder([msg(live)]);
  const out = await proposeChapters({ title: 'T', durationSec: 900 }, [], { complete });
  assert.deepEqual(
    out.map((c) => c.title),
    ['Introduction', 'Deuxième partie', 'Conclusion'],
  );
  assert.deepEqual(formats, ['json_schema']); // exploitable du premier coup
});

test('proposeChapters : tableau non vide mais 0 item valide = inexploitable (repli puis erreur)', async () => {
  const { complete, formats } = recorder([
    msg('{"chapters":[{"debut":0,"nom":"X"},{"debut":120,"nom":"Y"}]}'),
    msg('{"chapters":[{"foo":1}]}'),
  ]);
  await assert.rejects(
    () => proposeChapters({ title: 'T', durationSec: 600 }, [], { complete }),
    UnusableChapterOutputError,
  );
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('proposeChapters : 200 avec content "[0]" → repli json_object puis chapitres', async () => {
  const { complete, formats } = recorder([
    msg('[0]'), // aucun reasoning : rien d'exploitable dans le premier appel
    // Le content du second appel doit primer sur son reasoning (piège volontaire).
    msg('{"chapters":[{"startSec":0,"title":"Intro"},{"startSec":300,"title":"Suite"}]}', '{"chapters":[{"startSec":0,"title":"PIEGE"}]}'),
  ]);
  const out = await proposeChapters({ title: 'T', durationSec: 900 }, [], { complete });
  assert.deepEqual(out, [
    { startSec: 0, title: 'Intro' },
    { startSec: 300, title: 'Suite' },
  ]);
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('proposeChapters : reasoning du PREMIER appel exploité sans second appel payé', async () => {
  const { complete, formats } = recorder([
    // Forme documentée par la probe live : content "[0]" + JSON réel dans reasoning.
    msg('[0]', '{"chapters":[{"start_sec":0,"title":"Depuis reasoning"}]}'),
  ]);
  const out = await proposeChapters({ title: 'T', durationSec: 900 }, [], { complete });
  assert.deepEqual(out, [{ startSec: 0, title: 'Depuis reasoning' }]);
  assert.deepEqual(formats, ['json_schema']); // un seul appel
});

test('proposeChapters : dernier recours = JSON trouvé dans reasoning', async () => {
  const { complete, formats } = recorder([
    msg('[0]'), // premier appel sans reasoning exploitable
    msg('[0]', '{"chapters":[{"startSec":0,"title":"Depuis le reasoning"}]}'),
  ]);
  const out = await proposeChapters({ title: 'T', durationSec: 900 }, [], { complete });
  assert.deepEqual(out, [{ startSec: 0, title: 'Depuis le reasoning' }]);
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('proposeChapters : 200 inexploitable partout → erreur, jamais une liste vide en silence', async () => {
  const { complete, formats } = recorder([msg('[0]'), msg('[0]')]);
  await assert.rejects(
    () => proposeChapters({ title: 'T', durationSec: 600 }, [], { complete }),
    UnusableChapterOutputError,
  );
  assert.deepEqual(formats, ['json_schema', 'json_object']);
});

test('proposeChapters : OPENROUTER_API_KEY manquante → erreur explicite (pas de repli OPENAI_API_KEY)', async () => {
  const prevRouter = process.env.OPENROUTER_API_KEY;
  const prevOpenai = process.env.OPENAI_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  process.env.OPENAI_API_KEY = 'sk-test-jamais-imprime';
  try {
    await assert.rejects(
      () => proposeChapters({ title: 'T', durationSec: 600 }, []),
      (err: unknown) => {
        const m = err instanceof Error ? err.message : String(err);
        assert.match(m, /OPENROUTER_API_KEY/);
        assert.ok(!m.includes('sk-test-jamais-imprime'), 'la clé ne doit jamais apparaître dans le message');
        return true;
      },
    );
  } finally {
    if (prevRouter === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = prevRouter;
    if (prevOpenai === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = prevOpenai;
  }
});

test('proposeChapters : le prompt impose les clés exactes startSec et title', async () => {
  let system = '';
  const complete: ChaptersCompleter = async (req) => {
    system = String(req.messages[0]?.content ?? '');
    return msg('{"chapters":[]}');
  };
  await proposeChapters({ title: 'T', durationSec: 600 }, [], { complete });
  assert.match(system, /"startSec"/);
  assert.match(system, /"title"/);
  assert.match(system, /snake_case/);
});

test('proposeChapters : le prompt système impose la densité (3 à 8 min, jamais <60s)', async () => {
  let system = '';
  const complete: ChaptersCompleter = async (req) => {
    system = String(req.messages[0]?.content ?? '');
    return msg('{"chapters":[]}');
  };
  await proposeChapters({ title: 'T', durationSec: 7200 }, [], { complete });
  assert.match(system, /3 à 8 minutes/);
  assert.match(system, /60 secondes/);
  assert.match(system, /sans numérotation ni emoji/);
  assert.match(system, /60 caractères max/);
});
