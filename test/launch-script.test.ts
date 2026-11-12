// Tests du démarrage en un clic : l'enveloppe `Démarrer.cmd`, le script
// `scripts/launch.ps1` et son mode préflight `-Check`.
//
// `-Check` est réellement exécuté comme SOUS-PROCESSUS, mais il ne doit RIEN
// installer, RIEN démarrer et n'écrire qu'à l'intérieur de `logs/`. Aucun accès
// réseau n'est nécessaire.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
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

// ---------- consentement d'installation (invariant BLOQUANT) ----------

test('un `winget` (ou `npm`) factice prouve que -Check ne peut PAS être atteint par une installation', () => {
  // Un faux `winget` et un faux `npm` en tête de PATH : s'ils étaient appelés,
  // ils écriraient un marqueur. `-Check` ne doit toucher aucun des deux.
  const binDir = mkdtempSync(join(tmpdir(), 'ckr-launch-fakebin-'));
  const wingetMarker = join(binDir, 'winget-appele.txt');
  const npmMarker = join(binDir, 'npm-appele.txt');
  writeFileSync(join(binDir, 'winget.cmd'), `@echo off\r\necho appele> "${wingetMarker}"\r\nexit /b 1\r\n`);
  writeFileSync(join(binDir, 'npm.cmd'), `@echo off\r\necho appele> "${npmMarker}"\r\nexit /b 1\r\n`);

  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join('scripts', 'launch.ps1'), '-Check'],
    { cwd: root, encoding: 'utf8', timeout: 180_000, env: { ...process.env, PATH: `${binDir};${process.env.PATH ?? ''}` } },
  );

  assert.equal(result.status, 0, `-Check doit sortir en 0 (${result.stdout}\n${result.stderr})`);
  assert.equal(existsSync(wingetMarker), false, '-Check ne doit JAMAIS appeler winget');
  assert.equal(existsSync(npmMarker), false, '-Check ne doit jamais lancer npm');
  assert.ok(`${result.stdout}`.includes('Preflight termine'));
});

// ---------- consentement d'installation : AutomationNull doit REFUSER ----------

const consentPath = join(root, 'scripts', 'consent.ps1');

/** Exécute un script PowerShell court (encodé, donc insensible au quoting). */
function runPs(script: string, input?: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    input: input ?? '',
  });
  assert.equal(result.error, undefined, `le sous-processus doit démarrer (${result.error?.message})`);
  return `${result.stdout}`;
}

test('la décision de consentement refuse AutomationNull (entrée fermée) et n’accepte qu’un « oui »', () => {
  // Le script reproduit EXACTEMENT le motif des deux invites : défaut « n »,
  // `Read-Host`, puis la décision partagée. Sur une entrée fermée (stdin à EOF),
  // `Read-Host` ne lève pas d'exception mais renvoie AutomationNull : l'ancienne
  // forme `$answer -notmatch '…'` renvoyait alors AutomationNull (faux) et
  // laissait passer l'installation. Ce test ÉCHOUERAIT sur cette ancienne forme
  // (il afficherait INSTALLE) — c'est exactement la régression à verrouiller.
  const probe = `
. '${consentPath}'
$answer = 'n'
try { $answer = Read-Host 'Installer avec winget ? (o/N)' } catch { $answer = 'n' }
$isAutomationNull = [object]::ReferenceEquals($answer, [System.Management.Automation.Internal.AutomationNull]::Value)
'AutomationNull=' + $isAutomationNull
$decision = Test-InstallConsent $answer
'bool=' + ($decision -is [bool])
if (-not (Test-InstallConsent $answer)) { 'VERDICT=REFUSE' } else { 'VERDICT=INSTALLE' }
`;

  // 1. Entrée fermée (aucune réponse) → AutomationNull → refus.
  const closed = runPs(probe);
  assert.match(closed, /AutomationNull=True/, 'le cas testé doit bien être AutomationNull');
  // La décision doit être un VRAI booléen : une comparaison sur la valeur brute
  // renverrait AutomationNull (ni vrai ni faux), ce qui rouvrirait la faille
  // selon la façon dont le résultat est ensuite testé.
  assert.match(closed, /bool=True/, 'la décision doit renvoyer un booléen, jamais AutomationNull');
  assert.match(closed, /VERDICT=REFUSE/, 'sans réponse, aucune installation ne doit être autorisée');

  // 2. Contrôles positifs et négatifs sur de VRAIES réponses.
  for (const [input, expected] of [
    ['o\n', 'VERDICT=INSTALLE'],
    ['O\n', 'VERDICT=INSTALLE'],
    ['oui\n', 'VERDICT=INSTALLE'],
    ['yes\n', 'VERDICT=INSTALLE'],
    ['\n', 'VERDICT=REFUSE'],
    [' \n', 'VERDICT=REFUSE'],
    ['q\n', 'VERDICT=REFUSE'],
    ['n \n', 'VERDICT=REFUSE'],
    ['non\n', 'VERDICT=REFUSE'],
    ['N\n', 'VERDICT=REFUSE'],
    ['0\n', 'VERDICT=REFUSE'],
  ] as const) {
    const out = runPs(probe, input);
    assert.match(out, new RegExp(expected), `entrée ${JSON.stringify(input)} → ${expected} (sortie : ${out})`);
  }
});

test('les deux invites passent par la décision partagée (aucun garde-fou local)', () => {
  const consent = readFileSync(consentPath, 'utf8');
  const content = readFileSync(scriptPath, 'utf8');

  // La comparaison STRINGIFIÉE (la seule qui neutralise AutomationNull) vit dans
  // le module testé ci-dessus.
  assert.ok(
    consent.includes('"$Answer" -match \'^(o|oui|y|yes)$\''),
    'la décision doit comparer une CHAÎNE ("$Answer") et non la valeur brute',
  );
  // Le code exécutable (commentaires retirés : ils CITENT l'ancienne forme fautive
  // pour expliquer le piège).
  const consentCode = consent
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.ok(
    !/\$Answer -match/.test(consentCode) && !/\$Answer -notmatch/.test(consentCode),
    'aucune comparaison ne doit porter sur la valeur brute $Answer (AutomationNull passerait)',
  );
  // Les deux invites du lanceur utilisent cette décision, et aucune ne compare
  // directement la réponse (une telle comparaison rouvrirait la faille).
  assert.equal((content.match(/-not \(Test-InstallConsent \$answer\)/g) ?? []).length, 2, 'les deux invites doivent utiliser Test-InstallConsent');
  assert.ok(!/\$answer -notmatch/.test(content), 'aucune comparaison directe de $answer ne doit subsister');
  assert.ok(content.includes(". (Join-Path $PSScriptRoot 'consent.ps1')"), 'le lanceur doit charger le module de consentement');
  assert.equal((content.match(/\$answer = 'n'/g) ?? []).length, 4, 'défaut « n » pour chaque invite et son catch');
});

// ---------- base de données : db:push doit échouer bruyamment ----------

test('la création du schéma vérifie le code de sortie et arrête le démarrage en cas d’échec', () => {
  const content = readFileSync(scriptPath, 'utf8');
  // Invocation correcte : arguments séparés (une seule chaîne donne « Unknown command »).
  assert.ok(content.includes("Invoke-Npm -Arguments @('run', 'db:push')"), 'db:push doit être appelé avec des arguments séparés');
  assert.ok(!content.includes("Invoke-Npm 'run db:push'"), 'forme fautive « run db:push » interdite');
  assert.ok(/\$dbCode = Invoke-Npm -Arguments @\('run', 'db:push'\)/.test(content), 'le code de sortie doit être capturé');
  assert.ok(/if \(\$dbCode -ne 0\) \{/.test(content), 'un code non nul doit être testé');
  assert.ok(content.includes('le serveur ne sera PAS demarre'), 'un échec doit annoncer l’arrêt (pas de serveur cassé)');
  assert.ok(content.includes('$script:LastNpmOutput | Select-Object -Last 10'), 'les dernières lignes doivent être imprimées');
});

test('npm run db:push fonctionne réellement dans ce dépôt (base temporaire, hors ligne)', () => {
  const dbDir = mkdtempSync(join(tmpdir(), 'ckr-launch-dbpush-'));
  const dbPath = join(dbDir, 'schema.db');
  // `npm` est un script `.cmd` : on passe par l'interpréteur de commandes
  // (comme le ferait un double-clic), avec la base redirigée vers un fichier
  // temporaire — aucun accès réseau, aucune écriture dans le dépôt.
  const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/c', 'npm run db:push'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 180_000,
    env: { ...process.env, DB_PATH: dbPath },
  });
  assert.equal(result.status, 0, `npm run db:push doit réussir (${result.stdout}\n${result.stderr})`);
  assert.ok(existsSync(dbPath), 'la base temporaire doit être créée');
  assert.ok(!/Unknown command/i.test(`${result.stdout}${result.stderr}`), 'aucune « Unknown command » : invocation correcte');
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
