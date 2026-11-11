// Découpage d'un média local (vidéo ou audio) en chunks mp3 mono 16 kHz.
// Principe : un seul passage ffmpeg avec le muxer "segment", puis on MESURE la
// durée réelle de chaque chunk pour en déduire les offsets absolus (on ne suppose
// jamais index * chunkSec : les durées produites dérivent légèrement).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };

/** Longueur de chunk par défaut (secondes), surchargeable par env ou option. */
export const DEFAULT_CHUNK_SEC = Number(process.env.CHUNK_SEC ?? 300) || 300;

/**
 * Durée minimale d'un chunk conservé. En dessous, c'est une queue de muxer
 * "segment" (une trame mp3 ≈ 72 ms) : Whisper hallucine dessus et la durée
 * totale se retrouve gonflée.
 */
export const MIN_CHUNK_SEC = 1;

export type Chunk = {
  index: number;
  path: string;
  /** Offset absolu (secondes) dans le média source, = somme des durées précédentes. */
  startSec: number;
  durationSec: number;
};

/** Offsets absolus cumulés à partir des durées réelles mesurées. */
export function computeChunkOffsets(durations: number[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const d of durations) {
    out.push(acc);
    acc += d;
  }
  return out;
}

/** Durée exacte d'un média/chunk via ffprobe (secondes). */
export async function probeDurationSec(file: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=nw=1:nk=1',
    file,
  ]);
  const v = Number.parseFloat(String(stdout).trim());
  if (!Number.isFinite(v) || v <= 0) throw new Error(`durée illisible pour ${file}`);
  return v;
}

export type ChunkResult = { dir: string; chunks: Chunk[]; cleanup: () => Promise<void> };

/**
 * Coupe `input` en chunks mp3 de `chunkSec` secondes dans un dossier temporaire.
 * `maxChunks` borne le nombre de chunks (utile pour des runs de validation courts) :
 * on limite alors la lecture entrante avec `-t` plutôt que de tout encoder puis jeter.
 * Les queues finales de moins d'1 s (`MIN_CHUNK_SEC`) sont toujours écartées.
 */
export async function chunkToMp3(
  input: string,
  opts: { chunkSec?: number; maxChunks?: number } = {},
): Promise<ChunkResult> {
  const src = resolve(input);
  await stat(src); // échoue tôt si le fichier est absent

  const chunkSec = opts.chunkSec && opts.chunkSec > 0 ? opts.chunkSec : DEFAULT_CHUNK_SEC;
  const dir = await mkdtemp(join(tmpdir(), 'ytc-chunks-'));
  const cleanup = () => rm(dir, { recursive: true, force: true });

  try {
    const out = join(dir, 'chunk_%04d.mp3');
    const args = [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-i',
      src,
      '-vn',
      '-sn',
      '-dn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '64k',
    ];
    if (opts.maxChunks && opts.maxChunks > 0) args.push('-t', String(chunkSec * opts.maxChunks));
    args.push('-f', 'segment', '-segment_time', String(chunkSec), '-reset_timestamps', '1', out);
    await run('ffmpeg', args, BIG);

    // Le muxer "segment" émet parfois un chunk résiduel final d'une trame mp3
    // (~72 ms) quand la durée du média est proche d'un multiple de `segment_time` :
    // on écarte systématiquement ces queues de moins d'1 s (sinon Whisper les
    // transcrit et `durationSec` est gonflée).
    const all = (await readdir(dir)).filter((f) => f.endsWith('.mp3')).sort();
    const files = opts.maxChunks && opts.maxChunks > 0 ? all.slice(0, opts.maxChunks) : all;
    const durations: number[] = [];
    for (const f of files) durations.push(await probeDurationSec(join(dir, f)));
    while (durations.length && durations[durations.length - 1] < MIN_CHUNK_SEC) {
      durations.pop();
      files.pop();
    }
    const offsets = computeChunkOffsets(durations);

    const chunks: Chunk[] = files.map((f, i) => ({
      index: i,
      path: join(dir, f),
      startSec: offsets[i],
      durationSec: durations[i],
    }));
    return { dir, chunks, cleanup };
  } catch (err) {
    await cleanup();
    throw err;
  }
}
