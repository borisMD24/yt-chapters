// CLI : média local -> chapitres YouTube.
// Usage : npm run chapters -- "<fichier>" [--chunk 300] [--lang fr] [--max-chunks N] [--json]
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateLocalChapters, type LocalChaptersResult } from './local-chapters';

type Args = {
  file?: string;
  chunkSec?: number;
  lang?: string;
  maxChunks?: number;
  json: boolean;
};

const USAGE = 'Usage : npm run chapters -- "<fichier>" [--chunk 300] [--lang fr] [--max-chunks N] [--json]';

export function parseArgs(argv: string[]): Args {
  const args: Args = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--chunk') args.chunkSec = Number(argv[++i]);
    else if (a === '--lang') args.lang = argv[++i];
    else if (a === '--max-chunks') args.maxChunks = Number(argv[++i]);
    else if (!a.startsWith('--') && !args.file) args.file = a;
  }
  return args;
}

/**
 * Payload de `--json`. Inclut `segments` (transcript en mémoire) : il n'est pas
 * persisté, mais il permet de vérifier indépendamment les offsets/durées.
 */
export function jsonPayload(res: LocalChaptersResult): Record<string, unknown> {
  return {
    videoId: res.videoId,
    title: res.title,
    durationSec: res.durationSec,
    segments: res.segments,
    text: res.text,
    warnings: res.warnings,
    chapters: res.chapters,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.file) {
    console.error(USAGE);
    process.exit(1);
  }

  const res = await generateLocalChapters(args.file, {
    chunkSec: args.chunkSec,
    lang: args.lang,
    maxChunks: args.maxChunks,
  });

  if (args.json) {
    console.log(JSON.stringify(jsonPayload(res), null, 2));
    return;
  }

  console.log(res.text || '(aucun chapitre)');
  for (const w of res.warnings) console.error(`⚠️  ${w}`);
}

/** Vrai si ce module est le point d'entrée (sinon il est seulement importé). */
export function isEntryPoint(argv1: string | undefined, moduleUrl: string): boolean {
  return !!argv1 && resolve(argv1) === fileURLToPath(moduleUrl);
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
