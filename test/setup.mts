// Préchargement de la suite de tests : `node --import ./test/setup.mts`.
//
// Ordre des préchargements (voir le script `test`) : `test/hygiene-preload.mjs`
// d'abord (JavaScript simple, chargé avant `tsx`), puis `tsx`, puis ce fichier.
// L'hygiène du dossier temporaire est décrite dans `hygiene-preload.mjs` (suivi
// et nettoyage en sortie des dossiers de fixtures) et ci-dessous (balayage).
//
// Pourquoi : `src/db/index.ts` lit `process.env.DB_PATH` (et `MEDIA_DIR`) AU
// MOMENT DE L'IMPORT. Or un fichier de test qui importe statiquement un module
// applicatif (ex. `src/openrouter-key.ts`) charge `src/db` AVANT d'exécuter ses
// propres lignes — donc avant qu'il ne puisse poser `DB_PATH`. Sans ce
// préchargement, la suite ouvrait la base RÉELLE du développeur
// (`data/chapters.db`) : une clé OpenRouter enregistrée là faisait échouer des
// tests qui attendent « clé absente », et la suite n'était pas hermétique.
//
// Ce module est évalué avant tout fichier de test (une fois par processus de
// test). Il pose `DB_PATH`, `MEDIA_DIR` et `UPLOAD_CACHE_DIR` vers un dossier
// TEMPORAIRE UNIQUE À CETTE EXÉCUTION (nommé `ckr-test-<pid>-<aléa>`) **seulement
// s'ils ne sont pas déjà définis** : un test (ou un appelant) qui fixe
// explicitement ces variables garde la main. Une base par exécution garantit
// qu'aucune clé écrite par un test ne fuit vers l'exécution suivante.
//
// Filet de sécurité du dossier temporaire : tout dossier `ckr-*` dont l'activité
// est plus vieille qu'une heure y est supprimé au démarrage (voir
// `sweepStaleTestDirs`). Une suite complète dure environ une minute, donc rien
// de vivant ne peut être touché. Ce balayage rattrape ce que le lanceur
// `test/run-tests.mjs` n'a pas pu nettoyer (arrêt brutal, dossier verrouillé).
//
// Le balayage lui-même vit dans `test/temp-dirs.mjs` (JavaScript simple,
// partagé avec le lanceur) et est ré-exporté ici, avec les autres points
// d'entrée testables de la préparation des tests.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sweepStaleTestDirs } from './temp-dirs.mjs';

export { sweepStaleTestDirs };

const tmp = tmpdir();

/** Vrai si le processus `pid` tourne encore (EPERM = vivant mais non inspectable). */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Balayage des exécutions TERMINÉES, d'après leur PID. Sur Windows, un fichier
// SQLite encore ouvert ne peut pas être supprimé depuis le gestionnaire `exit` :
// ces dossiers survivraient et s'accumuleraient. On les supprime donc ici, au
// démarrage suivant, en ne visant QUE les dossiers dont le PID d'origine est
// mort — jamais un dossier d'exécution concurrente (encore vivante).
for (const entry of readdirSync(tmp, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const match = /^ckr-test-(\d+)-/.exec(entry.name);
  if (!match) continue;
  const pid = Number(match[1]);
  if (pid === process.pid || isAlive(pid)) continue;
  try {
    rmSync(join(tmp, entry.name), { recursive: true, force: true });
  } catch {
    /* best-effort : un dossier récalcitrant ne doit pas faire échouer la suite */
  }
}

// Filet de sécurité : tout le namespace applicatif dont l'activité est ancienne
// (les fixtures laissées par les tours précédents, entre autres).
sweepStaleTestDirs();

const runDir = mkdtempSync(join(tmp, `ckr-test-${process.pid}-`));

// Marqueurs lus par `test/hermetic-env.test.ts` : ils distinguent « valeur posée
// ici » (on exige alors un dossier temporaire propre à l'exécution) de « valeur
// fournie par l'appelant » (on exige seulement qu'elle ne soit ni la base ni le
// dossier média du dépôt). Un développeur peut ainsi passer sa propre base de
// contrôle sans rendre la suite rouge.
if (!process.env.DB_PATH) {
  process.env.DB_PATH = join(runDir, 'test.db');
  process.env.CKR_TEST_DB_SOURCE = 'preload';
} else {
  process.env.CKR_TEST_DB_SOURCE = 'caller';
}
if (!process.env.MEDIA_DIR) {
  process.env.MEDIA_DIR = join(runDir, 'media');
  mkdirSync(process.env.MEDIA_DIR, { recursive: true });
  process.env.CKR_TEST_MEDIA_SOURCE = 'preload';
} else {
  process.env.CKR_TEST_MEDIA_SOURCE = 'caller';
}
// Cache d'envoi : jamais `data/uploads` du dépôt pendant les tests. Un test qui
// veut son propre cache pose `UPLOAD_CACHE_DIR` lui-même (relu à chaque appel).
if (!process.env.UPLOAD_CACHE_DIR) {
  process.env.UPLOAD_CACHE_DIR = join(runDir, 'uploads');
  mkdirSync(process.env.UPLOAD_CACHE_DIR, { recursive: true });
}

// Nettoyage immédiat, au mieux : le dossier de cette exécution (les dossiers de
// fixtures créés par la suite sont, eux, nettoyés par `hygiene-preload.mjs`).
// Un dossier verrouillé par une base SQLite encore ouverte (Windows) résiste au
// nettoyage en sortie : le balayage du démarrage suivant s'en charge.
process.on('exit', () => {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort : peut être verrouillé par SQLite (Windows) */
  }
});
