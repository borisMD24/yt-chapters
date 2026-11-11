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

test('transcribeChunk retombe sur response_format=json si verbose_json est rejeté (4xx)', async () => {
  const calls: string[] = [];
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    calls.push(body.response_format);
    if (body.response_format === 'verbose_json') return jsonResponse({ error: 'unsupported' }, 400);
    return jsonResponse({ text: 'transcription simple' });
  };

  const res = await transcribeChunk({ bytes, fetchImpl, apiKey: 'k', chunkDurationSec: 12.5 });

  assert.deepEqual(calls, ['verbose_json', 'json']);
  assert.equal(res.fallback, true);
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
