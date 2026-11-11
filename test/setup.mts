// Préchargement de la suite de tests : `node --import ./test/setup.mts`.
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
// test). Il pose `DB_PATH` et `MEDIA_DIR` vers un dossier TEMPORAIRE UNIQUE À
// CETTE EXÉCUTION (nommé `ckr-test-<pid>-<aléa>`) **seulement s'ils ne sont pas
// déjà définis** : un test (ou un appelant) qui fixe explicitement ces variables
// garde la main. Une base par exécution garantit qu'aucune clé écrite par un
// test ne fuit vers l'exécution suivante.
import { mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

// Balayage des dossiers d'exécutions TERMINÉES. Sur Windows, un fichier SQLite
// encore ouvert ne peut pas être supprimé depuis le gestionnaire `exit` : ces
// dossiers survivraient et s'accumuleraient. On les supprime donc ici, au
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

const runDir = mkdtempSync(join(tmp, `ckr-test-${process.pid}-`));

if (!process.env.DB_PATH) process.env.DB_PATH = join(runDir, 'test.db');
if (!process.env.MEDIA_DIR) {
  process.env.MEDIA_DIR = join(runDir, 'media');
  mkdirSync(process.env.MEDIA_DIR, { recursive: true });
}

// Nettoyage immédiat : supprime le dossier de CETTE exécution à la sortie quand
// c'est possible (fichiers non verrouillés) ; sinon le balayage ci-dessus s'en
// chargera à l'exécution suivante.
process.on('exit', () => {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    /* best-effort : peut être verrouillé par SQLite (Windows) */
  }
});
