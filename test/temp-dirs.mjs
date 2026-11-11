// Dossier temporaire des tests : une seule définition du balayage d'âge, du
// préfixe applicatif et de la mesure d'activité, partagée par `test/setup.mts`
// (qui l'applique au démarrage) et par le lanceur `test/run-tests.mjs` (qui
// nettoie, lui, les fixtures de l'exécution qui vient de finir).
//
// Pourquoi du JavaScript simple (`.mjs`) ? Le lanceur de tests n'est pas
// transpilé par `tsx` : ce module ne doit dépendre d'aucun chargeur.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Préfixe commun à TOUT ce que la suite crée dans le dossier temporaire. */
export const TEST_DIR_PREFIX = 'ckr-';

/** Seuil du balayage de sécurité : 1 h (une suite complète dure ~1 min). */
export const STALE_TEST_DIR_MS = 60 * 60 * 1000;

/**
 * Activité la plus récente d'un dossier : sa propre date de modification ET
 * celles de ses entrées. Indispensable : écrire dans un fichier existant ne fait
 * PAS avancer la date du dossier (leçon d'un tour précédent), un dossier
 * « ancien » pouvait donc encore être utilisé.
 */
export function newestActivityMs(dir) {
  let newest;
  try {
    newest = statSync(dir).mtimeMs;
  } catch {
    return 0;
  }
  try {
    for (const entry of readdirSync(dir)) {
      try {
        newest = Math.max(newest, statSync(join(dir, entry)).mtimeMs);
      } catch {
        /* entrée disparue pendant le parcours : on l'ignore */
      }
    }
  } catch {
    /* dossier illisible : on se contente de sa propre date */
  }
  return newest;
}

/**
 * Supprime les dossiers `ckr-*` du dossier temporaire dont l'activité la plus
 * récente (dossier ET entrées) est plus vieille que `maxAgeMs` (1 h par défaut).
 *
 * Garde-fous : ne regarde QUE des DOSSIERS dont le nom commence par le préfixe
 * applicatif `ckr-` (jamais un lien symbolique — supprimer récursivement un lien
 * toucherait sa cible), jamais rien hors de `root`, et ne jette jamais (un
 * dossier verrouillé sera repris au démarrage suivant).
 * Renvoie les chemins supprimés (utile aux tests).
 */
export function sweepStaleTestDirs(now = Date.now(), maxAgeMs = STALE_TEST_DIR_MS, root = tmpdir()) {
  const removed = [];
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return removed; // racine absente ou illisible : rien à faire
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!entry.name.startsWith(TEST_DIR_PREFIX)) continue;
    const full = join(root, entry.name);
    try {
      if (now - newestActivityMs(full) < maxAgeMs) continue; // encore récent
      rmSync(full, { recursive: true, force: true, maxRetries: 2 });
      removed.push(full);
    } catch {
      /* verrouillé (base SQLite ouverte) : le prochain démarrage réessaiera */
    }
  }
  return removed;
}
