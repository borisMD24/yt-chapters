// Tests du client STT OpenRouter (fetch injecté) + recollage horodaté.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transcribeChunk, stitchSegments } from '../src/transcribe.ts';

const bytes = new Uint8Array([1, 2, 3, 4]);
const b64 = Buffer.from(bytes).toString('base64');

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('transcribeChunk envoie input_audio base64 sans préfixe data: en verbose_json', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (url, init) => {
    seenUrl = String(url);
    seenInit = init;
    return jsonResponse({
      segments: [
        { start: 0.5, end: 2.0, text: ' bonjour ' },
        { start: 2.0, end: 4.0, text: 'le monde' },
        { start: 4.0, end: 4.2, text: '   ' },
      ],
    });
  };

  const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', model: 'openai/whisper-large-v3-turbo', chunkDurationSec: 4 });

  assert.equal(seenUrl, 'https://openrouter.ai/api/v1/audio/transcriptions');
  const headers = seenInit!.headers as Record<string, string>;
  assert.equal(headers.Authorization, 'Bearer k');
  const body = JSON.parse(String(seenInit!.body));
  assert.equal(body.model, 'openai/whisper-large-v3-turbo');
  assert.equal(body.response_format, 'verbose_json');
  assert.equal(body.input_audio.data, b64);
  assert.ok(!body.input_audio.data.startsWith('data:'), 'pas de préfixe data:');
  assert.equal(body.input_audio.format, 'mp3');

  // Le texte vide est filtré.
  assert.deepEqual(res.segments, [
    { startSec: 0.5, endSec: 2, text: 'bonjour' },
    { startSec: 2, endSec: 4, text: 'le monde' },
  ]);
  assert.equal(res.fallback, false);
});

test('transcribeChunk demande d’abord les mots (word+segment) en verbose_json', async () => {
  let seenInit: RequestInit | undefined;
  const fetchImpl: typeof fetch = async (_url, init) => {
    seenInit = init;
    return jsonResponse({
      segments: [{ start: 0.5, end: 2.0, text: ' bonjour ' }],
      words: [
        { word: ' bonjour', start: 0.5, end: 1.2 },
        { word: ' monde', start: 1.2, end: 2.0 },
      ],
    });
  };

  const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 4 });

  const body = JSON.parse(String(seenInit!.body));
  assert.equal(body.response_format, 'verbose_json');
  assert.deepEqual(body.timestamp_granularities, ['word', 'segment']);
  assert.deepEqual(res.words, [
    { word: 'bonjour', startSec: 0.5, endSec: 1.2 },
    { word: 'monde', startSec: 1.2, endSec: 2 },
  ]);
  assert.equal(res.fallback, false);
});

test('transcribeChunk retombe sur response_format=json si verbose_json est rejeté (4xx)', async () => {
  const calls: { format: string; gran?: string[] }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    calls.push({ format: body.response_format, gran: body.timestamp_granularities });
    if (body.response_format === 'verbose_json') return jsonResponse({ error: 'unsupported' }, 400);
    return jsonResponse({ text: 'transcription simple' });
  };

  const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 12.5 });

  // Échelle de repli complète : la combinaison la plus riche d'abord, puis
  // `word` seul, puis le verbose_json historique, enfin le json simple.
  assert.deepEqual(calls, [
    { format: 'verbose_json', gran: ['word', 'segment'] },
    { format: 'verbose_json', gran: ['word'] },
    { format: 'verbose_json', gran: undefined },
    { format: 'json', gran: undefined },
  ]);
  assert.equal(res.fallback, true);
  assert.deepEqual(res.words, []);
  // Repli : un unique segment couvrant tout le chunk.
  assert.deepEqual(res.segments, [{ startSec: 0, endSec: 12.5, text: 'transcription simple' }]);
});

test('transcribeChunk réessaie sur 429 puis réussit (backoff)', async () => {
  let attempts = 0;
  const delays: number[] = [];
  const fetchImpl: typeof fetch = async () => {
    attempts++;
    if (attempts < 3) return new Response('rate limited', { status: 429 });
    return jsonResponse({ segments: [{ start: 0, end: 1, text: 'ok' }] });
  };

  const res = await transcribeChunk({
    bytes,
    fetchImpl,
    apiKey: 'k',
    chunkDurationSec: 1,
    maxRetries: 3,
    sleep: async (ms) => { delays.push(ms); },
  });

  assert.equal(attempts, 3);
  assert.deepEqual(delays, [500, 1000]); // backoff exponentiel
  assert.equal(res.segments[0].text, 'ok');
});

// ---------- échelle de repli : seuls les refus de FORMAT font avancer ----------

/** Rung réellement envoyé (format + granularités) : verrouille la séquence. */
function sentRung(init: RequestInit | undefined): { format: string; gran?: string[] } {
  const body = JSON.parse(String(init?.body));
  return { format: body.response_format, gran: body.timestamp_granularities };
}

const RUNG_1 = { format: 'verbose_json', gran: ['word', 'segment'] };
const RUNG_2 = { format: 'verbose_json', gran: ['word'] };
const RUNG_3 = { format: 'verbose_json', gran: undefined };
const RUNG_4 = { format: 'json', gran: undefined };

// Statuts qui ne signifient PAS « ce provider refuse ces paramètres » : ils
// doivent remonter APRÈS UN SEUL appel (aucun autre format ne les corrigera).
for (const status of [401, 402, 403, 408, 413]) {
  test(`échelle : ${status} -> un seul appel puis erreur (pas de repli)`, async () => {
    const rungs: { format: string; gran?: string[] }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      rungs.push(sentRung(init));
      return new Response('refus', { status });
    };
    await assert.rejects(
      () => transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 1, maxRetries: 0 }),
      new RegExp(`OpenRouter STT ${status}`),
    );
    assert.equal(rungs.length, 1);
    assert.deepEqual(rungs, [RUNG_1]);
  });
}

test('échelle : 429 -> réessai borné par maxRetries puis erreur (2 appels), sans changer de cran', async () => {
  const rungs: { format: string; gran?: string[] }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    rungs.push(sentRung(init));
    return new Response('rate limited', { status: 429 });
  };
  await assert.rejects(
    () =>
      transcribeChunk({
        bytes,
        fetchImpl,
        apiKey: 'k',
        chunkDurationSec: 1,
        maxRetries: 1,
        sleep: async () => {},
      }),
    /OpenRouter STT 429/,
  );
  assert.equal(rungs.length, 2);
  assert.deepEqual(rungs, [RUNG_1, RUNG_1]);
});

test('échelle : 500 -> un seul appel (maxRetries=0) puis erreur', async () => {
  const rungs: { format: string; gran?: string[] }[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    rungs.push(sentRung(init));
    return new Response('boom', { status: 500 });
  };
  await assert.rejects(
    () => transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 1, maxRetries: 0 }),
    /OpenRouter STT 500/,
  );
  assert.equal(rungs.length, 1);
  assert.deepEqual(rungs, [RUNG_1]);
});

test('échelle : erreur réseau -> un seul appel, propagée telle quelle', async () => {
  let calls = 0;
  const networkError = new TypeError('fetch failed');
  const fetchImpl = (async () => {
    calls++;
    throw networkError;
  }) as typeof fetch;
  await assert.rejects(
    () => transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 1 }),
    (err: unknown) => err === networkError,
  );
  assert.equal(calls, 1);
});

// Liste blanche : un refus de FORMAT fait avancer l'échelle jusqu'au `json`.
for (const status of [400, 404, 415, 422]) {
  test(`échelle : ${status} -> avance jusqu’au json (4 crans) et rend un résultat`, async () => {
    const rungs: { format: string; gran?: string[] }[] = [];
    const fetchImpl: typeof fetch = async (_url, init) => {
      const rung = sentRung(init);
      rungs.push(rung);
      if (rung.format === 'json') return jsonResponse({ text: 'texte de repli' });
      return new Response('paramètres refusés', { status });
    };
    const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 5, maxRetries: 0 });
    assert.deepEqual(rungs, [RUNG_1, RUNG_2, RUNG_3, RUNG_4]);
    assert.equal(res.fallback, true);
    assert.deepEqual(res.segments, [{ startSec: 0, endSec: 5, text: 'texte de repli' }]);
  });
}

test('stitchSegments recale les segments sur les offsets absolus et trie', () => {
  const segs = stitchSegments([
    { startSec: 0, segments: [{ startSec: 1, endSec: 2, text: 'a' }] },
    { startSec: 301.2, segments: [{ startSec: 0.5, endSec: 3, text: 'b' }] },
  ]);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  assert.equal(segs.length, 2);
  assert.deepEqual(segs[0], { startSec: 1, endSec: 2, text: 'a' });
  // 301.2 = offset réel du chunk (drift), pas index * 300.
  assert.deepEqual(
    { startSec: r3(segs[1].startSec), endSec: r3(segs[1].endSec), text: segs[1].text },
    { startSec: 301.7, endSec: 304.2, text: 'b' },
  );
});
