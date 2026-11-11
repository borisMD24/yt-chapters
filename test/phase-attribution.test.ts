// Attribution de la phase : un échec du TOUT PREMIER appel de transcription ne
// doit jamais être attribué au découpage. Le chemin nominal (36 morceaux) doit
// rester intact et la progression rester monotone.
//
// `fetch` global est remplacé (aucun accès réseau) ; ffmpeg reste requis, comme
// dans le reste de la suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateLocalChapters } from '../src/local-chapters.ts';
import { MEDIA_UNREADABLE_MESSAGE } from '../src/media-check.ts';
import {
  createJobRegistry,
  OPENROUTER_KEY_MISSING_MESSAGE,
  type JobFailure,
  type JobPipeline,
  type ProgressEvent,
} from '../src/jobs.ts';

const run = promisify(execFile);
/** Clé plausible (préfixe réel + 64 caractères) : la clé n'est jamais utilisée en ligne. */
const KEY = 'sk-or-v1-' + 'f'.repeat(64);

async function until(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('délai dépassé');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Remplace `fetch` le temps du test et rend la fonction de restauration. */
function stubFetch(fake: typeof fetch): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = fake;
  return () => {
    globalThis.fetch = original;
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

async function sine(dir: string, seconds: number): Promise<string> {
  const file = join(dir, 'src.mp3');
  await run('ffmpeg', ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`, '-ac', '1', file]);
  return file;
}

/** Réponse de chapitrage factice (SDK openai) : contenu JSON exploitable. */
function chatCompletion(chapters: { startSec: number; title: string }[]): Response {
  return jsonResponse({
    id: 'chatcmpl-test',
    object: 'chat.completion',
    created: 1,
    model: 'test',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: JSON.stringify({ chapters }) },
        finish_reason: 'stop',
      },
    ],
  });
}

/** Pipeline réel (découpage + STT + chapitrage) branché sur le registre de jobs. */
const realPipeline: JobPipeline = async (input, { onProgress, signal }) => {
  const result = await generateLocalChapters(input.path, {
    chunkSec: input.chunkSec,
    maxChunks: input.maxChunks,
    onProgress,
    signal,
  });
  return {
    videoId: result.videoId,
    chapters: result.chapters,
    text: result.text,
    warnings: result.warnings,
    durationSec: result.durationSec,
  };
};

test('un échec du premier appel STT est attribué à « transcribing », jamais à « chunking »', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-phase-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await sine(dir, 7);

  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = KEY;
  // 401 « Missing Authentication header » : la cause exacte de l'incident reproduit.
  const restore = stubFetch(async () => new Response('Missing Authentication header', { status: 401 }));
  t.after(() => {
    restore();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  const phases: string[] = [];
  const traces: JobFailure[] = [];
  const pipeline: JobPipeline = async (input, ctx) => {
    const seen = (e: ProgressEvent) => {
      phases.push(e.phase);
      ctx.onProgress(e);
    };
    return realPipeline(input, { ...ctx, onProgress: seen });
  };
  const registry = createJobRegistry(pipeline, { logger: (f) => traces.push(f) });
  const job = registry.createJob({ path: src, chunkSec: 3 });
  await until(() => registry.getJob(job.id)!.status === 'error');
  const failed = registry.getJob(job.id)!;

  assert.equal(failed.phase, 'transcribing', 'la transcription a bien commencé avant l’échec');
  assert.ok(!phases.includes('chaptering'), 'aucun chapitrage ne doit avoir été tenté');
  assert.equal(failed.totalChunks, 3);
  assert.equal(failed.doneChunks, 0, 'aucun morceau transcrit avant l’échec');
  assert.equal(failed.message, OPENROUTER_KEY_MISSING_MESSAGE);
  assert.equal(traces.length, 1);
  assert.equal(traces[0].phase, 'transcribing', 'la trace serveur porte la phase réelle');
  assert.match(String((traces[0].error as Error).message), /401|Missing Authentication/);
});

test('chemin nominal (36 morceaux) : progression monotone jusqu’au total, garde de densité intacte', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-phase-ok-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await sine(dir, 80);

  const previousKey = process.env.OPENROUTER_API_KEY;
  process.env.OPENROUTER_API_KEY = KEY;
  const restore = stubFetch(async (url) => {
    const u = String(url);
    if (u.endsWith('/audio/transcriptions')) {
      return jsonResponse({ segments: [{ start: 0, end: 1, text: 'bonjour le monde' }] });
    }
    if (u.endsWith('/chat/completions')) {
      // Deux chapitres à 20 s d'écart : le premier doit survivre, le second être
      // écarté par la garde de densité (minGapSec 25).
      return chatCompletion([
        { startSec: 0, title: 'Introduction' },
        { startSec: 20, title: 'Trop proche' },
      ]);
    }
    throw new Error('URL inattendue : ' + u);
  });
  t.after(() => {
    restore();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  const events: ProgressEvent[] = [];
  const result = await generateLocalChapters(src, {
    chunkSec: 2,
    maxChunks: 36,
    minGapSec: 25,
    onProgress: (e) => events.push(e),
  });

  const transcribing = events.filter((e) => e.phase === 'transcribing');
  assert.ok(transcribing.length >= 36, `attendu au moins 36 signalements, reçu ${transcribing.length}`);
  assert.equal(transcribing[0].totalChunks, 36, '36 morceaux annoncés dès le premier signalement');
  assert.equal(transcribing[0].doneChunks, 0);
  assert.equal(transcribing[transcribing.length - 1].doneChunks, 36, 'la progression atteint le total');
  assert.equal(transcribing[transcribing.length - 1].totalChunks, 36);

  let previous = -1;
  for (const e of transcribing) {
    assert.ok(e.doneChunks >= previous, `progression non monotone : ${previous} puis ${e.doneChunks}`);
    previous = e.doneChunks;
  }

  assert.equal(result.chapters.length, 1, 'garde de densité appliquée');
  assert.equal(result.chapters[0].title, 'Introduction');
  assert.ok(result.durationSec > 70 && result.durationSec < 74, `durée inattendue : ${result.durationSec}`);
});

test('clé absente ou restée à l’exemple : échec AVANT toute requête réseau', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-phase-nonet-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = await sine(dir, 7);

  const previousKey = process.env.OPENROUTER_API_KEY;
  let calls = 0;
  // Toute requête ferait ÉCHOUER ce test : la clé non configurée ne doit jamais
  // atteindre le réseau (ni OpenRouter, ni quoi que ce soit d'autre).
  const restore = stubFetch(async () => {
    calls++;
    return new Response('requête inattendue', { status: 500 });
  });
  t.after(() => {
    restore();
    if (previousKey === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = previousKey;
  });

  for (const key of [undefined, '', 'sk-...', 'sk-votre-cle-openrouter-ici', 'trop-court']) {
    if (key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = key;
    await assert.rejects(
      () => generateLocalChapters(src, { chunkSec: 3 }),
      /OPENROUTER_API_KEY/,
      `clé ${JSON.stringify(key)} : échec attendu avant tout appel`,
    );
  }
  assert.equal(calls, 0, 'aucune requête réseau ne doit partir sans clé configurée');
});

test('un échec du découpage est attribué à « chunking », jamais à « transcribing »', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-chunkfail-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = join(dir, 'pas-un-media.mp3');
  await writeFile(src, 'ceci n’est pas de l’audio');

  let calls = 0;
  const restore = stubFetch(async () => {
    calls++;
    return new Response('requête inattendue', { status: 500 });
  });
  t.after(restore);

  const phases: string[] = [];
  const traces: JobFailure[] = [];
  const pipeline: JobPipeline = async (input, ctx) => {
    const seen = (e: ProgressEvent) => {
      phases.push(e.phase);
      ctx.onProgress(e);
    };
    return realPipeline(input, { ...ctx, onProgress: seen });
  };
  const registry = createJobRegistry(pipeline, { logger: (f) => traces.push(f) });
  const job = registry.createJob({ path: src, chunkSec: 3 });
  await until(() => registry.getJob(job.id)!.status === 'error');
  const failed = registry.getJob(job.id)!;

  assert.equal(failed.phase, 'chunking');
  assert.ok(!phases.includes('transcribing'), 'aucun signalement « transcribing » attendu');
  assert.equal(traces.length, 1);
  assert.equal(traces[0].phase, 'chunking', 'la trace serveur porte la phase réelle');
  assert.equal(failed.message, MEDIA_UNREADABLE_MESSAGE);
  assert.equal(calls, 0, 'un échec de découpage ne fait aucun appel réseau');
});
