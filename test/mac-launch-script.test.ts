// Tests du lanceur macOS : `Démarrer.command` (adaptateur double-cliquable) et
// `scripts/launch.sh` (équivalent de `scripts/launch.ps1`).
//
// DEUX FAMILLES :
//  1. ANALYSE DE SOURCE — invariants de PARITÉ entre les deux lanceurs
//     (consentement en échec-fermé, aucun serveur en mode installation seule,
//     test de fumée présent, aucune URL de serveur quand aucun serveur ne
//     tourne) + contraintes macOS (bash 3.2, pas de commande GNU-only, jamais
//     `sudo`) + le BIT EXÉCUTABLE posé dans l'index git.
//  2. LOGIQUE — le script est réellement exécuté, mais sous Git Bash, dans un
//     PROJET FACTICE (dossier temporaire) avec des commandes FACTICES en tête de
//     PATH (`node`, `npm`, `ffmpeg`, `ffprobe`, `brew`, `open`, `lsof`) qui
//     journalisent leurs appels. La détection d'OS est neutralisée par
//     `CKR_TEST_OS=Darwin`. AUCUN accès réseau : la sonde de disponibilité est
//     servie par un vrai petit serveur HTTP local.
//
// LIMITE ASSUMÉE (écrite noir sur blanc) : ces tests de logique s'exécutent ici
// sous Git Bash (bash 5) sur Windows. Ils prouvent la LOGIQUE du script, PAS son
// exécution sur macOS : ni `brew`, ni `open`, ni `lsof`, ni le comportement de
// bash 3.2 ne sont exercés. Voir la section « macOS » du README.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const shPath = join(root, 'scripts', 'launch.sh');
const commandPath = join(root, 'Démarrer.command');
const psPath = join(root, 'scripts', 'launch.ps1');
const consentPsPath = join(root, 'scripts', 'consent.ps1');

/** Retire les accents et unifie les apostrophes : les phrases restent comparables. */
function norm(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\u2018\u2019\u02bc]/g, "'");
}

/** Le code exécutable d'un script bash : commentaires de ligne retirés. */
function codeOf(source: string): string {
  return source
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
}

/** Texte d'un bloc bash délimité par deux marqueurs (bornes incluses). */
function sliceBetween(source: string, from: string, to: string): string {
  const start = source.indexOf(from);
  assert.ok(start >= 0, `marqueur de début introuvable : ${from}`);
  const end = source.indexOf(to, start);
  assert.ok(end > start, `marqueur de fin introuvable après ${from} : ${to}`);
  return source.slice(start, end);
}

// ---------------------------------------------------------------------------
// 1. Invariants de PARITÉ entre les deux lanceurs
// ---------------------------------------------------------------------------

test('Démarrer.command : shebang, dossier propre, arguments transmis, fenêtre gardée ouverte', () => {
  assert.ok(existsSync(commandPath), 'Démarrer.command doit exister à la racine');
  const content = readFileSync(commandPath, 'utf8');
  assert.match(content, /^#!\/bin\/bash/, 'shebang bash attendu');
  assert.ok(content.includes('scripts/launch.sh'), 'doit appeler scripts/launch.sh');
  assert.ok(content.includes('dirname "$0"'), 'doit se replacer dans son propre dossier');
  assert.ok(content.includes('"$@"'), 'les arguments doivent être transmis ("$@")');
  assert.ok(/read -r _/.test(content), 'la fenêtre doit rester ouverte à la fin (lecture)');
  assert.ok(/chmod=\+x/.test(content), 'le bit exécutable dans l’index git doit être documenté');
  assert.ok(/Gatekeeper/.test(content), 'la note Gatekeeper doit être présente pour le dossier téléchargé');
});

test('le bit exécutable est posé DANS L’INDEX git pour les deux fichiers macOS', () => {
  // Piège classique : sans `+x` dans l'index, un `git clone` restitue un fichier
  // non exécutable et le double-clic échoue silencieusement.
  const res = spawnSync('git', ['-C', root, 'ls-files', '-s', '-z', '--', 'Démarrer.command', 'scripts/launch.sh'], {
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, `git ls-files doit réussir (${res.stderr})`);
  const modes = new Map<string, string>();
  for (const entry of `${res.stdout}`.split('\0')) {
    if (!entry) continue;
    const m = /^(\d+)\s+\S+\s+\d+\t(.*)$/.exec(entry);
    if (m) modes.set(m[2], m[1]);
  }
  assert.equal(modes.get('Démarrer.command'), '100755', 'Démarrer.command doit être 100755 dans l’index');
  assert.equal(modes.get('scripts/launch.sh'), '100755', 'scripts/launch.sh doit être 100755 dans l’index');
});

test('scripts/launch.sh : options, outils macOS et journaux attendus', () => {
  assert.ok(existsSync(shPath), 'scripts/launch.sh doit exister');
  const content = readFileSync(shPath, 'utf8');
  for (const option of ['--check', '--no-browser', '--port', '--force-install', '--install-only']) {
    assert.ok(content.includes(option), `option manquante : ${option}`);
  }
  // Installation proposée par Homebrew (équivalent macOS de winget).
  assert.ok(content.includes('brew_run install node'), 'installation de Node.js via Homebrew attendue');
  assert.ok(content.includes('brew_run install ffmpeg'), 'installation de ffmpeg via Homebrew attendue');
  assert.ok(content.includes('https://nodejs.org/fr/download'), 'repli manuel Node.js attendu');
  assert.ok(content.includes('https://ffmpeg.org/download.html'), 'repli manuel ffmpeg (macOS) attendu');
  assert.ok(content.includes('/local/health'), 'l’attente de disponibilité doit interroger /local/health');
  assert.ok(content.includes('| tee '), 'la sortie du serveur doit être dupliquée (tee)');
  assert.ok(content.includes('serveur-'), 'un journal serveur-*.log est attendu');
  assert.ok(content.includes('demarrage-'), 'un journal demarrage-*.log est attendu');
  // Arrêt : le trap doit viser le GROUPE de processus (npm ET ses descendants).
  assert.match(content, /trap cleanup_server INT TERM EXIT/, 'trap INT/TERM/EXIT attendu');
  assert.ok(content.includes('kill -TERM -- "-$SERVER_PGID"'), 'arrêt du groupe de processus attendu');
  // macOS : outils nommés pour ce système.
  assert.ok(content.includes('open_url'), 'ouverture du navigateur via `open` attendue');
  assert.ok(content.includes('lsof'), 'détection de port via lsof attendue');
});

test('scripts/launch.sh : compatible bash 3.2 et sans commande GNU-only ni sudo', () => {
  const code = codeOf(readFileSync(shPath, 'utf8'));
  // Bash 3.2 (celui livré avec macOS) n'a ni tableaux associatifs, ni ${var,,},
  // ni mapfile, ni globstar.
  assert.ok(!/declare\s+-A/.test(code), 'pas de tableaux associatifs (declare -A)');
  assert.ok(!/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/.test(code), 'pas de ${var,,}');
  assert.ok(!/\bmapfile\b/.test(code), 'pas de mapfile');
  assert.ok(!/\bdeclare\s+-A\b/.test(code), 'pas de declare -A');
  assert.ok(!/\*\*/.test(code), 'pas de globstar (**)');
  // Commandes GNU-only interdites (variantes BSD ou repli portatif à la place).
  assert.ok(!/readlink\s+-f/.test(code), 'pas de readlink -f');
  assert.ok(!/stat\s+-c/.test(code), 'pas de stat -c');
  assert.ok(!/date\s+-d\b/.test(code), 'pas de date -d');
  assert.ok(!/sed\s+-i/.test(code), 'pas de sed -i sans suffixe');
  assert.ok(!/\bsudo\b/.test(code), 'jamais sudo');
  // bash -n prouve la syntaxe (exécuté dans le test « logique » ci-dessous).
});

test('consentement en échec-fermé : défaut refus, seule une réponse affirmative installe', () => {
  const content = readFileSync(shPath, 'utf8');
  const code = codeOf(content);
  // La liste d'acceptation est EXACTEMENT o|oui|y|yes, et rien d'autre.
  assert.match(code, /\bo\|oui\|y\|yes\)\s*return 0/, 'acceptation limitée à o|oui|y|yes');
  assert.ok(!/o\|oui\|y\|yes\|/.test(code), 'ni « oui » partiel ni autre variante ne doit être acceptée');
  // Défaut = « n », et une entrée FERMÉE (read qui échoue) refuse aussi.
  assert.match(code, /local reply=""[\s\S]*?if ! IFS= read -r reply; then\s*\n\s*reply="n"/, 'entrée fermée → refus');
  assert.match(code, /consent_ok "\$reply"/, 'la décision doit passer par consent_ok');
  // Les DEUX invites (Node.js, ffmpeg) passent par la décision partagée.
  assert.equal((code.match(/read_consent "/g) ?? []).length, 2, 'les deux invites doivent utiliser read_consent');
  assert.ok(!/\[ "\$reply" = /.test(code), 'aucune comparaison directe de la réponse ne doit subsister');
});

test('PARITÉ : les deux lanceurs refusent par défaut, proposent le test de fumée et n’affichent une URL que si un serveur tourne', () => {
  const ps = readFileSync(psPath, 'utf8');
  const sh = readFileSync(shPath, 'utf8');

  // 1. Consentement : la même liste affirmative et le même défaut des deux côtés.
  //    (La liste vit dans `consent.ps1`, chargé par le lanceur PowerShell.)
  const consentPs = readFileSync(consentPsPath, 'utf8');
  assert.ok(consentPs.includes('o|oui|y|yes'), 'le lanceur PowerShell accepte o|oui|y|yes');
  assert.ok(ps.includes(". (Join-Path $PSScriptRoot 'consent.ps1')"), 'PowerShell charge le module de consentement');
  assert.ok(sh.includes('o|oui|y|yes'), 'le lanceur macOS accepte o|oui|y|yes');
  assert.ok(ps.includes("$answer = 'n'"), 'défaut « n » côté PowerShell');
  assert.ok(sh.includes('reply="n"'), 'défaut « n » côté macOS');

  // 2. Test de fumée multimédia présent des deux côtés (même commande ffmpeg :
  //    elle vit dans `install.ps1` côté PowerShell, dans `launch.sh` côté macOS).
  const installPs = readFileSync(join(root, 'scripts', 'install.ps1'), 'utf8');
  assert.ok(installPs.includes('anullsrc'), 'test de fumée (anullsrc) absent côté PowerShell');
  assert.ok(installPs.includes('libmp3lame'), 'test de fumée (libmp3lame) absent côté PowerShell');
  assert.ok(installPs.includes('ffprobe'), 'relecture ffprobe absente côté PowerShell');
  assert.ok(sh.includes('anullsrc'), 'test de fumée (anullsrc) absent côté macOS');
  assert.ok(sh.includes('libmp3lame'), 'test de fumée (libmp3lame) absent côté macOS');
  assert.ok(sh.includes('ffprobe'), 'relecture ffprobe absente côté macOS');

  // 3. Une URL de serveur n'est affichée QUE si un serveur tourne sur un port > 0.
  assert.ok(ps.includes('$showUrl = ($ServerReady -and $ServerPort -gt 0)'), 'garde d’URL côté PowerShell');
  assert.ok(sh.includes('if [ "$server_ready" = 1 ] && [ "$server_port" -gt 0 ]'), 'garde d’URL côté macOS');
  // Le résumé « installation seule » passe explicitement « aucun serveur ».
  assert.ok(
    ps.includes('Show-InstallSummary -KeyConfigured $keyOnly -ServerPort 0 -ServerReady $false -InstallOnlyMode'),
    'résumé « installation seule » sans serveur côté PowerShell',
  );
  assert.ok(sh.includes('show_install_summary "$key_only" 0 0 1'), 'résumé « installation seule » sans serveur côté macOS');

  // 4. Aucun serveur n'est démarré en mode installation seule : le bloc
  //    --install-only rend la main AVANT tout démarrage.
  const psInstallOnly = ps.indexOf('if ($InstallOnly) {');
  const psStart = ps.indexOf('Start-Process -FilePath');
  assert.ok(psInstallOnly >= 0 && psStart > psInstallOnly, 'PowerShell : installation seule avant tout serveur');

  const block = sliceBetween(sh, 'if [ "$OPT_INSTALL_ONLY" = 1 ]; then', '  # ---------- 4. Port ----------');
  assert.match(block, /return 0/, 'le mode installation seule doit rendre la main');
  assert.ok(!block.includes('start_server'), 'aucun démarrage dans le bloc installation seule');
  assert.ok(!block.includes('npm start'), 'aucun npm start dans le bloc installation seule');
  const shInstallOnly = sh.indexOf('if [ "$OPT_INSTALL_ONLY" = 1 ]; then');
  assert.ok(shInstallOnly < sh.indexOf('start_server "$port"'), 'macOS : installation seule avant le démarrage du serveur');
});

test('les scripts de lancement macOS sont restitués en LF (jamais CRLF)', () => {
  const ga = readFileSync(join(root, '.gitattributes'), 'utf8').replace(/\r\n/g, '\n');
  assert.match(ga, /^\*\.sh text eol=lf$/m, '*.sh doit être en LF');
  assert.match(ga, /^\*\.command text eol=lf$/m, '*.command doit être en LF');
  // Le fichier est réellement en LF dans l'arbre de travail.
  assert.ok(!readFileSync(shPath, 'utf8').includes('\r\n'), 'launch.sh doit être en LF dans l’arbre de travail');
  assert.ok(!readFileSync(commandPath, 'utf8').includes('\r\n'), 'Démarrer.command doit être en LF');
});

test('README : section macOS, options et réserve honnête sur les limites de test', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  assert.match(readme, /Démarrage en un clic \(macOS\)/, 'une section macOS est attendue');
  assert.ok(readme.includes('Démarrer.command'), 'le double-clic sur Démarrer.command doit être documenté');
  assert.ok(readme.includes('--install-only'), 'les options macOS doivent être listées');
  assert.ok(/chmod \+x/.test(readme), 'la note chmod +x doit être présente');
  assert.ok(/Gatekeeper/.test(readme), 'la note Gatekeeper doit être présente');
  assert.ok(
    /pas encore été exécuté sur un vrai Mac/.test(readme),
    'le README doit dire que le lanceur macOS n’a pas encore été exécuté sur un vrai Mac',
  );
});

// ---------------------------------------------------------------------------
// 2. Logique : exécution réelle sous Git Bash, dans un projet factice
// ---------------------------------------------------------------------------

/** Chemin de bash. Sur Windows, Git Bash (le `bash` du PATH est WSL, inutilisable ici). */
function findBash(): string | null {
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files\\Git\\bin\\bash.exe',
          'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
          join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'bin', 'bash.exe'),
        ]
      : ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'];
  for (const candidate of candidates) {
    try {
      if (candidate && statSync(candidate).isFile()) return candidate;
    } catch {
      /* essai suivant */
    }
  }
  return null;
}

const bashPath = findBash();
const skipNoBash = bashPath ? false : 'bash introuvable (Git Bash requis sous Windows)';

/** Convertit un chemin Windows en chemin POSIX pour le PATH de Git Bash. */
function toPosix(p: string): string {
  let s = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(s);
  if (m) s = `/${m[1].toLowerCase()}/${m[2]}`;
  return s;
}

// Doublures : elles journalisent chaque appel dans `$CKR_FAKE_LOG`. Aucune n'est
// une vraie commande (sauf `lsof`, absent de Git Bash quand on l'injecte).
const FAKES: Record<string, string> = {
  node: `log "node $*"
case "\${1:-}" in
  --version)
    if [ -n "\${CKR_FAKE_NODE_UP:-}" ] && [ -f "$CKR_FAKE_NODE_UP" ]; then
      echo v22.14.0
    else
      echo "\${CKR_FAKE_NODE_VERSION:-v22.14.0}"
    fi
    exit 0 ;;
  *) exit 0 ;;
esac`,
  npm: `log "npm $*"
case "\${1:-}" in
  ci|install) mkdir -p node_modules/.bin; : > node_modules/.bin/tsx; exit 0 ;;
  run) if [ "\${2:-}" = "db:push" ]; then mkdir -p data; : > data/chapters.db; fi; exit 0 ;;
  start) sleep "\${CKR_FAKE_NPM_START_SLEEP:-0}"; exit 0 ;;
  *) exit 0 ;;
esac`,
  ffmpeg: `log "ffmpeg $*"
if [ "\${1:-}" = "-version" ]; then echo "ffmpeg version 6.1.1-fake"; exit 0; fi
if [ -n "\${CKR_FFMPEG_FAIL:-}" ]; then echo "fake ffmpeg: mp3 indisponible" >&2; exit 1; fi
last=''
for a in "$@"; do last="$a"; done
if [ -n "$last" ]; then echo mp3 > "$last"; fi
exit 0`,
  ffprobe: `log "ffprobe $*"
if [ -n "\${CKR_FFPROBE_FAIL:-}" ]; then exit 1; fi
echo "duration=1.0"
exit 0`,
  brew: `log "brew $*"
if [ "\${1:-}" = "install" ] && [ "\${2:-}" = "node" ] && [ -n "\${CKR_FAKE_NODE_UP:-}" ]; then
  : > "$CKR_FAKE_NODE_UP"
fi
exit 0`,
  open: `log "open $*"
exit 0`,
  // `lsof` sort non nul quand rien n'écoute : aucun port occupé. Jamais journalisé
  // (le mode --check doit laisser le journal totalement vide).
  lsof: `exit 1`,
};

function writeFake(binDir: string, name: string, body: string): void {
  const file = join(binDir, name);
  const header = '#!/bin/sh\nlog() { if [ -n "${CKR_FAKE_LOG:-}" ]; then printf \'%s\\n\' "$*" >>"$CKR_FAKE_LOG"; fi; }\n';
  writeFileSync(file, header + body + '\n', 'utf8');
  try {
    chmodSync(file, 0o755);
  } catch {
    /* Windows : le bit n'existe pas, sans conséquence pour Git Bash */
  }
}

type Fixture = { dir: string; binDir: string; fakeLog: string };

function makeFixture(name: string, opts: { lock?: boolean; omitFakes?: string[] } = {}): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `ckr-mac-${name}-`));
  // Le journal des doublures vit HORS du projet factice : il ne doit jamais être
  // compté comme un artefact créé par le lanceur (mode --check notamment).
  const logDir = mkdtempSync(join(tmpdir(), `ckr-mac-${name}-log-`));
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  copyFileSync(shPath, join(dir, 'scripts', 'launch.sh'));
  copyFileSync(join(root, '.env.example'), join(dir, '.env.example'));
  if (opts.lock !== false) copyFileSync(join(root, 'package-lock.json'), join(dir, 'package-lock.json'));
  const binDir = join(dir, 'fakebin');
  mkdirSync(binDir, { recursive: true });
  const omitted = new Set(opts.omitFakes ?? []);
  for (const [name2, body] of Object.entries(FAKES)) {
    if (!omitted.has(name2)) writeFake(binDir, name2, body);
  }
  return { dir, binDir, fakeLog: join(logDir, 'fake-calls.log') };
}

function childPathFor(fx: Fixture): string {
  return process.platform === 'win32'
    ? `${toPosix(fx.binDir)}:/usr/bin:/bin:/mingw64/bin`
    : `${fx.binDir}:/bin:/usr/bin:/usr/sbin:/sbin`;
}

function runLaunch(
  fx: Fixture,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; timeout?: number; dropTestOs?: boolean } = {},
) {
  const env: Record<string, string> = {
    ...process.env,
    PATH: childPathFor(fx),
    CKR_TEST_OS: 'Darwin',
    CKR_FAKE_LOG: fx.fakeLog,
    ...(opts.env ?? {}),
  } as Record<string, string>;
  if (opts.dropTestOs) delete env.CKR_TEST_OS;
  return spawnSync(bashPath as string, ['scripts/launch.sh', ...args], {
    cwd: fx.dir,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    input: opts.input ?? '',
    env,
  });
}

function readFakeLog(fx: Fixture): string {
  return existsSync(fx.fakeLog) ? readFileSync(fx.fakeLog, 'utf8') : '';
}

function outputOf(result: { stdout: string | Buffer; stderr: string | Buffer }): string {
  return norm(`${result.stdout}\n${result.stderr}`);
}

/** Projet « déjà installé » : pièces présentes + horodatage (valide ou non). */
function seedInstalled(fx: Fixture, stamp: string): void {
  mkdirSync(join(fx.dir, 'node_modules', '.bin'), { recursive: true });
  writeFileSync(join(fx.dir, 'node_modules', '.bin', 'tsx'), '#\n', 'utf8');
  writeFileSync(join(fx.dir, '.env'), 'OPENROUTER_API_KEY=sk-or-...\n', 'utf8');
  mkdirSync(join(fx.dir, 'data'), { recursive: true });
  writeFileSync(join(fx.dir, 'data', 'chapters.db'), 'x', 'utf8');
  writeFileSync(join(fx.dir, 'data', 'install.json'), stamp, 'utf8');
}

const VALID_STAMP = '{"installedAt":"2026-01-01T00:00:00Z","node":"22.14.0","ffmpeg":"6.1.1","revision":"abc1234"}';

test('syntaxe : bash -n accepte les deux scripts macOS', { skip: skipNoBash }, () => {
  for (const [label, file] of [['launch.sh', shPath], ['Démarrer.command', commandPath]] as const) {
    const r = spawnSync(bashPath as string, ['-n', file], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `bash -n doit accepter ${label} (${r.stdout}${r.stderr})`);
  }
});

test('la détection d’OS est neutralisée par CKR_TEST_OS (et la note n’apparaît que hors macOS)', { skip: skipNoBash }, () => {
  const withMac = makeFixture('os-mac');
  const outMac = outputOf(runLaunch(withMac, ['--check']));
  assert.ok(!outMac.includes('prevu pour macOS'), 'avec CKR_TEST_OS=Darwin, aucune note d’OS étrangère');

  const withoutMac = makeFixture('os-other');
  const outOther = outputOf(runLaunch(withoutMac, ['--check'], { dropTestOs: true }));
  if (process.platform === 'darwin') {
    assert.ok(!outOther.includes('prevu pour macOS'), 'sur un vrai macOS, la note n’apparaît pas');
  } else {
    assert.ok(outOther.includes('prevu pour macOS'), 'sans neutralisation, la note d’OS doit apparaître');
  }
});

test('--check : sortie 0, aucun effet de bord hors de logs/, aucune commande factice appelée', { skip: skipNoBash }, () => {
  const fx = makeFixture('check');
  const before = new Set(readdirSync(fx.dir));
  const r = runLaunch(fx, ['--check']);
  const out = outputOf(r);

  assert.equal(r.status, 0, out);
  for (const keyword of ['Node.js', 'ffmpeg', 'ffprobe', '.env', 'chapters.db', 'Port', 'Preflight termine']) {
    assert.ok(out.includes(keyword), `la sortie de --check doit mentionner « ${keyword} »\n${out}`);
  }
  assert.ok(!out.includes('Serveur pret'), 'aucun serveur ne doit être démarré en mode --check');

  // Rien de nouveau hors de logs/.
  const created = readdirSync(fx.dir).filter((entry) => !before.has(entry));
  assert.deepEqual(created, ['logs'], 'seul logs/ doit être créé');
  assert.ok(!existsSync(join(fx.dir, '.env')), '--check ne doit pas créer .env');
  assert.ok(!existsSync(join(fx.dir, 'data', 'chapters.db')), '--check ne doit pas créer la base');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), '--check ne doit pas écrire l’horodatage');
  assert.ok(!existsSync(join(fx.dir, 'node_modules')), '--check ne doit pas installer les dépendances');
  // Seule `node --version` (relevé des versions) est appelée : ni brew, ni npm,
  // ni ffmpeg/ffprobe.
  for (const line of readFakeLog(fx).split('\n').filter((l) => l.trim() !== '')) {
    assert.match(line, /^node --version$/, `--check ne doit appeler que « node --version », pas : ${line}`);
  }

  // Le lanceur écrit bien sa trace dans logs/.
  const logs = readdirSync(join(fx.dir, 'logs')).filter((f) => f.startsWith('demarrage-'));
  assert.ok(logs.length > 0, 'un journal demarrage-*.log doit être écrit');
  const logText = readFileSync(join(fx.dir, 'logs', logs[0]), 'utf8');
  assert.match(logText, /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, 'le journal doit horodater ses lignes');
  assert.ok(logText.includes('Préflight terminé'), 'le journal doit reprendre les étapes du lanceur');
});

test('consentement : refus par défaut (entrée fermée, vide, « q ») → ZÉRO appel à brew', { skip: skipNoBash }, () => {
  // Node.js trop ancien : le lanceur propose `brew install node` — qu'il ne doit
  // JAMAIS exécuter sans un « oui » explicite.
  for (const input of ['', '\n', ' \n', 'q\n', 'n\n', 'non\n']) {
    const fx = makeFixture('refuse');
    const marker = join(fx.dir, 'node-upgraded');
    const r = runLaunch(fx, ['--install-only', '--no-browser'], {
      input,
      env: { CKR_FAKE_NODE_VERSION: 'v18.19.0', CKR_FAKE_NODE_UP: marker },
    });
    const out = outputOf(r);
    assert.notEqual(r.status, 0, `refus (${JSON.stringify(input)}) ⇒ le lancement s'arrête\n${out}`);
    assert.ok(!readFakeLog(fx).includes('brew '), `refus (${JSON.stringify(input)}) ⇒ brew ne doit JAMAIS être appelé`);
    assert.ok(!existsSync(marker), `refus (${JSON.stringify(input)}) ⇒ rien ne doit être installé`);
    assert.ok(out.includes('https://nodejs.org/fr/download'), 'la page de téléchargement doit être proposée');
  }
});

test('consentement : « o » ⇒ Homebrew est réellement appelé et Node.js devient utilisable', { skip: skipNoBash }, () => {
  const fx = makeFixture('accept');
  const marker = join(fx.dir, 'node-upgraded');
  const r = runLaunch(fx, ['--install-only', '--no-browser'], {
    input: 'o\n',
    env: { CKR_FAKE_NODE_VERSION: 'v18.19.0', CKR_FAKE_NODE_UP: marker },
  });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  assert.match(readFakeLog(fx), /^brew install node$/m, 'brew install node doit avoir été appelé');
  assert.ok(existsSync(marker), 'Node.js a bien été « installé »');
  assert.match(out, /Node\.js 22\.14\.0/, 'la version mise à jour est annoncée');
  assert.match(out, /Homebrew/, 'le résumé doit distinguer « installé (Homebrew) »');
});

test('premier lancement (--install-only) : installation complète, résumé sans URL de serveur', { skip: skipNoBash }, () => {
  const fx = makeFixture('install');
  const r = runLaunch(fx, ['--install-only', '--no-browser']);
  const out = outputOf(r);
  assert.equal(r.status, 0, out);

  // Pièces réellement produites.
  assert.ok(existsSync(join(fx.dir, 'node_modules', '.bin', 'tsx')), 'les dépendances sont installées');
  assert.ok(existsSync(join(fx.dir, '.env')), '.env créé depuis .env.example');
  assert.ok(existsSync(join(fx.dir, 'data', 'chapters.db')), 'la base est créée (db:push)');
  const stampPath = join(fx.dir, 'data', 'install.json');
  assert.ok(existsSync(stampPath), 'l’horodatage est écrit');
  const state = JSON.parse(readFileSync(stampPath, 'utf8')) as Record<string, string>;
  assert.ok(state.installedAt && state.node, 'horodatage : date et version de Node');
  assert.equal(state.ffmpeg, '6.1.1-fake', 'horodatage : la version de ffmpeg est lue');
  assert.ok('revision' in state, 'horodatage : la clé de révision est présente');

  // Commandes réellement appelées.
  const log = readFakeLog(fx);
  assert.match(log, /npm ci/, 'les dépendances passent par npm ci (verrou présent)');
  assert.match(log, /npm run db:push/, 'le schéma est appliqué');
  assert.match(log, /^ffmpeg /m, 'le test de fumée encode');
  assert.match(log, /^ffprobe /m, 'le test de fumée relit');
  assert.doesNotMatch(log, /npm start/, 'aucun serveur démarré en mode --install-only');

  // Résumé final en français, SANS aucune URL de serveur.
  assert.match(out, /Test reussi/, 'le test de fumée est annoncé réussi');
  assert.match(out, /Resume de l.installation/, 'un résumé final est affiché');
  assert.match(out, /Etape suivante/, 'le résumé donne l’étape suivante');
  assert.match(out, /\/admin/, 'sans clé configurée, le résumé pointe /admin');
  assert.doesNotMatch(out, /127\.0\.0\.1/, 'aucune URL de serveur quand aucun serveur ne tourne');
  assert.doesNotMatch(out, /:0\b/, 'jamais de port 0');
});

test('lancements suivants : chemin rapide, rien rejoué, horodatage inchangé', { skip: skipNoBash }, () => {
  const fx = makeFixture('fast');
  assert.equal(runLaunch(fx, ['--install-only', '--no-browser']).status, 0);
  const stampPath = join(fx.dir, 'data', 'install.json');
  const before = readFileSync(stampPath, 'utf8');

  writeFileSync(fx.fakeLog, '');
  const second = runLaunch(fx, ['--install-only', '--no-browser']);
  const out = outputOf(second);
  assert.equal(second.status, 0, out);
  assert.match(out, /Chemin rapide/, 'le second lancement prend le chemin rapide');
  assert.match(out, /Installation deja faite/, 'l’installation n’est pas rejouée');
  // Le chemin rapide relit bien les versions (node --version), mais ne réinstalle
  // RIEN : ni npm, ni ffmpeg/ffprobe, ni Homebrew ne doivent être appelés.
  const fastLog = readFakeLog(fx);
  assert.doesNotMatch(fastLog, /^npm /m, 'le chemin rapide ne lance pas npm');
  assert.doesNotMatch(fastLog, /^ffmpeg /m, 'le chemin rapide ne lance pas ffmpeg');
  assert.doesNotMatch(fastLog, /^ffprobe /m, 'le chemin rapide ne lance pas ffprobe');
  assert.doesNotMatch(fastLog, /^brew /m, 'le chemin rapide ne lance pas brew');
  assert.ok(!/Horodatage ecrit/.test(out), 'l’horodatage n’est pas réécrit au chemin rapide');
  assert.equal(readFileSync(stampPath, 'utf8'), before, 'le contenu de l’horodatage est identique');
});

test('un horodatage corrompu est traité comme un premier lancement, sans plantage', { skip: skipNoBash }, () => {
  const fx = makeFixture('broken');
  seedInstalled(fx, '{"installedAt":');
  const r = runLaunch(fx, ['--check']);
  const out = outputOf(r);
  assert.equal(r.status, 0, `un état corrompu ne doit pas planter\n${out}`);
  assert.match(out, /Premier lancement/, 'un état corrompu vaut premier lancement');
  assert.match(out, /illisible/, 'le préflight explique que l’état est illisible');
});

test('test de fumée en échec : diagnostic français, arrêt AVANT le serveur, aucun horodatage', { skip: skipNoBash }, () => {
  const fx = makeFixture('smokefail');
  const r = runLaunch(fx, [], { env: { CKR_FFMPEG_FAIL: '1' } });
  const out = outputOf(r);
  assert.notEqual(r.status, 0, `un test de fumée en échec doit arrêter le lancement\n${out}`);
  assert.match(out, /incomplete/, 'le diagnostic annonce une installation incomplète');
  assert.match(out, /ne sait pas encoder en mp3/, 'le diagnostic est explicite (mp3)');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), 'l’horodatage n’est pas écrit après un échec');
  assert.doesNotMatch(readFakeLog(fx), /npm start/, 'aucun serveur ne doit démarrer');
});

test('repli sans verrou : npm install quand package-lock.json est absent', { skip: skipNoBash }, () => {
  const fx = makeFixture('nolock', { lock: false });
  const r = runLaunch(fx, ['--install-only', '--no-browser']);
  assert.equal(r.status, 0, outputOf(r));
  const log = readFakeLog(fx);
  assert.match(log, /npm install/, 'sans verrou, npm install est utilisé');
  assert.doesNotMatch(log, /npm ci/, 'npm ci exige un verrou : il est évité');
});

/** Trouve un port TCP libre, puis le libère immédiatement. */
function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

/** Démarre un vrai serveur HTTP local qui répond à /local/health (aucune doublure). */
function startHealthServer(port: number, keyOk: boolean) {
  const body = JSON.stringify({
    ffmpeg: { ok: true, version: '6.1.1-fake' },
    ffprobe: { ok: true, version: '6.1.1-fake' },
    openrouterKey: keyOk ? { ok: true } : { ok: false, reason: 'missing' },
    mediaDir: '/tmp',
    mediaDirExists: true,
    uploadMaxMb: 2048,
  });
  const code = `const http=require('http');const port=Number(process.argv[1]);const body=${JSON.stringify(body)};http.createServer((req,res)=>{res.writeHead(200,{'content-type':'application/json'});res.end(body);}).listen(port,'127.0.0.1');`;
  const child = spawn(process.execPath, ['-e', code, String(port)], { stdio: 'ignore' });
  return child;
}

async function waitForHealth(port: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/local/health`;
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* pas encore prêt */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`le serveur de test n’a pas démarré sur ${url}`);
}

test('démarrage réel : serveur prêt, navigateur, résumé avec le port réel (jamais :0)', { skip: skipNoBash }, async () => {
  const port = await freePort();
  const server = startHealthServer(port, false); // aucune clé configurée
  try {
    await waitForHealth(port);
    const fx = makeFixture('start');
    const r = runLaunch(fx, ['--port', String(port)], { env: { CKR_FAKE_NPM_START_SLEEP: '0.5' }, timeout: 60_000 });
    const out = outputOf(r);
    assert.equal(r.status, 0, out);

    assert.match(out, /Port .* libre/, 'le port forcé est annoncé libre');
    assert.match(out, /Serveur pret/, 'le serveur est annoncé prêt');
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${port}/admin`), 'sans clé, /admin est la page ouverte');
    assert.match(out, /Le serveur s.est arrete/, 'l’arrêt du serveur est annoncé');
    assert.doesNotMatch(out, /127\.0\.0\.1:0/, 'jamais de port 0');
    // Le navigateur est réellement « ouvert » (doublure `open`) sur /admin.
    assert.match(readFakeLog(fx), new RegExp(`^open http://127\\.0\\.0\\.1:${port}/admin$`, 'm'), 'open doit viser /admin');
    // Journal serveur dupliqué dans logs/.
    const logs = readdirSync(join(fx.dir, 'logs')).filter((f) => f.startsWith('serveur-'));
    assert.equal(logs.length, 1, 'un journal serveur-*.log doit être créé');
  } finally {
    server.kill();
  }
});

test('démarrage réel : clé présente ⇒ la page principale est ouverte, --no-browser n’ouvre rien', { skip: skipNoBash }, async () => {
  const port = await freePort();
  const server = startHealthServer(port, true); // clé configurée
  try {
    await waitForHealth(port);
    const fx = makeFixture('start-key');
    const r = runLaunch(fx, ['--port', String(port), '--no-browser'], {
      env: { CKR_FAKE_NPM_START_SLEEP: '0.5' },
      timeout: 60_000,
    });
    const out = outputOf(r);
    assert.equal(r.status, 0, out);
    assert.match(out, new RegExp(`Serveur pret : http://127\\.0\\.0\\.1:${port}/`), 'avec une clé, la page principale est visée');
    assert.match(out, /Navigateur non ouvert/, '--no-browser doit être annoncé');
    assert.equal(readFakeLog(fx).includes('open '), false, '--no-browser ne doit rien ouvrir');
  } finally {
    server.kill();
  }
});
