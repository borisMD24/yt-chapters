// Tests du démarrage en un clic : l'enveloppe `Démarrer.cmd`, le script
// `scripts/launch.ps1` et son mode préflight `-Check`.
//
// `-Check` est réellement exécuté comme SOUS-PROCESSUS (c'est ce que le
// coordinateur lancera), mais il ne doit RIEN installer, RIEN démarrer et
// n'écrire qu'à l'intérieur de `logs/`. Aucun accès réseau n'est nécessaire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cmdPath = join(root, 'Démarrer.cmd');
const scriptPath = join(root, 'scripts', 'launch.ps1');
const logsDir = join(root, 'logs');

test('Démarrer.cmd existe, se replace dans son dossier et appelle le script PowerShell', () => {
  assert.ok(existsSync(cmdPath), 'Démarrer.cmd doit exister à la racine du projet');
  const content = readFileSync(cmdPath, 'utf8');

  assert.ok(content.includes('cd /d "%~dp0"'), 'garde d’Explorateur : cd /d "%~dp0" attendu');
  assert.ok(content.includes('scripts\\launch.ps1'), 'le script doit être appelé via scripts\\launch.ps1');
  assert.ok(content.includes('-NoProfile'), 'powershell doit être lancé avec -NoProfile');
  assert.ok(content.includes('-ExecutionPolicy Bypass'), 'la stratégie d’exécution doit être contournée pour ce fichier');
  assert.ok(content.includes('-File'), 'le script doit être lancé avec -File');
  assert.ok(/\bpause\b/i.test(content), 'la fenêtre doit rester ouverte à la fin (pause)');
  assert.ok(content.includes('%*'), 'les arguments doivent être transmis (%*)');
});

test('scripts/launch.ps1 porte les options, les installations proposées et les journaux attendus', () => {
  assert.ok(existsSync(scriptPath), 'scripts/launch.ps1 doit exister');
  const content = readFileSync(scriptPath, 'utf8');

  for (const option of ['-Check', '-NoBrowser', '-Port']) {
    assert.ok(content.includes(option), `option manquante : ${option}`);
  }
  assert.ok(content.includes('OpenJS.NodeJS.LTS'), 'installation Node.js via winget attendue');
  assert.ok(content.includes('Gyan.FFmpeg'), 'installation ffmpeg via winget attendue');
  assert.ok(content.includes('--accept-source-agreements'), 'winget doit accepter ses contrats (mode non interactif)');
  assert.ok(content.includes('--accept-package-agreements'), 'winget doit accepter les contrats de paquet');
  assert.ok(content.includes('https://nodejs.org/fr/download'), 'repli manuel Node.js attendu');
  assert.ok(content.includes('https://www.gyan.dev/ffmpeg/builds/'), 'repli manuel ffmpeg attendu');
  assert.ok(content.includes('/local/health'), 'l’attente de disponibilité doit interroger /local/health');
  assert.ok(content.includes('Tee-Object'), 'la sortie du serveur doit être dupliquée (tee)');
  assert.ok(content.includes('serveur-'), 'un journal serveur-*.log est attendu');
  assert.ok(content.includes('demarrage-'), 'un journal demarrage-*.log est attendu');
  // Piège réel : après winget, le processus courant ne voit pas le nouveau PATH.
  assert.ok(
    content.includes("[Environment]::GetEnvironmentVariable('Path'"),
    'relecture du PATH depuis le registre attendue',
  );
  assert.ok(content.includes("@('Machine', 'User')"), 'les portées Machine et Utilisateur doivent être relues');
});

test('démarrage -Check : sortie 0, statut attendu, et rien créé hors de logs/', () => {
  // État AVANT (on ne doit rien modifier côté projet).
  const envPath = join(root, '.env');
  const dbPath = join(root, 'data', 'chapters.db');
  const before = {
    envExists: existsSync(envPath),
    dbExists: existsSync(dbPath),
    logs: existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.startsWith('serveur-')).length : 0,
  };
  const startedAt = Date.now();

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('scripts', 'launch.ps1'), '-Check'],
    { cwd: root, encoding: 'utf8', timeout: 180_000 },
  );

  assert.equal(result.error, undefined, `le sous-processus doit démarrer (${result.error?.message})`);
  assert.equal(result.status, 0, `-Check doit sortir en 0 (sortie : ${result.stdout}\n${result.stderr})`);
  const out = `${result.stdout}\n${result.stderr}`;

  // Lignes de statut attendues (mots-clés ASCII pour rester lisibles quel que
  // soit l'encodage de la console).
  for (const keyword of ['Node.js', 'ffmpeg', 'ffprobe', 'node_modules', '.env', 'chapters.db', 'Port', 'Preflight termine']) {
    assert.ok(out.includes(keyword), `la sortie de -Check doit mentionner « ${keyword} »\n${out}`);
  }
  // Preflight uniquement : aucun serveur.
  assert.ok(!out.includes('Serveur pret'), 'aucun serveur ne doit être démarré en mode -Check');

  // Rien créé/modifié hors de logs/.
  assert.equal(existsSync(envPath), before.envExists, '-Check ne doit pas créer de .env');
  assert.equal(existsSync(dbPath), before.dbExists, '-Check ne doit pas créer la base');
  const serveurLogs = existsSync(logsDir) ? readdirSync(logsDir).filter((f) => f.startsWith('serveur-')).length : 0;
  assert.equal(serveurLogs, before.logs, '-Check ne doit pas créer de journal serveur');

  // Le launcher, lui, écrit bien sa trace dans logs/.
  const created = readdirSync(logsDir)
    .filter((f) => f.startsWith('demarrage-'))
    .map((f) => join(logsDir, f))
    .filter((f) => statSync(f).mtimeMs >= startedAt - 2000);
  assert.ok(created.length > 0, 'un journal demarrage-*.log doit être écrit');
  const logContent = readFileSync(created[created.length - 1], 'utf8');
  assert.match(logContent, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'le journal doit contenir des horodatages');
  assert.ok(logContent.includes('Preflight termine'), 'le journal doit reprendre les étapes du launcher');
});

test('les journaux du lanceur sont ignorés par git', () => {
  const ignore = readFileSync(join(root, '.gitignore'), 'utf8');
  assert.match(ignore, /^logs\/\r?$/m, 'logs/ doit être ignoré');
});
