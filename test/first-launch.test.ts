// Tests de l'installation complète au premier lancement : détection (horodatage
// d'installation), phase d'installation idempotente, test de fumée multimédia,
// raccourci du Bureau et résumé final.
//
// TOUT est HORS LIGNE : aucun accès réseau, aucune installation réelle. Le
// lanceur est exécuté tel quel, mais dans un PROJET FACTICE (dossier temporaire)
// et avec des lanceurs INJECTÉS (`npm`, `ffmpeg`, `ffprobe` factices en tête de
// PATH) qui journalisent leurs appels dans un fichier. On peut ainsi compter ce
// qui est réellement exécuté — et vérifier ce qui doit être SAUTÉ (idempotence).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scriptPath = join(root, 'scripts', 'launch.ps1');
const installPath = join(root, 'scripts', 'install.ps1');
const consentPath = join(root, 'scripts', 'consent.ps1');

/** Retire les accents : les mots-clés restent comparables quel que soit l'encodage. */
function norm(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

const VALID_STAMP =
  '{"installedAt":"2026-01-01T00:00:00.0000000Z","node":"22.14.0","ffmpeg":"6.1.1","revision":"0123456789ab"}';

// ---------------------------------------------------------------------------
// Lanceurs factices : ils journalisent CHAQUE appel puis simulent le travail.
// ---------------------------------------------------------------------------

const FAKE_NPM = [
  '@echo off',
  '>>"%CKR_FAKE_LOG%" echo npm %*',
  'if "%~1"=="ci" goto dep',
  'if "%~1"=="install" goto dep',
  'if "%~1"=="start" exit /b 0',
  'if "%~1"=="run" if "%~2"=="db:push" goto db',
  'exit /b 0',
  ':dep',
  'if not exist node_modules\\.bin mkdir node_modules\\.bin',
  '(echo @echo off)> node_modules\\.bin\\tsx.cmd',
  'exit /b 0',
  ':db',
  'if not exist data mkdir data',
  '(echo x)> data\\chapters.db',
  'exit /b 0',
].join('\r\n');

const FAKE_FFMPEG = [
  '@echo off',
  '>>"%CKR_FAKE_LOG%" echo ffmpeg %*',
  'if "%~1"=="-version" goto version',
  'if not "%CKR_FFMPEG_FAIL%"=="" exit /b 1',
  'set LAST=',
  ':loop',
  'if "%~1"=="" goto endloop',
  'set LAST=%~1',
  'shift',
  'goto loop',
  ':endloop',
  '(echo mp3)> "%LAST%"',
  'exit /b 0',
  ':version',
  'echo ffmpeg version 6.1.1-fake',
  'exit /b 0',
].join('\r\n');

const FAKE_FFPROBE = [
  '@echo off',
  '>>"%CKR_FAKE_LOG%" echo ffprobe %*',
  'if not "%CKR_FFPROBE_FAIL%"=="" exit /b 1',
  'echo duration=1.0',
  'exit /b 0',
].join('\r\n');

type Fixture = { dir: string; binDir: string; fakeLog: string };

/** Projet factice : scripts du dépôt + `.env.example` + lanceurs injectés. */
function makeFixture(opts: { name: string; lock?: boolean } = { name: 'x' }): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `ckr-fl-${opts.name}-`));
  const scriptsDir = join(dir, 'scripts');
  mkdirSync(scriptsDir, { recursive: true });
  for (const file of readdirSync(join(root, 'scripts'))) {
    copyFileSync(join(root, 'scripts', file), join(scriptsDir, file));
  }
  copyFileSync(join(root, '.env.example'), join(dir, '.env.example'));
  if (opts.lock !== false) copyFileSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));

  const binDir = join(dir, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'npm.cmd'), FAKE_NPM, 'ascii');
  writeFileSync(join(binDir, 'ffmpeg.cmd'), FAKE_FFMPEG, 'ascii');
  writeFileSync(join(binDir, 'ffprobe.cmd'), FAKE_FFPROBE, 'ascii');
  return { dir, binDir, fakeLog: join(dir, 'fake-calls.log') };
}

/** Exécute le lanceur du projet factice avec les lanceurs injectés en tête de PATH. */
function runLaunch(fx: Fixture, args: string[], opts: { env?: Record<string, string> } = {}) {
  return spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(fx.dir, 'scripts', 'launch.ps1'), ...args],
    {
      cwd: fx.dir,
      encoding: 'utf8',
      timeout: 180_000,
      input: '', // entrée fermée : toute invite se refuse (défaut = refuser)
      env: { ...process.env, PATH: `${fx.binDir};${process.env.PATH ?? ''}`, CKR_FAKE_LOG: fx.fakeLog, ...(opts.env ?? {}) },
    },
  );
}

function readFakeLog(fx: Fixture): string {
  return existsSync(fx.fakeLog) ? readFileSync(fx.fakeLog, 'utf8') : '';
}

function outputOf(result: { stdout: string; stderr: string }): string {
  return norm(`${result.stdout}\n${result.stderr}`);
}

/** Projet « déjà installé » : pièces présentes + horodatage (valide ou non). */
function seedInstalled(fx: Fixture, stamp: string, opts: { pieces?: boolean } = {}): void {
  if (opts.pieces !== false) {
    mkdirSync(join(fx.dir, 'node_modules', '.bin'), { recursive: true });
    writeFileSync(join(fx.dir, 'node_modules', '.bin', 'tsx.cmd'), '@echo off\r\n', 'ascii');
    writeFileSync(join(fx.dir, '.env'), 'OPENROUTER_API_KEY=sk-or-...\r\n', 'utf8');
    mkdirSync(join(fx.dir, 'data'), { recursive: true });
    writeFileSync(join(fx.dir, 'data', 'chapters.db'), 'x', 'utf8');
  }
  mkdirSync(join(fx.dir, 'data'), { recursive: true });
  writeFileSync(join(fx.dir, 'data', 'install.json'), stamp, 'utf8');
}

/** Petite sonde PowerShell (encodée, donc insensible au quoting). */
function runPs(script: string): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120_000,
    input: '',
  });
  assert.equal(result.error, undefined, `le sous-processus doit démarrer (${result.error?.message})`);
  return `${result.stdout}`;
}

// ---------------------------------------------------------------------------
// Détection : premier lancement / déjà installé / état corrompu / -ForceInstall
// ---------------------------------------------------------------------------

test('détection : horodatage absent, valide, corrompu, et -ForceInstall', () => {
  // 1. Aucun horodatage => premier lancement.
  const fresh = makeFixture({ name: 'fresh' });
  const r1 = runLaunch(fresh, ['-Check']);
  assert.equal(r1.status, 0, outputOf(r1));
  assert.match(outputOf(r1), /Premier lancement/, 'sans horodatage, le préflight doit annoncer un premier lancement');
  assert.ok(!existsSync(join(fresh.dir, 'data', 'install.json')), '-Check ne doit pas écrire l horodatage');

  // 2. Horodatage valide + pièces présentes => déjà installé (chemin rapide).
  const done = makeFixture({ name: 'done' });
  seedInstalled(done, VALID_STAMP);
  const r2 = runLaunch(done, ['-Check']);
  assert.equal(r2.status, 0, outputOf(r2));
  assert.match(outputOf(r2), /Deja installe/, 'horodatage valide + pièces => déjà installé');
  assert.doesNotMatch(outputOf(r2), /Premier lancement/, 'pas de premier lancement quand tout est en place');

  // 3. Horodatage corrompu => premier lancement, jamais de plantage.
  const broken = makeFixture({ name: 'broken' });
  seedInstalled(broken, '{"installedAt":');
  const r3 = runLaunch(broken, ['-Check']);
  assert.equal(r3.status, 0, `un état corrompu ne doit pas planter (${outputOf(r3)})`);
  assert.match(outputOf(r3), /Premier lancement/, 'un état corrompu vaut premier lancement');
  assert.match(outputOf(r3), /illisible/, 'le préflight explique que l état est illisible');

  // 4. -ForceInstall => phase d'installation annoncée malgré un horodatage valide.
  const forced = makeFixture({ name: 'forced' });
  seedInstalled(forced, VALID_STAMP);
  const r4 = runLaunch(forced, ['-Check', '-ForceInstall']);
  assert.equal(r4.status, 0, outputOf(r4));
  assert.match(norm(outputOf(r4)), /-ForceInstall/, '-ForceInstall doit être signalé');
  assert.match(outputOf(r4), /Premier lancement force/, 'la phase serait rejouée');
});

test('un horodatage corrompu est remplacé au lancement suivant, sans plantage', () => {
  const fx = makeFixture({ name: 'repair' });
  seedInstalled(fx, '{"installedAt":'); // état illisible, pièces présentes
  const r = runLaunch(fx, ['-InstallOnly', '-NoBrowser']);
  assert.equal(r.status, 0, outputOf(r));
  const state = JSON.parse(readFileSync(join(fx.dir, 'data', 'install.json'), 'utf8'));
  assert.ok(state.installedAt, 'un horodatage exploitable est réécrit');
});

test('la révision du dépôt est lue dans un vrai dépôt git (jamais « inconnue » à tort)', (t) => {
  // Régression mesurée : `Select-Object -First 1` fermait le tube de `git
  // rev-parse` prématurément (code de sortie -1) et la révision ressortait vide.
  const probeGit = spawnSync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], { encoding: 'utf8' });
  if (probeGit.status !== 0 || !`${probeGit.stdout}`.includes('true')) {
    t.skip('git indisponible : révision non vérifiable');
    return;
  }
  const probe = [
    `. '${installPath}'`,
    `'REV=' + (Get-RepoRevision -Root '${root.replace(/'/g, "''")}')`,
  ].join('\n');
  assert.match(runPs(probe), /REV=[0-9a-f]{7,}/, 'la révision HEAD doit être lue');
});

// ---------------------------------------------------------------------------
// Phase d'installation complète
// ---------------------------------------------------------------------------

test('premier lancement : phase complète (deps, .env, base, fumée, horodatage) puis résumé', () => {
  const fx = makeFixture({ name: 'install' });
  const r = runLaunch(fx, ['-InstallOnly', '-NoBrowser']);
  const out = outputOf(r);
  assert.equal(r.status, 0, out);

  // Pièces réellement produites.
  assert.ok(existsSync(join(fx.dir, 'node_modules', '.bin', 'tsx.cmd')), 'les dépendances sont installées');
  assert.ok(existsSync(join(fx.dir, '.env')), '.env créé depuis .env.example');
  assert.ok(existsSync(join(fx.dir, 'data', 'chapters.db')), 'la base est créée (db:push)');
  const stampPath = join(fx.dir, 'data', 'install.json');
  assert.ok(existsSync(stampPath), 'l horodatage est écrit');
  const state = JSON.parse(readFileSync(stampPath, 'utf8'));
  assert.ok(state.installedAt && state.node, 'horodatage : date et version de Node');
  assert.equal(state.ffmpeg, '6.1.1-fake', 'horodatage : la version de ffmpeg est lue (jamais vide = jamais « inconnue »)');
  assert.ok('revision' in state, 'horodatage : la clé de révision du dépôt est présente');

  // Lanceurs réellement appelés (journal injecté).
  const log = readFakeLog(fx);
  assert.match(log, /npm ci/, 'les dépendances passent par npm ci (verrou présent)');
  assert.match(log, /npm run db:push/, 'le schéma est appliqué');
  assert.match(log, /ffmpeg /, 'le test de fumée encode');
  assert.match(log, /ffprobe /, 'le test de fumée relit');
  assert.doesNotMatch(log, /npm start/, 'aucun serveur démarré en mode -InstallOnly');

  // Résumé final en français.
  assert.match(out, /Test reussi/, 'le test de fumée est annoncé réussi');
  assert.match(out, /Resume de l installation/, 'un résumé final est affiché');
  assert.match(out, /Etape suivante/, 'le résumé donne l étape suivante');
  assert.match(out, /\/admin/, 'sans clé configurée, le résumé pointe /admin');
  assert.match(out, /Raccourci du Bureau ignore/, 'le raccourci est ignoré (refus par défaut)');
});

test('lancements suivants : chemin rapide, aucune étape rejouée, horodatage inchangé', () => {
  const fx = makeFixture({ name: 'fast' });
  assert.equal(runLaunch(fx, ['-InstallOnly', '-NoBrowser']).status, 0);
  const stampPath = join(fx.dir, 'data', 'install.json');
  const before = readFileSync(stampPath, 'utf8');

  writeFileSync(fx.fakeLog, ''); // on repart d'un journal vide
  const second = runLaunch(fx, ['-InstallOnly', '-NoBrowser']);
  const out = outputOf(second);
  assert.equal(second.status, 0, out);
  assert.match(out, /Chemin rapide/, 'le second lancement prend le chemin rapide');
  assert.match(out, /Installation deja faite/, 'l installation n est pas rejouée');
  assert.equal(readFakeLog(fx).trim(), '', 'le chemin rapide ne lance NI npm NI ffmpeg');
  assert.ok(!/Horodatage ecrit/.test(out), "l horodatage n'est pas réécrit au chemin rapide");
  assert.equal(readFileSync(stampPath, 'utf8'), before, 'le contenu de l horodatage est identique');
  assert.ok(statSync(stampPath).mtimeMs > 0);
});

test('-ForceInstall rejoue la phase malgré un horodatage valide (étapes déjà faites sautées)', () => {
  const fx = makeFixture({ name: 'force' });
  assert.equal(runLaunch(fx, ['-InstallOnly', '-NoBrowser']).status, 0);

  writeFileSync(fx.fakeLog, '');
  const r = runLaunch(fx, ['-InstallOnly', '-NoBrowser', '-ForceInstall']);
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  assert.match(out, /Phase d installation demandee/, 'la phase forcée est annoncée');
  assert.match(out, /Dependances deja installees/, 'les dépendances déjà présentes sont sautées');
  assert.match(readFakeLog(fx), /ffmpeg /, 'le test de fumée est rejoué');
  assert.doesNotMatch(readFakeLog(fx), /npm ci/, 'dépendances présentes : npm ci est sauté');
});

test('test de fumée en échec : diagnostic français et arrêt, sans démarrer le serveur', () => {
  const fx = makeFixture({ name: 'smokefail' });
  const r = runLaunch(fx, ['-InstallOnly', '-NoBrowser'], { env: { CKR_FFMPEG_FAIL: '1' } });
  const out = outputOf(r);
  assert.notEqual(r.status, 0, 'un test de fumée en échec doit arrêter le lancement');
  assert.match(out, /incomplete/, 'le diagnostic annonce une installation incomplète');
  assert.match(out, /ne sait pas encoder en mp3/, 'le diagnostic est explicite (mp3)');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), "l horodatage n'est pas écrit après un échec");
  assert.doesNotMatch(readFakeLog(fx), /npm start/, 'aucun serveur ne doit démarrer');
});

test('repli sans verrou : npm install quand package-lock.json est absent', () => {
  const fx = makeFixture({ name: 'nolock', lock: false });
  const r = runLaunch(fx, ['-InstallOnly', '-NoBrowser']);
  assert.equal(r.status, 0, outputOf(r));
  const log = readFakeLog(fx);
  assert.match(log, /npm install/, 'sans verrou, npm install est utilisé');
  assert.doesNotMatch(log, /npm ci/, 'npm ci exige un verrou : il est évité');
});

// ---------------------------------------------------------------------------
// -Check : aucun effet de bord
// ---------------------------------------------------------------------------

test('-Check : aucun effet de bord, rien hors de logs/, aucun lanceur appelé', () => {
  const fx = makeFixture({ name: 'checkside' });
  const r = runLaunch(fx, ['-Check']);
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  assert.match(out, /Preflight termine/);
  assert.ok(!existsSync(join(fx.dir, '.env')), '-Check ne doit pas créer .env');
  assert.ok(!existsSync(join(fx.dir, 'data', 'chapters.db')), '-Check ne doit pas créer la base');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), "-Check ne doit pas écrire l horodatage");
  assert.ok(!existsSync(join(fx.dir, 'node_modules')), '-Check ne doit pas installer les dépendances');
  assert.equal(readFakeLog(fx).trim(), '', '-Check ne doit lancer ni npm, ni winget, ni ffmpeg');
  assert.ok(!/Raccourci/.test(out), '-Check ne doit pas proposer de raccourci');

  const created = readdirSync(fx.dir).filter(
    (f) => !['scripts', 'fakebin', '.env.example', 'package-lock.json', 'logs'].includes(f),
  );
  assert.deepEqual(created, [], 'rien ne doit être créé en dehors de logs/');
});

// ---------------------------------------------------------------------------
// Raccourci du Bureau : garde (refus par défaut), jamais de création non demandée
// ---------------------------------------------------------------------------

test('raccourci : la garde refuse par défaut et aucune création n a lieu sans « oui »', () => {
  // a. Entrée fermée : la garde refuse (même règle que les installations winget).
  const probe = [
    `. '${consentPath}'`,
    `. '${installPath}'`,
    "if (Read-ShortcutConsent -Message 'Creer un raccourci ? (o/N)') { 'SHORTCUT=OUI' } else { 'SHORTCUT=REFUSE' }",
  ].join('\n');
  assert.match(runPs(probe), /SHORTCUT=REFUSE/, 'sans réponse affirmative, le raccourci est refusé');

  // b. Le code ne crée le raccourci que derrière la garde, et jamais en -Check.
  const content = readFileSync(scriptPath, 'utf8');
  assert.ok(content.includes('if (Read-ShortcutConsent'), 'la création est gardée par Read-ShortcutConsent');
  assert.ok(content.includes('New-DesktopShortcut'), 'la création du raccourci existe bien');
  const checkFn = content.slice(content.indexOf('function Invoke-Check'), content.indexOf('function Invoke-Start'));
  assert.ok(!/Shortcut|SmokeTest|InstallPhase/.test(checkFn), '-Check ne touche ni raccourci, ni fumée, ni phase d installation');
  const installSrc = readFileSync(installPath, 'utf8');
  assert.ok(installSrc.includes('Test-InstallConsent'), 'la garde réutilise la décision partagée (refus par défaut)');

  // c. Un lancement complet (entrée fermée) ne crée AUCUN raccourci.
  const fx = makeFixture({ name: 'shortcut' });
  assert.equal(runLaunch(fx, ['-InstallOnly', '-NoBrowser']).status, 0);
  const links = (readdirSync(fx.dir, { recursive: true }) as string[]).filter((f) => f.endsWith('.lnk'));
  assert.deepEqual(links, [], 'aucun raccourci créé sans réponse affirmative explicite');
});
