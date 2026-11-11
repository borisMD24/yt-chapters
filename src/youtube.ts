import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const YTDLP = process.env.YTDLP_BIN ?? 'yt-dlp';
const BIG = { maxBuffer: 100 * 1024 * 1024 };

export const watchUrl = (id: string) => `https://www.youtube.com/watch?v=${id}`;

export type VideoMeta = {
  id: string;
  title: string;
  channel: string | null;
  durationSec: number;
};

export async function fetchMeta(urlOrId: string): Promise<VideoMeta> {
  const url = /^[\w-]{11}$/.test(urlOrId) ? watchUrl(urlOrId) : urlOrId;
  const { stdout } = await run(YTDLP, ['-J', '--no-playlist', url], BIG);
  const j = JSON.parse(stdout);
  return {
    id: j.id,
    title: j.title,
    channel: j.channel ?? j.uploader ?? null,
    durationSec: Math.round(j.duration ?? 0),
  };
}

/** Liste les vidéos d'une chaîne/playlist (ex: https://www.youtube.com/@toto/videos) */
export async function listChannelVideos(channelUrl: string): Promise<VideoMeta[]> {
  const { stdout } = await run(YTDLP, ['--flat-playlist', '-J', channelUrl], BIG);
  const out: VideoMeta[] = [];
  const walk = (node: any) => {
    if (!node) return;
    if (Array.isArray(node.entries)) {
      node.entries.forEach(walk);
      return;
    }
    if (node.id && /^[\w-]{11}$/.test(node.id)) {
      out.push({
        id: node.id,
        title: node.title ?? node.id,
        channel: node.channel ?? node.uploader ?? null,
        durationSec: Math.round(node.duration ?? 0),
      });
    }
  };
  walk(JSON.parse(stdout));
  return out;
}

export type Segment = { startSec: number; endSec: number; text: string };

export async function fetchTranscript(
  videoId: string,
  langs: string[] = ['fr', 'en'],
): Promise<{ lang: string; segments: Segment[] } | null> {
  const dir = await mkdtemp(join(tmpdir(), 'ytc-'));
  try {
    try {
      await run(
        YTDLP,
        [
          '--skip-download',
          '--write-subs',
          '--write-auto-subs',
          '--sub-langs',
          langs.map((l) => `${l}.*`).join(','),
          '--sub-format',
          'json3',
          '-o',
          join(dir, '%(id)s'),
          watchUrl(videoId),
        ],
        BIG,
      );
    } catch {
      // yt-dlp peut sortir en erreur si une langue échoue (429...) : on regarde quand même les fichiers
    }

    const files = await readdir(dir);
    for (const lang of langs) {
      const file = files.find((f) => f.startsWith(`${videoId}.${lang}`) && f.endsWith('.json3'));
      if (!file) continue;
      const json = JSON.parse(await readFile(join(dir, file), 'utf8'));
      const segments: Segment[] = (json.events ?? [])
        .filter((e: any) => Array.isArray(e.segs))
        .map((e: any) => {
          const start = (e.tStartMs ?? 0) / 1000;
          const end = start + (e.dDurationMs ?? 0) / 1000;
          const text = e.segs
            .map((s: any) => s.utf8 ?? '')
            .join('')
            .replace(/\s+/g, ' ')
            .trim();
          return { startSec: start, endSec: end, text };
        })
        .filter((s: Segment) => s.text.length > 0);
      if (segments.length) return { lang, segments };
    }
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
