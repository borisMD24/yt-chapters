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
//     PATH (`node`, `npm`, `ffmpeg`, `ffprobe`, `brew`, `open`, `lsof`, et pour
//     l'installation de Homebrew `curl`/`osascript`) qui journalisent leurs
//     appels. La détection d'OS et d'architecture est neutralisée par
//     `CKR_TEST_OS=Darwin` et `CKR_TEST_ARCH`. AUCUN accès réseau : la sonde de
//     disponibilité est servie par un vrai petit serveur HTTP local, et `curl`
//     est remplacé par une doublure (`CKR_CURL_BIN`).
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
  // Arrêt : un signal se contente de sortir, et c'est le trap EXIT qui arrête le
  // GROUPE de processus (npm ET ses descendants) — un seul chemin de nettoyage.
  assert.match(content, /trap 'exit 130' INT TERM/, 'un signal doit sortir (trap INT/TERM)');
  assert.match(content, /trap cleanup_server EXIT/, 'le nettoyage doit passer par le trap EXIT');
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

test('correctifs macOS : Homebrew en direct, PATH complété, lecture JSON, vivacité sur le groupe', () => {
  const content = readFileSync(shPath, 'utf8');
  const code = codeOf(content);

  // A. Homebrew : sortie lue LIGNE À LIGNE (jamais capturée jusqu'à la fin).
  assert.match(code, /brew "\$@" 2>&1 \| while IFS= read -r line/, 'la sortie de brew doit défiler en direct');
  assert.ok(!/out="\$\(brew /.test(code), 'la sortie de brew ne doit PAS être capturée en bloc (lanceur muet)');

  // B. PATH : dossiers Homebrew des deux architectures ; on NE touche au PATH que
  // si un outil manque, et toujours EN FIN (un outil déjà présent garde la priorité).
  assert.ok(content.includes('/opt/homebrew/bin'), 'le dossier Apple Silicon doit être connu');
  assert.ok(content.includes('/usr/local/bin'), 'le dossier Intel doit être connu');
  assert.match(code, /PATH="\$PATH:\$new"/, 'le complément doit être ajouté EN FIN de PATH');
  assert.ok(!/PATH="\$new:\$PATH"/.test(code), 'jamais de préfixage en tête (la priorité de l’utilisateur est préservée)');
  assert.match(
    code,
    /if command_available node && command_available ffmpeg && command_available ffprobe; then/,
    'ne pas toucher au PATH quand les trois outils sont déjà trouvables',
  );
  // Appelé après CHAQUE installation Homebrew, puis revérifié.
  assert.equal((code.match(/refresh_path$/gm) ?? []).length >= 3, true, 'refresh_path doit être appelé au démarrage et après chaque installation');
  assert.match(code, /refresh_path\n\s+node_info/, 'le Node.js installé doit être revérifié après le rafraîchissement');
  assert.match(code, /refresh_path\n\s+if command_available ffmpeg/, 'ffmpeg doit être revérifié après le rafraîchissement');

  // C1. Horodatage : VRAI parsing JSON (node), plus une recherche textuelle seule.
  assert.ok(content.includes('JSON.parse'), 'l’horodatage doit être réellement analysé comme du JSON');
  assert.match(code, /node -e '.*JSON\.parse/, 'le parsing doit être confié à node');

  // C2. Vivacité : jugée sur le GROUPE de processus (ou le port), jamais sur `tee`.
  assert.match(code, /kill -s 0 -- "-\$SERVER_PGID"/, 'la vivacité doit se juger sur le groupe de processus');
  const alive = sliceBetween(code, 'server_alive() {', 'stop_server() {');
  assert.ok(/SERVER_PORT/.test(alive), 'repli : la vivacité peut se juger sur le port');
  assert.ok(!/\$SERVER_PID/.test(alive), 'la vivacité ne doit PAS dépendre du tuyau `tee` (SERVER_PID)');

  // B (2e passe). La clé du serveur est lue par parsing JSON, sans `grep`.
  const keyFn = sliceBetween(code, 'key_configured_from_server() {', 'test_port_free() {');
  assert.match(keyFn, /JSON\.parse/, 'la réponse /local/health doit être analysée comme du JSON');
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
  // Liste de vérification recommandée sur un vrai Mac.
  assert.ok(/pgrep -f 'npm start\|tsx'/.test(readme), 'la vérification « aucun orphelin » (pgrep) doit être documentée');
  assert.match(readme, /clone frais/, 'le double-clic sur un clone frais doit être documenté');
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
  *)
    # Tout autre usage (lecture JSON de l'horodatage, sonde de port) est DÉLÉGUÉ
    # au VRAI Node : on veut le comportement réel, pas celui d'une doublure.
    if [ -n "\${CKR_REAL_NODE:-}" ]; then exec "$CKR_REAL_NODE" "$@"; fi
    exit 0 ;;
esac`,
  npm: `log "npm $*"
case "\${1:-}" in
  ci|install) mkdir -p node_modules/.bin; : > node_modules/.bin/tsx; exit 0 ;;
  run)
    if [ "\${2:-}" = "db:push" ]; then
      if [ -n "\${CKR_FAKE_DBPUSH_FAIL:-}" ]; then echo "fake drizzle-kit: schema impossible" >&2; exit 1; fi
      mkdir -p data; : > data/chapters.db
    fi
    exit 0 ;;
  start)
    # Un éventuel « petit-fils » : il doit DISPARAÎTRE avec le groupe de processus.
    # Sa sortie part vers /dev/null pour ne pas retenir le tube « | tee ».
    if [ -n "\${CKR_FAKE_GRANDCHILD_SCRIPT:-}" ]; then
      sh "$CKR_FAKE_GRANDCHILD_SCRIPT" "\${CKR_FAKE_HEARTBEAT:-}" >/dev/null 2>&1 &
      if [ -n "\${CKR_FAKE_GRANDCHILD_PID:-}" ]; then echo "$!" > "$CKR_FAKE_GRANDCHILD_PID"; fi
    fi
    sleep "\${CKR_FAKE_NPM_START_SLEEP:-0}"; exit 0 ;;
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
# Sortie factice pour prouver qu'elle défile EN DIRECT (et reste journalisée).
if [ -n "\${CKR_FAKE_BREW_LINE1:-}" ]; then
  printf '%s\n' "$CKR_FAKE_BREW_LINE1"
  sleep "\${CKR_FAKE_BREW_DELAY:-0}"
  if [ -n "\${CKR_FAKE_BREW_LINE2:-}" ]; then printf '%s\n' "$CKR_FAKE_BREW_LINE2"; fi
fi
if [ "\${1:-}" = "install" ]; then
  case "\${2:-}" in
    node)
      if [ -n "\${CKR_FAKE_NODE_UP:-}" ]; then : > "$CKR_FAKE_NODE_UP"; fi ;;
    ffmpeg)
      # Homebrew installe les binaires dans son dossier « bin » : ils ne seront
      # visibles qu'après le rafraîchissement du PATH par le lanceur.
      if [ -n "\${CKR_FAKE_INSTALL_DIR:-}" ] && [ -n "\${CKR_FAKE_FFMPEG_SRC:-}" ]; then
        cp "$CKR_FAKE_FFMPEG_SRC" "$CKR_FAKE_INSTALL_DIR/ffmpeg"
        cp "\${CKR_FAKE_FFPROBE_SRC}" "$CKR_FAKE_INSTALL_DIR/ffprobe"
        chmod +x "$CKR_FAKE_INSTALL_DIR/ffmpeg" "$CKR_FAKE_INSTALL_DIR/ffprobe"
      fi ;;
  esac
fi
exit 0`,
  open: `log "open $*"
exit 0`,
  // `lsof` sort non nul quand rien n'écoute : aucun port occupé. Les ports listés
  // dans CKR_FAKE_BUSY_PORTS (séparés par des virgules) sont, eux, « occupés ».
  // Jamais journalisé (le mode --check doit laisser le journal sans appel d'outil).
  lsof: `port=""
for a in "$@"; do
  case "$a" in
    -iTCP:*) port="\${a#-iTCP:}" ;;
  esac
done
case ",\${CKR_FAKE_BUSY_PORTS:-}," in
  *",$port,"*) exit 0 ;;
esac
exit 1`,
};

// Doublures supplémentaires pour le test de PRIORITÉ du PATH.
// `node` ANCIEN (16) rangé dans le dossier « Homebrew » : il ne doit JAMAIS être
// choisi si un node plus récent est déjà dans le PATH.
const OLD_NODE_FAKE = `log "node16 $*"
case "\${1:-}" in
  --version) echo v16.20.2; exit 0 ;;
  *) if [ -n "\${CKR_REAL_NODE:-}" ]; then exec "$CKR_REAL_NODE" "$@"; fi; exit 0 ;;
esac`;
// Deux ffmpeg identifiables : celui « déjà présent » et celui du dossier Homebrew.
const EARLY_FFMPEG = `log "EARLY_FFMPEG $*"
if [ "\${1:-}" = "-version" ]; then echo "ffmpeg version 6.1.1-early"; exit 0; fi
last=''
for a in "$@"; do last="$a"; done
if [ -n "$last" ]; then echo mp3 > "$last"; fi
exit 0`;
const BREW_FFMPEG = `log "BREW_FFMPEG $*"
if [ "\${1:-}" = "-version" ]; then echo "ffmpeg version 6.1.1-brew"; exit 0; fi
last=''
for a in "$@"; do last="$a"; done
if [ -n "$last" ]; then echo mp3 > "$last"; fi
exit 0`;

// Doublures pour l'installation AUTOMATIQUE de Homebrew. Jamais présentes par
// défaut : le vrai `curl` sert aux sondes /local/health des tests de serveur.
const CURL_FAKE = `log "curl $*"
out=''; url=''; want_out=0
for a in "$@"; do
  case "$a" in
    -o) want_out=1 ;;
    -*) ;;
    *) if [ "$want_out" = 1 ]; then out="$a"; want_out=0; else url="$a"; fi ;;
  esac
done
if [ -n "\${CKR_FAKE_CURL_FAIL:-}" ]; then echo "fake curl: reseau indisponible" >&2; exit 6; fi
if [ -z "$out" ]; then echo "fake curl: -o attendu" >&2; exit 2; fi
case "$url" in
  *Homebrew.pkg)
    printf 'PKG-FACTICE' > "$out" ;;
  *)
    {
      echo '#!/bin/sh'
      echo 'echo "==> Installation Homebrew (factice)"'
      echo 'mkdir -p "$CKR_FAKE_HOMEBREW_DIR"'
      echo 'cp "$CKR_FAKE_BREW_SRC" "$CKR_FAKE_HOMEBREW_DIR/brew"'
      echo 'chmod +x "$CKR_FAKE_HOMEBREW_DIR/brew"'
    } > "$out" ;;
esac
exit 0`;

const OSASCRIPT_FAKE = `log "osascript $*"
if [ -n "\${CKR_FAKE_OSASCRIPT_FAIL:-}" ]; then echo "fake osascript: annule" >&2; exit 1; fi
if [ -n "\${CKR_FAKE_HOMEBREW_DIR:-}" ] && [ -n "\${CKR_FAKE_BREW_SRC:-}" ]; then
  mkdir -p "$CKR_FAKE_HOMEBREW_DIR"
  cp "$CKR_FAKE_BREW_SRC" "$CKR_FAKE_HOMEBREW_DIR/brew"
  chmod +x "$CKR_FAKE_HOMEBREW_DIR/brew"
fi
exit 0`;

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

type Fixture = {
  dir: string;
  binDir: string;
  fakeLog: string;
  /** Dossier « Homebrew bin » factice (binaires installés par brew). */
  brewBin: string;
  ffmpegSrc: string;
  ffprobeSrc: string;
  /** Faux binaire `brew`, copié par l'installateur factice de Homebrew. */
  brewSrc: string;
  /** Petit-fils factice : il écrit un battement de cœur en boucle. */
  grandchildScript: string;
  heartbeat: string;
};

/** Petit-fils : écrit « $1 » en boucle ; s'arrête quand il est tué. */
const GRANDCHILD = `#!/bin/sh
i=0
while [ "$i" -lt 6000 ]; do
  echo "$i" > "$1"
  i=$((i + 1))
  sleep 0.1
done
`;

function makeFixture(name: string, opts: { lock?: boolean; omitFakes?: string[]; omitBrewBin?: boolean } = {}): Fixture {
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
  // Sources que la doublure `brew` recopie dans son dossier « bin » (installation
  // d'ffmpeg) : mêmes corps que les doublures normales.
  const brewSrcDir = join(dir, 'brew-src');
  mkdirSync(brewSrcDir, { recursive: true });
  writeFake(brewSrcDir, 'ffmpeg', FAKES.ffmpeg);
  writeFake(brewSrcDir, 'ffprobe', FAKES.ffprobe);
  writeFake(brewSrcDir, 'brew', FAKES.brew);
  const brewBinDir = join(dir, 'brewbin');
  // `omitBrewBin` : le dossier Homebrew n'existe PAS au démarrage (cas réel d'un
  // Mac sans Homebrew). C'est l'installateur factice qui le crée ; le lanceur doit
  // alors rafraîchir son PATH AVANT de décider d'un repli.
  if (!opts.omitBrewBin) mkdirSync(brewBinDir, { recursive: true });
  const grandchildScript = join(dir, 'grandchild.sh');
  writeFileSync(grandchildScript, GRANDCHILD, 'utf8');
  try {
    chmodSync(grandchildScript, 0o755);
  } catch {
    /* Windows */
  }
  return {
    dir,
    binDir,
    fakeLog: join(logDir, 'fake-calls.log'),
    brewBin: brewBinDir,
    ffmpegSrc: join(brewSrcDir, 'ffmpeg'),
    ffprobeSrc: join(brewSrcDir, 'ffprobe'),
    brewSrc: join(brewSrcDir, 'brew'),
    grandchildScript,
    heartbeat: join(dir, 'heartbeat.txt'),
  };
}

function childPathFor(fx: Fixture): string {
  return process.platform === 'win32'
    ? `${toPosix(fx.binDir)}:/usr/bin:/bin:/mingw64/bin`
    : `${fx.binDir}:/bin:/usr/bin:/usr/sbin:/sbin`;
}

/** Environnement d'une exécution : PATH restreint + doublures + neutralisation OS. */
function childEnv(fx: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...process.env,
    PATH: childPathFor(fx),
    CKR_TEST_OS: 'Darwin',
    CKR_FAKE_LOG: fx.fakeLog,
    // La doublure `node` délègue ses usages non triviaux (parsing JSON, sonde de
    // port) au VRAI Node.
    CKR_REAL_NODE: toPosix(process.execPath),
    ...extra,
  } as Record<string, string>;
}

function runLaunch(
  fx: Fixture,
  args: string[],
  opts: { env?: Record<string, string>; input?: string; timeout?: number; dropTestOs?: boolean } = {},
) {
  const env = childEnv(fx, opts.env ?? {});
  if (opts.dropTestOs) delete env.CKR_TEST_OS;
  return spawnSync(bashPath as string, ['scripts/launch.sh', ...args], {
    cwd: fx.dir,
    encoding: 'utf8',
    timeout: opts.timeout ?? 60_000,
    input: opts.input ?? '',
    env,
  });
}

/** Contenu du (des) journal(aux) `logs/demarrage-*.log` du projet factice. */
function readLauncherLog(fx: Fixture): string {
  const dir = join(fx.dir, 'logs');
  if (!existsSync(dir)) return '';
  return readdirSync(dir)
    .filter((f) => f.startsWith('demarrage-'))
    .sort()
    .map((f) => readFileSync(join(dir, f), 'utf8'))
    .join('\n');
}

/** Attente simple, pour observer si un battement de cœur continue après coup. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Pilote bash pour le test de signal : il lance le lanceur EN ARRIÈRE-PLAN dans
 * MSYS, attend la disponibilité, puis envoie TERM. Un signal envoyé depuis
 * Node/Windows n'atteint PAS les traps d'un bash MSYS (mesuré) : le signal doit
 * venir d'un processus MSYS.
 */
const DRIVER_TERM = `#!/bin/bash
set -u
REPORT="\${CKR_DRIVER_REPORT:-rapport.txt}"
OUT="\${CKR_DRIVER_OUT:-launcher.out}"
: > "$REPORT"
"\${BASH:-bash}" scripts/launch.sh --port "$CKR_DRIVER_PORT" --no-browser < /dev/null > "$OUT" 2>&1 &
LPID=$!
i=0
while [ "$i" -lt 300 ]; do
  if grep -q 'Serveur prêt' "$OUT" 2>/dev/null; then break; fi
  kill -0 "$LPID" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done
if grep -q 'Serveur prêt' "$OUT" 2>/dev/null; then echo "PRET=oui" >> "$REPORT"; else echo "PRET=non" >> "$REPORT"; fi
h1="$(cat "$CKR_FAKE_HEARTBEAT" 2>/dev/null || echo none)"
sleep 0.4
h2="$(cat "$CKR_FAKE_HEARTBEAT" 2>/dev/null || echo none)"
if [ "$h1" != "$h2" ]; then echo "HEARTBEAT_VIVANT=oui" >> "$REPORT"; else echo "HEARTBEAT_VIVANT=non" >> "$REPORT"; fi
kill -TERM "$LPID" 2>/dev/null
wait "$LPID" 2>/dev/null
echo "LANCEUR_CODE=$?" >> "$REPORT"
exit 0
`;

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
  // Seul `node` est appelé (relevé des versions, lecture JSON de l'horodatage) :
  // ni brew, ni npm, ni ffmpeg/ffprobe.
  for (const line of readFakeLog(fx).split('\n').filter((l) => l.trim() !== '')) {
    assert.match(line, /^node /, `--check ne doit appeler que node, pas : ${line}`);
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
  // 1. JSON tronqué à la première accolade.
  const fx = makeFixture('broken');
  seedInstalled(fx, '{"installedAt":');
  const r = runLaunch(fx, ['--check']);
  const out = outputOf(r);
  assert.equal(r.status, 0, `un état corrompu ne doit pas planter\n${out}`);
  assert.match(out, /Premier lancement/, 'un état corrompu vaut premier lancement');
  assert.match(out, /illisible/, 'le préflight explique que l’état est illisible');

  // 2. Régression : un JSON TRONQUÉ mais qui « ressemble » à un horodatage valide.
  //    Une simple recherche textuelle de « installedAt » le déclarerait valide ;
  //    la lecture est un vrai parsing JSON, donc il est CORROMPU ⇒ premier
  //    lancement (jamais de chemin rapide sur un état inexploitable).
  const truncated = makeFixture('truncated');
  seedInstalled(truncated, '{"installedAt":"2026-01-01T00:00:00Z","node":"22.14.0","ffmpeg":"6.1.1"');
  const r2 = runLaunch(truncated, ['--check']);
  const out2 = outputOf(r2);
  assert.equal(r2.status, 0, out2);
  assert.match(out2, /Premier lancement/, 'un JSON tronqué vaut premier lancement');

  // 3. Un horodatage VALIDE reste reconnu, même si sa valeur contient une espace
  //    ou une accolade (cas cités par la revue) : le parsing les gère.
  const weird = makeFixture('weird');
  seedInstalled(weird, '{"installedAt":"2026-01-01 00:00:00}Z","node":"22.14.0"}');
  const r3 = runLaunch(weird, ['--check']);
  const out3 = outputOf(r3);
  assert.equal(r3.status, 0, out3);
  assert.match(out3, /Deja installe/, 'un état valide reste reconnu (déjà installé)');
  assert.doesNotMatch(out3, /Premier lancement/, 'un état valide ne doit pas déclencher l’installation');
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
function startHealthServer(port: number, keyOk: boolean, rawBody?: string) {
  const body =
    rawBody ??
    JSON.stringify({
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

// ---------------------------------------------------------------------------
// A. Sortie de Homebrew en direct (jamais de lanceur muet)
// ---------------------------------------------------------------------------

test('A. la sortie de Homebrew défile EN DIRECT et reste journalisée', { skip: skipNoBash }, async () => {
  const fx = makeFixture('brew-stream', { omitFakes: ['ffmpeg', 'ffprobe'] });
  const child = spawn(bashPath as string, ['scripts/launch.sh', '--install-only', '--no-browser'], {
    cwd: fx.dir,
    env: childEnv(fx, {
      CKR_FAKE_BREW_LINE1: '==> LIGNE-BREW-1',
      CKR_FAKE_BREW_LINE2: '==> LIGNE-BREW-2',
      CKR_FAKE_BREW_DELAY: '1.2',
    }),
  });
  const chunks: { at: number; text: string }[] = [];
  child.stdout.on('data', (d: Buffer) => chunks.push({ at: Date.now(), text: d.toString('utf8') }));
  child.stderr.on('data', (d: Buffer) => chunks.push({ at: Date.now(), text: d.toString('utf8') }));
  child.stdin.write('o\n');
  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));

  const all = chunks.map((c) => c.text).join('');
  assert.ok(all.includes('LIGNE-BREW-1'), `la ligne 1 de brew doit être affichée\n${all}`);
  assert.ok(all.includes('LIGNE-BREW-2'), `la ligne 2 de brew doit être affichée\n${all}`);
  const line1 = chunks.find((c) => c.text.includes('LIGNE-BREW-1'));
  const line2 = chunks.find((c) => c.text.includes('LIGNE-BREW-2'));
  assert.ok(line1 && line2, 'les deux lignes doivent être reçues');
  // « En direct » : la première ligne doit arriver nettement AVANT la seconde.
  // Avec une sortie bufferisée jusqu'à la fin de la commande, les deux
  // n'arriveraient qu'au bout, quasi simultanément.
  assert.ok(
    (line2?.at ?? 0) - (line1?.at ?? 0) >= 600,
    `la sortie de brew doit défiler en direct (écart mesuré : ${(line2?.at ?? 0) - (line1?.at ?? 0)} ms)`,
  );
  const log = readLauncherLog(fx);
  assert.ok(log.includes('LIGNE-BREW-1') && log.includes('LIGNE-BREW-2'), 'les lignes de brew doivent être journalisées');
});

// ---------------------------------------------------------------------------
// B. PATH rafraîchi (équivalent macOS de la relecture du registre)
// ---------------------------------------------------------------------------

test('B. au démarrage, un outil installé HORS du PATH est trouvé (aucune installation proposée)', { skip: skipNoBash }, () => {
  // `node` n'existe QUE dans le dossier « Homebrew bin ».
  const fx = makeFixture('path-startup', { omitFakes: ['node'] });
  writeFake(fx.brewBin, 'node', FAKES.node);

  // a. Dossier Homebrew inconnu : Node.js reste introuvable.
  const blind = outputOf(runLaunch(fx, ['--check'], { env: { CKR_BREW_BIN_DIRS: '/dossier-inexistant-xyz' } }));
  assert.match(blind, /Node\.js introuvable/, 'sans rafraîchissement, Node.js est hors du PATH');

  // b. Le PATH est complété avant le préflight : Node.js est trouvé, aucune
  //    installation n'est proposée.
  const found = outputOf(runLaunch(fx, ['--check'], { env: { CKR_BREW_BIN_DIRS: toPosix(fx.brewBin) } }));
  assert.match(found, /Node\.js 22\.14\.0/, 'le PATH complété rend Node.js visible');
  assert.ok(!found.includes('trop ancien') && !found.includes('Node.js introuvable'), 'aucune installation ne doit être proposée');
  assert.equal(readFakeLog(fx).includes('brew '), false, 'aucune installation Homebrew ne doit être lancée');
});

test('B. après « brew install ffmpeg », le PATH est rafraîchi et les outils sont retrouvés', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-ffmpeg', { omitFakes: ['ffmpeg', 'ffprobe'] });
  const r = runLaunch(fx, ['--install-only', '--no-browser'], {
    input: 'o\n',
    env: {
      // Homebrew installe dans son dossier « bin », absent du PATH de départ.
      CKR_BREW_BIN_DIRS: toPosix(fx.brewBin),
      CKR_FAKE_INSTALL_DIR: toPosix(fx.brewBin),
      CKR_FAKE_FFMPEG_SRC: toPosix(fx.ffmpegSrc),
      CKR_FAKE_FFPROBE_SRC: toPosix(fx.ffprobeSrc),
    },
  });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  assert.match(readFakeLog(fx), /^brew install ffmpeg$/m, 'brew install ffmpeg doit être appelé');
  assert.match(out, /maintenant disponibles/, 'les outils sont retrouvés après rafraîchissement du PATH');
  assert.match(out, /- ffmpeg\/ffprobe : installes \(Homebrew\)/, 'le résumé doit dire qu’ils viennent d’être installés');
  // La suite (test de fumée, horodatage) a bien utilisé les binaires installés.
  assert.match(readFakeLog(fx), /^ffmpeg /m, 'le test de fumée doit utiliser le ffmpeg installé');
  assert.ok(existsSync(join(fx.dir, 'data', 'install.json')), 'la phase d’installation doit aller au bout');
});

test('consentement ffmpeg : refus (entrée fermée) ⇒ ZÉRO appel à brew', { skip: skipNoBash }, () => {
  const fx = makeFixture('ffmpeg-refuse', { omitFakes: ['ffmpeg', 'ffprobe'] });
  const r = runLaunch(fx, ['--install-only', '--no-browser']);
  const out = outputOf(r);
  assert.notEqual(r.status, 0, `sans « oui », le lancement doit s'arrêter\n${out}`);
  assert.equal(readFakeLog(fx).includes('brew '), false, 'brew ne doit JAMAIS être appelé sans « oui » explicite');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), 'aucune installation ne doit être enregistrée');
  assert.match(out, /ffmpeg\.org\/download\.html/, 'la page de téléchargement macOS doit être proposée');
  assert.match(out, /introuvable/, 'le diagnostic explique que les outils manquent');
});

// ---------------------------------------------------------------------------
// Homebrew absent : installation automatique (paquet signé, script en repli)
// ---------------------------------------------------------------------------

/** Ajoute les doublures `curl`/`osascript` (jamais présentes par défaut : le vrai
 *  `curl` sert aux sondes /local/health des tests de serveur). */
function addHomebrewFakes(fx: Fixture): void {
  writeFake(fx.binDir, 'curl', CURL_FAKE);
  writeFake(fx.binDir, 'osascript', OSASCRIPT_FAKE);
}

/** Environnement commun aux scénarios d'installation de Homebrew. */
function homebrewEnv(fx: Fixture, extra: Record<string, string> = {}): Record<string, string> {
  return {
    CKR_TEST_ARCH: 'arm64',
    // Git Bash injecte un vrai `curl` en tête de PATH : on cible explicitement
    // la doublure (couture de test, sans effet en production).
    CKR_CURL_BIN: toPosix(join(fx.binDir, 'curl')),
    CKR_BREW_BIN_DIRS: toPosix(fx.brewBin),
    CKR_FAKE_HOMEBREW_DIR: toPosix(fx.brewBin),
    CKR_FAKE_BREW_SRC: toPosix(fx.brewSrc),
    CKR_FAKE_INSTALL_DIR: toPosix(fx.brewBin),
    CKR_FAKE_FFMPEG_SRC: toPosix(fx.ffmpegSrc),
    CKR_FAKE_FFPROBE_SRC: toPosix(fx.ffprobeSrc),
    ...extra,
  };
}

test('Homebrew absent : source (URLs officielles, consentement, aucun sudo)', () => {
  const source = readFileSync(shPath, 'utf8');
  assert.ok(
    source.includes('https://github.com/Homebrew/brew/releases/latest/download/Homebrew.pkg'),
    'URL stable du paquet officiel attendue',
  );
  assert.ok(
    source.includes('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh'),
    'script officiel en repli attendu',
  );
  assert.ok(source.includes('ensure_homebrew'), 'helper d’installation attendu');
  assert.match(source, /read_consent 'Installer Homebrew maintenant/, 'consentement explicite exigé');
  // Aucune invocation DIRECTE de sudo (les commentaires de ligne sont retirés).
  const code = codeOf(source);
  assert.ok(!/^\s*sudo\b/m.test(code), 'aucune commande sudo en début de ligne');
  assert.ok(!/[;&|(]\s*sudo\b/.test(code), 'aucune commande sudo chaînée');
});

test('Homebrew absent : consentement refusé par défaut ⇒ aucun téléchargement, aucun brew', { skip: skipNoBash }, () => {
  for (const input of ['', '\n', 'q\n']) {
    const fx = makeFixture('brew-refuse', { omitFakes: ['brew', 'ffmpeg', 'ffprobe'] });
    addHomebrewFakes(fx);
    const r = runLaunch(fx, ['--install-only', '--no-browser'], { input, env: homebrewEnv(fx) });
    const out = outputOf(r);
    assert.notEqual(r.status, 0, `refus (${JSON.stringify(input)}) ⇒ arrêt\n${out}`);
    const log = readFakeLog(fx);
    assert.ok(!log.includes('curl '), 'refus ⇒ aucun téléchargement');
    assert.ok(!log.includes('osascript '), 'refus ⇒ aucun dialogue administrateur');
    assert.ok(!log.includes('brew '), 'refus ⇒ aucun brew');
    assert.match(norm(out), /brew\.sh/, 'la page Homebrew doit être proposée en repli');
  }
});

test('Homebrew absent (Apple Silicon) : « o » ⇒ paquet signé, dialogue admin, puis ffmpeg', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-pkg', { omitFakes: ['brew', 'ffmpeg', 'ffprobe'], omitBrewBin: true });
  addHomebrewFakes(fx);
  const r = runLaunch(fx, ['--install-only', '--no-browser'], { input: 'o\no\n', env: homebrewEnv(fx) });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  const log = readFakeLog(fx);
  assert.match(log, /curl .*Homebrew\.pkg/, 'le paquet officiel doit être téléchargé');
  assert.match(log, /osascript /, 'le dialogue administrateur doit être demandé');
  assert.doesNotMatch(log, /install\.sh/, 'un paquet réussi ne doit PAS déclencher le script (un seul mot de passe)');
  assert.ok(existsSync(join(fx.brewBin, 'brew')), 'brew doit être disponible après le paquet');
  assert.match(log, /^brew install ffmpeg$/m, 'ffmpeg doit être installé');
  assert.ok(existsSync(join(fx.dir, 'data', 'install.json')), 'la phase d’installation doit aller au bout');
});

test('Homebrew absent (Intel) : pas de paquet Apple Silicon, repli sur le script officiel', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-intel', { omitFakes: ['brew', 'ffmpeg', 'ffprobe'], omitBrewBin: true });
  addHomebrewFakes(fx);
  const r = runLaunch(fx, ['--install-only', '--no-browser'], {
    input: 'o\no\n',
    env: homebrewEnv(fx, { CKR_TEST_ARCH: 'x86_64' }),
  });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  const log = readFakeLog(fx);
  assert.doesNotMatch(log, /Homebrew\.pkg/, 'Intel : aucun paquet Apple Silicon');
  assert.match(log, /curl .*install\.sh/, 'le script officiel doit être téléchargé');
  assert.ok(existsSync(join(fx.brewBin, 'brew')), 'brew doit être disponible après le script');
  assert.match(log, /^brew install ffmpeg$/m, 'ffmpeg doit être installé');
});

test('Homebrew : paquet en échec ⇒ repli automatique sur le script officiel', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-pkg-fail', { omitFakes: ['brew', 'ffmpeg', 'ffprobe'], omitBrewBin: true });
  addHomebrewFakes(fx);
  const r = runLaunch(fx, ['--install-only', '--no-browser'], {
    input: 'o\no\n',
    env: homebrewEnv(fx, { CKR_FAKE_OSASCRIPT_FAIL: '1' }),
  });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  const log = readFakeLog(fx);
  assert.match(log, /curl .*Homebrew\.pkg/, 'le paquet est tenté');
  assert.match(log, /curl .*install\.sh/, 'le script officiel prend le relais');
  assert.ok(existsSync(join(fx.brewBin, 'brew')), 'brew finit par être installé');
  assert.match(log, /^brew install ffmpeg$/m, 'ffmpeg doit être installé');
});

test('Homebrew : réseau indisponible ⇒ repli manuel propre, aucun crash', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-curl-fail', { omitFakes: ['brew', 'ffmpeg', 'ffprobe'] });
  addHomebrewFakes(fx);
  const r = runLaunch(fx, ['--install-only', '--no-browser'], {
    input: 'o\n',
    env: homebrewEnv(fx, { CKR_FAKE_CURL_FAIL: '1' }),
  });
  const out = outputOf(r);
  assert.notEqual(r.status, 0, out);
  const log = readFakeLog(fx);
  assert.ok(!log.includes('brew install'), 'aucune installation ne doit être tentée');
  assert.match(norm(out), /ffmpeg\.org\/download\.html/, 'le repli manuel ffmpeg est proposé');
  assert.ok(!existsSync(join(fx.brewBin, 'brew')), 'aucun brew ne doit apparaître');
});

test('--check avec Homebrew absent : aucun téléchargement ni installation', { skip: skipNoBash }, () => {
  const fx = makeFixture('brew-check', { omitFakes: ['brew'] });
  addHomebrewFakes(fx);
  const r = runLaunch(fx, ['--check'], { env: homebrewEnv(fx) });
  assert.equal(r.status, 0, outputOf(r));
  const log = readFakeLog(fx);
  assert.ok(!log.includes('curl '), '--check ne télécharge rien');
  assert.ok(!log.includes('osascript '), '--check n’ouvre aucun dialogue');
  assert.ok(!log.includes('brew '), '--check ne lance pas brew');
});

// ---------------------------------------------------------------------------
// D. Trous de couverture relevés par la revue
// ---------------------------------------------------------------------------

test('échec de db:push : diagnostic français, arrêt AVANT le serveur, aucun horodatage', { skip: skipNoBash }, () => {
  const fx = makeFixture('dbpush');
  const r = runLaunch(fx, [], { env: { CKR_FAKE_DBPUSH_FAIL: '1' } });
  const out = outputOf(r);
  assert.notEqual(r.status, 0, `un échec de schéma doit arrêter le lancement\n${out}`);
  assert.match(out, /creation du schema a echoue/, 'le diagnostic nomme db:push');
  assert.match(out, /ne sera PAS demarre/, 'l’arrêt du serveur est annoncé');
  assert.match(out, /fake drizzle-kit/, 'les dernières lignes de la commande sont montrées');
  assert.ok(!existsSync(join(fx.dir, 'data', 'install.json')), 'aucun horodatage après un échec');
  assert.doesNotMatch(readFakeLog(fx), /^npm start$/m, 'aucun serveur ne doit démarrer');
});

test('--force-install rejoue la phase (les étapes déjà faites sont sautées)', { skip: skipNoBash }, () => {
  const fx = makeFixture('force');
  assert.equal(runLaunch(fx, ['--install-only', '--no-browser']).status, 0);
  writeFileSync(fx.fakeLog, '');
  const r = runLaunch(fx, ['--install-only', '--no-browser', '--force-install']);
  const out = outputOf(r);
  assert.equal(r.status, 0, out);
  assert.match(out, /Phase d.installation demandee/, 'la phase forcée est annoncée');
  assert.match(out, /Dependances deja installees/, 'les dépendances déjà présentes sont sautées');
  assert.match(out, /Horodatage ecrit/, 'l’horodatage est réécrit');
  const log = readFakeLog(fx);
  assert.match(log, /^ffmpeg /m, 'le test de fumée est rejoué');
  assert.doesNotMatch(log, /npm ci/, 'dépendances présentes : npm ci est sauté');
  assert.doesNotMatch(log, /npm run db:push/, 'base présente : db:push est sauté');
});

test('port occupé : bascule sur le suivant ; aucun port libre ⇒ refus explicite', { skip: skipNoBash }, () => {
  const fx = makeFixture('ports');
  const busy = outputOf(runLaunch(fx, ['--check'], { env: { CKR_FAKE_BUSY_PORTS: '3000' } }));
  assert.match(busy, /Port 3001 : libre/, '3000 occupé ⇒ 3001 proposé');
  assert.ok(!busy.includes('Port 3000 : libre'), '3000 ne doit pas être annoncé libre');

  const allBusy = '3000,3001,3002,3003,3004,3005,3006,3007,3008,3009,3010';
  const none = outputOf(runLaunch(fx, ['--check'], { env: { CKR_FAKE_BUSY_PORTS: allBusy } }));
  assert.match(none, /Aucun port libre entre 3000 et 3010/, 'aucun port libre ⇒ refus explicite');

  // Port FORCÉ et occupé : refus franc, et surtout AUCUN serveur démarré.
  seedInstalled(fx, VALID_STAMP);
  const forced = runLaunch(fx, ['--port', '3000'], { env: { CKR_FAKE_BUSY_PORTS: '3000' } });
  const outForced = outputOf(forced);
  assert.notEqual(forced.status, 0, outForced);
  assert.match(outForced, /Le port 3000 est deja utilise/, 'le diagnostic nomme le port occupé');
  assert.doesNotMatch(readFakeLog(fx), /^npm start$/m, 'aucun serveur ne doit démarrer sur un port occupé');
});

test('D. TERM pendant que le serveur tourne : aucun orphelin, trap EXIT exécuté', { skip: skipNoBash }, async () => {
  const port = await freePort();
  const server = startHealthServer(port, false);
  try {
    await waitForHealth(port);
    const fx = makeFixture('trap-term');
    const driver = join(fx.dir, 'driver.sh');
    writeFileSync(driver, DRIVER_TERM, 'utf8');
    const report = join(fx.dir, 'rapport.txt');
    const launcherOut = join(fx.dir, 'launcher.out');
    const r = spawnSync(bashPath as string, [driver], {
      cwd: fx.dir,
      encoding: 'utf8',
      timeout: 90_000,
      env: childEnv(fx, {
        CKR_DRIVER_PORT: String(port),
        CKR_DRIVER_REPORT: report,
        CKR_DRIVER_OUT: launcherOut,
        CKR_FAKE_GRANDCHILD_SCRIPT: toPosix(fx.grandchildScript),
        CKR_FAKE_HEARTBEAT: toPosix(fx.heartbeat),
        CKR_FAKE_GRANDCHILD_PID: toPosix(join(fx.dir, 'grandchild.pid')),
        CKR_FAKE_NPM_START_SLEEP: '120',
      }),
    });
    assert.equal(r.error, undefined, `le pilote doit démarrer (${r.error?.message})`);
    const reportText = existsSync(report) ? readFileSync(report, 'utf8') : '';
    assert.match(reportText, /PRET=oui/, `le lanceur doit avoir atteint « Serveur prêt »\n${reportText}`);
    assert.match(reportText, /HEARTBEAT_VIVANT=oui/, `le petit-fils doit réellement tourner\n${reportText}`);
    assert.match(reportText, /LANCEUR_CODE=130/, `TERM ⇒ sortie 130 (trap exécuté)\n${reportText}`);

    const out = `${readFileSync(launcherOut, 'utf8')}`;
    assert.match(norm(out), /Serveur arrete proprement/, 'l’arrêt propre est annoncé');
    assert.match(readLauncherLog(fx), /Trap EXIT/, 'le trap EXIT doit s’exécuter');
    assert.ok(existsSync(fx.heartbeat), 'le petit-fils doit avoir écrit');

    // Le descendant (petit-fils) est bien mort avec le groupe : son battement de
    // cœur doit être FIGÉ.
    const before = readFileSync(fx.heartbeat, 'utf8');
    await sleepMs(800);
    assert.equal(readFileSync(fx.heartbeat, 'utf8'), before, 'aucun orphelin : le battement de cœur doit s’arrêter');
  } finally {
    server.kill();
  }
});

test('D. trap EXIT : un descendant resté vivant est arrêté à la sortie (jamais d’orphelin)', { skip: skipNoBash }, async () => {
  const port = await freePort();
  const server = startHealthServer(port, true);
  try {
    await waitForHealth(port);
    const fx = makeFixture('trap-exit');
    const r = runLaunch(fx, ['--port', String(port), '--no-browser'], {
      timeout: 60_000,
      env: {
        // npm se termine tout de suite, mais il laisse un petit-fils derrière lui :
        // seul le trap EXIT peut l'empêcher de survivre au lanceur.
        CKR_FAKE_GRANDCHILD_SCRIPT: toPosix(fx.grandchildScript),
        CKR_FAKE_HEARTBEAT: toPosix(fx.heartbeat),
        CKR_FAKE_NPM_START_SLEEP: '0',
      },
    });
    const out = outputOf(r);
    assert.equal(r.status, 0, out);
    assert.match(out, /Le serveur s.est arrete/, 'la fin du serveur est annoncée');
    assert.match(out, /Serveur arrete proprement/, 'le trap EXIT annonce l’arrêt du descendant');
    assert.match(readLauncherLog(fx), /Trap EXIT/, 'le trap EXIT doit s’être exécuté');
    assert.ok(existsSync(fx.heartbeat), 'le petit-fils doit avoir écrit');

    const before = readFileSync(fx.heartbeat, 'utf8');
    await sleepMs(800);
    assert.equal(readFileSync(fx.heartbeat, 'utf8'), before, 'le descendant ne doit pas survivre à la sortie');
  } finally {
    server.kill();
  }
});

// ---------------------------------------------------------------------------
// A (2e passe). PRIORITÉ du PATH : un outil déjà présent n'est jamais écrasé
// ---------------------------------------------------------------------------

test('A. un outil DÉJÀ présent garde la priorité : le PATH n’est pas touché du tout', { skip: skipNoBash }, () => {
  const fx = makeFixture('path-priority');
  // Scénario de la revue : un node ANCIEN rangé dans un dossier Homebrew, un node
  // RÉCENT déjà dans le PATH (nvm/volta ou installation manuelle).
  writeFake(fx.brewBin, 'node', OLD_NODE_FAKE);
  const out = outputOf(runLaunch(fx, ['--check'], { env: { CKR_BREW_BIN_DIRS: toPosix(fx.brewBin) } }));

  assert.match(out, /Node\.js 22\.14\.0/, 'le node déjà présent (récent) doit être utilisé');
  assert.doesNotMatch(out, /trop ancien/, 'aucun faux diagnostic « trop ancien »');
  assert.doesNotMatch(out, /16\.20\.2/, 'le node 16 du dossier Homebrew ne doit pas être choisi');
  assert.ok(
    !readLauncherLog(fx).includes('[PATH]'),
    'le PATH ne doit pas être modifié quand les trois outils sont déjà trouvables',
  );
});

test('A. si un outil MANQUE, les dossiers Homebrew sont ajoutés EN FIN de PATH', { skip: skipNoBash }, () => {
  const fx = makeFixture('path-append', { omitFakes: ['ffprobe'] });
  // `ffmpeg` déjà présent (en tête de PATH) et un autre, différent, dans le dossier
  // Homebrew : c'est le premier qui doit être choisi.
  writeFake(fx.binDir, 'ffmpeg', EARLY_FFMPEG);
  writeFake(fx.brewBin, 'ffmpeg', BREW_FFMPEG);
  writeFake(fx.brewBin, 'ffprobe', FAKES.ffprobe);
  const r = runLaunch(fx, ['--install-only', '--no-browser'], { env: { CKR_BREW_BIN_DIRS: toPosix(fx.brewBin) } });
  const out = outputOf(r);
  assert.equal(r.status, 0, out);

  assert.match(readLauncherLog(fx), /\[PATH\].*EN FIN/, 'le complément doit être journalisé comme ajouté en fin de PATH');
  const log = readFakeLog(fx);
  assert.match(log, /EARLY_FFMPEG/, 'un ffmpeg déjà présent garde la priorité');
  assert.doesNotMatch(log, /BREW_FFMPEG/, 'le ffmpeg du dossier Homebrew ne doit pas être choisi');
  // Corollaire : l'outil réellement absent (ffprobe) est bien retrouvé.
  assert.match(log, /^ffprobe /m, 'ffprobe, manquant, doit être retrouvé par le complément');
});

// ---------------------------------------------------------------------------
// B (2e passe). La clé du serveur est lue par parsing JSON, pas par `grep`
// ---------------------------------------------------------------------------

test('B. la clé du serveur est lue par parsing JSON : une chaîne « leurre » ne trompe pas', { skip: skipNoBash }, async () => {
  const port = await freePort();
  // Le champ `note` contient, sous forme de CHAÎNE, exactement le motif que
  // l'ancienne recherche textuelle prenait pour une clé configurée.
  const body = JSON.stringify({
    ffmpeg: { ok: true, version: '6.1.1-fake' },
    ffprobe: { ok: true, version: '6.1.1-fake' },
    openrouterKey: { ok: false, reason: 'missing' },
    note: '"openrouterKey":{"ok":true}',
    mediaDir: '/tmp',
    mediaDirExists: true,
    uploadMaxMb: 2048,
  });
  const server = startHealthServer(port, false, body);
  try {
    await waitForHealth(port);
    const fx = makeFixture('key-decoy');
    const r = runLaunch(fx, ['--port', String(port)], { env: { CKR_FAKE_NPM_START_SLEEP: '0.5' }, timeout: 60_000 });
    const out = outputOf(r);
    assert.equal(r.status, 0, out);
    assert.match(out, new RegExp(`127\\.0\\.0\\.1:${port}/admin`), 'sans clé réelle, /admin doit être ouvert');
    assert.match(
      readFakeLog(fx),
      new RegExp(`^open http://127\\.0\\.0\\.1:${port}/admin$`, 'm'),
      'le navigateur doit viser /admin malgré le leurre',
    );
  } finally {
    server.kill();
  }
});
