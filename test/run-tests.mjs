// Lanceur de la suite de tests (`npm test`).
//
// Pourquoi un lanceur ? `node --test` exécute chaque fichier de test dans un
// processus enfant ; ces processus créent beaucoup de dossiers de fixtures sous
// le dossier temporaire (`mkdtemp`) et, sous Windows, un dossier contenant une
// base SQLite ENCORE OUVERTE ne peut pas être supprimé depuis le gestionnaire
// `exit` du processus : les fixtures s'accumulaient donc d'une exécution à
// l'autre (851 dossiers `ckr-*` mesurés).
//
// Ce lanceur attend la FIN de tous les enfants — plus aucun verrou n'est ouvert
// — puis supprime les dossiers `ckr-*` créés pendant CETTE exécution. Le
// balayage d'âge (1 h) de `test/setup.mts` reste le filet de sécurité pour ce
// qu'un arrêt brutal (SIGKILL) laisserait derrière lui.
//
// Limite assumée : deux `npm test` STRICTEMENT simultanés se partageraient le
// dossier temporaire ; un lanceur pourrait nettoyer les fixtures de l'autre.
// Exécuter deux suites en parallèle n'est pas un usage supporté (elles se
// disputeraient aussi le cache d'envoi et les ports).
import { spawn } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEST_DIR_PREFIX, newestActivityMs } from './temp-dirs.mjs';

/**
 * Supprime les dossiers `ckr-*` touchés depuis `since` (donc ceux de
 * l'exécution qui vient de finir : à cet instant, plus aucun enfant ne tourne)
 * et renvoie les chemins supprimés.
 *
 * Ne regarde QUE des dossiers dont le nom commence par le préfixe applicatif,
 * jamais rien hors de `root`, et ne jette jamais : un dossier récalcitrant est
 * laissé au balayage d'âge du prochain démarrage.
 */
export function cleanupRunFixtureDirs(since, root = tmpdir()) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(TEST_DIR_PREFIX)) continue;
    const full = join(root, entry.name);
    try {
      if (newestActivityMs(full) < since) continue; // antérieur à cette exécution
      rmSync(full, { recursive: true, force: true, maxRetries: 2 });
      removed.push(full);
    } catch {
      /* best-effort : le balayage d'âge reprendra la main */
    }
  }
  return removed;
}

/** Vrai si ce module est le point d'entrée (sinon il est seulement importé). */
export function isEntryPoint(argv1, moduleUrl) {
  return !!argv1 && fileURLToPath(moduleUrl) === argv1;
}

/** Lance la suite, propage son code de sortie, puis nettoie les fixtures. */
async function main() {
  const startedAt = Date.now();
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', '--import', './test/setup.mts', '--test', 'test/*.test.ts'],
    { stdio: 'inherit' },
  );
  const code = await new Promise((resolve) => {
    child.on('exit', (exitCode) => resolve(exitCode ?? 1));
    child.on('error', () => resolve(1));
  });

  const removed = cleanupRunFixtureDirs(startedAt);
  process.stdout.write(
    `[hygiène] ${removed.length} dossier(s) de fixtures de cette exécution supprimé(s) du dossier temporaire.\n`,
  );
  process.exitCode = code;
}

if (isEntryPoint(process.argv[1], import.meta.url)) {
  await main();
}
