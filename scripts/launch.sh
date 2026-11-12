#!/bin/bash
#
# Démarrage en un clic de yt-chapters — macOS.
#
# ÉQUIVALENT de `scripts/launch.ps1` (Windows) : mêmes étapes, mêmes messages,
# mêmes garde-fous. Lancé par `Démarrer.command` (double-clic depuis le Finder)
# ou directement :
#
#     bash scripts/launch.sh [--check] [--no-browser] [--port <n>] \
#                            [--force-install] [--install-only]
#
# PREMIER LANCEMENT : quand l'horodatage d'installation (`data/install.json`,
# ignoré par git) est absent — ou qu'une pièce manque (dépendances, `.env`,
# base) — une PHASE D'INSTALLATION complète est jouée, étape par étape. Les
# lancements suivants prennent le CHEMIN RAPIDE (vérification brève, sans rien
# réinstaller). Un état illisible ou corrompu retombe sur « premier lancement ».
#
# CONTRAINTE macOS : le bash livré avec macOS est le 3.2 (2007). Ce script reste
# donc COMPATIBLE BASH 3.2 : pas de tableaux associatifs (`declare -A`), pas de
# `${var,,}`, pas de `mapfile`, pas de `**`. Pas de commande GNU-only non plus
# (`sed -i` sans suffixe, `date -d`, `stat -c`, `readlink -f`) : on utilise la
# variante BSD (`stat -f`, `readlink` seul) ou un repli portatif. JAMAIS `sudo`.
#
# Spécifique à macOS (avec replis) :
#   - Homebrew (`brew install node` / `brew install ffmpeg`) pour l'installation ;
#   - `open <url>` pour ouvrir le navigateur ;
#   - `lsof` pour tester un port (repli portable par `node` sinon) ;
#   - `set -m` + groupe de processus pour arrêter TOUT le serveur (npm → tsx)
#     d'un seul coup, sans jamais laisser de processus orphelin.
#
# Options :
#   --check          préflight SEUL : rapporte l'état (dont « premier lancement »
#                    ou « déjà installé ») et sort sans rien installer, sans
#                    démarrer le serveur, et sans écrire ailleurs que dans logs/.
#                    AUCUN effet de bord.
#   --no-browser     n'ouvre pas le navigateur.
#   --port <n>       force le port indiqué (3000 par défaut, sinon le premier libre).
#   --force-install  rejoue la phase d'installation même si l'horodatage existe
#                    (support et tests).
#   --install-only   joue la phase d'installation puis s'arrête SANS démarrer le
#                    serveur (support et tests hors ligne).

set -u

# ---------------------------------------------------------------------------
# Racine du projet, quel que soit l'endroit d'où le script est lancé
# ---------------------------------------------------------------------------

# `readlink -f` n'existe pas sur macOS : on résout les liens à la main.
resolve_script_dir() {
  local src="${BASH_SOURCE[0]}" dir
  while [ -h "$src" ]; do
    dir="$(cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd)"
    src="$(readlink "$src")"
    case "$src" in
      /*) ;;
      *) src="$dir/$src" ;;
    esac
  done
  cd -P "$(dirname "$src")" >/dev/null 2>&1 && pwd
}
SCRIPT_DIR="$(resolve_script_dir)"
ROOT="$(cd -P "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd)"

# ---------------------------------------------------------------------------
# Options
# ---------------------------------------------------------------------------

OPT_CHECK=0
OPT_NO_BROWSER=0
OPT_PORT=0
OPT_FORCE_INSTALL=0
OPT_INSTALL_ONLY=0

usage() {
  printf '%s\n' \
    'Utilisation : bash scripts/launch.sh [options]' \
    '' \
    '  --check          préflight seul (aucun effet de bord hors de logs/)' \
    '  --no-browser     n’ouvre pas le navigateur' \
    '  --port <n>       force le port (3000 par défaut, sinon le premier libre)' \
    '  --force-install  rejoue la phase d’installation' \
    '  --install-only   installe puis s’arrête sans démarrer le serveur'
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) OPT_CHECK=1 ;;
    --no-browser) OPT_NO_BROWSER=1 ;;
    --force-install) OPT_FORCE_INSTALL=1 ;;
    --install-only) OPT_INSTALL_ONLY=1 ;;
    --port)
      shift || true
      OPT_PORT="${1:-0}"
      ;;
    --port=*) OPT_PORT="${1#--port=}" ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Option inconnue : %s\n' "$1" >&2
      ;;
  esac
  shift
done

# Un port non numérique ou négatif vaut « port automatique ».
case "$OPT_PORT" in
  ''|*[!0-9]*) OPT_PORT=0 ;;
esac

# ---------------------------------------------------------------------------
# Journaux
# ---------------------------------------------------------------------------

LOG_DIR="$ROOT/logs"
STAMP="$(date '+%Y%m%d-%H%M%S')"
LAUNCHER_LOG="$LOG_DIR/demarrage-$STAMP.log"

# Le dossier des journaux est créé à la demande ; un échec n'arrête jamais le
# démarrage (on continue simplement sans trace fichier).
mkdir -p "$LOG_DIR" 2>/dev/null || true

log_line() {
  local kind="$1"; shift
  local ts line
  ts="$(date '+%Y-%m-%d %H:%M:%S')"
  line="$ts [$kind] $*"
  { printf '%s\n' "$line" >>"$LAUNCHER_LOG"; } 2>/dev/null || true
}

say() {
  local kind="$1"; shift
  printf '[%s] %s\n' "$kind" "$*"
  log_line "$kind" "$*"
}

say_title() {
  printf '\n=== %s ===\n' "$1"
  log_line 'TITRE' "$1"
}

say_raw() {
  printf '%s\n' "$1"
  log_line 'SORTIE' "$1"
}

show_startup_log_path() {
  say 'INFO' "Journaux de ce démarrage : $LOG_DIR"
}

# ---------------------------------------------------------------------------
# Outils élémentaires
# ---------------------------------------------------------------------------

command_available() { command -v "$1" >/dev/null 2>&1; }

# Détection d'OS. La variable CKR_TEST_OS n'existe que pour les TESTS : elle
# remplace `uname -s` (une suite de tests s'exécute sous Git Bash / Linux et doit
# pouvoir se faire passer pour macOS).
is_macos() {
  case "${CKR_TEST_OS:-$(uname -s)}" in
    Darwin) return 0 ;;
    *) return 1 ;;
  esac
}

# `open` est l'équivalent macOS de `Start-Process <url>`.
open_url() {
  local url="$1"
  if command_available open; then
    open "$url" >/dev/null 2>&1 || say 'MANQUANT' "Ouvrez cette adresse dans votre navigateur : $url"
  else
    say 'MANQUANT' "Ouvrez cette adresse dans votre navigateur : $url"
  fi
}

# Garde la fenêtre ouverte pour lire un message. Ne bloque jamais si l'entrée est
# fermée (mode non interactif, tests).
pause_for_reading() {
  say 'INFO' 'Fenêtre laissée ouverte pour lire le message. Appuyez sur Entrée pour fermer.'
  IFS= read -r _ || true
}

# Consentement d'installation : DÉFAUT = REFUSER. Seule une réponse
# explicitement affirmative (`o`, `oui`, `y`, `yes`, casse ignorée) autorise
# l'installation. Tout le reste — vide, espaces, « q », « non », « n », « 0 »,
# réponse inattendue — refuse. Une entrée FERMÉE (EOF) refuse aussi : `read`
# échoue et la réponse reste vide.
consent_ok() {
  local ans
  ans="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  case "$ans" in
    o|oui|y|yes) return 0 ;;
    *) return 1 ;;
  esac
}

read_consent() {
  local reply=""
  printf '%s' "$1"
  if ! IFS= read -r reply; then
    reply="n"
  fi
  consent_ok "$reply"
}

# ---------------------------------------------------------------------------
# Node.js
# ---------------------------------------------------------------------------

NODE_OK=0
NODE_VERSION=''
NODE_MAJOR=0

node_info() {
  NODE_OK=0
  NODE_VERSION=''
  NODE_MAJOR=0
  command_available node || return 0
  local raw major
  raw="$(node --version 2>/dev/null)" || return 0
  raw="${raw%%$'\n'*}"
  raw="${raw%$'\r'}"
  NODE_VERSION="${raw#v}"
  major="${NODE_VERSION%%.*}"
  case "$major" in
    ''|*[!0-9]*) NODE_MAJOR=0 ;;
    *) NODE_MAJOR="$major" ;;
  esac
  if [ "$NODE_MAJOR" -ge 20 ]; then NODE_OK=1; fi
  return 0
}

# Version de ffmpeg (« inconnue » si indisponible). On capture TOUTE la sortie
# avant de retenir la première ligne : couper le tube trop tôt peut faire échouer
# la commande native (piège déjà mesuré côté PowerShell).
ffmpeg_version() {
  local out first rest
  command_available ffmpeg || return 1
  out="$(ffmpeg -version 2>&1)" || return 1
  first="${out%%$'\n'*}"
  case "$first" in
    *'ffmpeg version '*)
      rest="${first#*ffmpeg version }"
      printf '%s' "${rest%% *}" ;;
    *) printf '%s' "$first" ;;
  esac
}

# Révision git du dépôt, si disponible.
repo_revision() {
  local rev
  command_available git || return 1
  rev="$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" || return 1
  rev="${rev%%$'\n'*}"
  rev="${rev%$'\r'}"
  [ -n "$rev" ] || return 1
  printf '%s' "$rev"
}

# Exécute Homebrew : sa sortie défile EN DIRECT (ligne à ligne, jamais bufferisée
# jusqu'à la fin — une installation dure plusieurs minutes et un lanceur muet
# paraîtrait figé), et chaque ligne reste journalisée dans logs/demarrage-*.log.
brew_run() {
  local line
  say_raw "> brew $*"
  brew "$@" 2>&1 | while IFS= read -r line || [ -n "$line" ]; do
    printf '%s\n' "$line"
    log_line 'BREW' "$line"
  done
  return 0
}

# Dossiers où Homebrew installe ses binaires : /opt/homebrew/bin (Apple Silicon)
# puis /usr/local/bin (Intel). Surchargeables PAR LES TESTS seulement
# (CKR_BREW_BIN_DIRS, séparés par « : »), faute de pouvoir créer /opt/homebrew
# sous Windows.
brew_bin_dirs() {
  if [ -n "${CKR_BREW_BIN_DIRS:-}" ]; then
    printf '%s' "$CKR_BREW_BIN_DIRS"
  else
    printf '%s' '/opt/homebrew/bin:/usr/local/bin'
  fi
}

# ÉQUIVALENT macOS de la relecture du registre côté Windows : après une
# installation Homebrew — et dès le démarrage — le binaire peut exister sans être
# dans le PATH de la session (cas classique du double-clic Finder, qui n'hérite
# pas du PATH d'un Terminal configuré). On AJOUTE ces dossiers SANS PERDRE
# l'existant (ils passent en tête, comme les entrées Machine/User côté Windows),
# puis l'appelant revérifie la présence des outils.
refresh_path() {
  local list dir rest new
  list="$(brew_bin_dirs)"
  new=''
  rest="$list"
  while [ -n "$rest" ]; do
    dir="${rest%%:*}"
    case "$rest" in
      *:*) rest="${rest#*:}" ;;
      *) rest='' ;;
    esac
    [ -n "$dir" ] || continue
    [ -d "$dir" ] || continue
    case ":$PATH:" in
      *":$dir:"*) ;;
      *) new="$new${new:+:}$dir" ;;
    esac
  done
  if [ -n "$new" ]; then
    PATH="$new:$PATH"
    export PATH
    log_line 'PATH' "PATH de la session complété (Homebrew) : $new"
  fi
  return 0
}

# Exécute npm dans la racine du projet : sortie capturée PUIS affichée (comme le
# fait le lanceur PowerShell), journalisée, et conservée dans NPM_OUT / NPM_CODE
# pour les diagnostics (« pourquoi db:push a échoué ? »).
NPM_OUT=''
NPM_CODE=0
npm_run() {
  local label="$1"; shift
  local line
  NPM_OUT=''
  say_raw "> npm $*"
  NPM_OUT="$(cd "$ROOT" 2>/dev/null && npm "$@" 2>&1)"
  NPM_CODE=$?
  if [ -n "$NPM_OUT" ]; then
    while IFS= read -r line; do
      printf '%s\n' "$line"
      log_line 'NPM' "$line"
    done <<<"$NPM_OUT"
  fi
  if [ "$NPM_CODE" -ne 0 ]; then
    printf '%s : code de sortie %s\n' "$label" "$NPM_CODE"
  fi
  return 0
}

# ---------------------------------------------------------------------------
# État d'installation (horodatage) et pièces attendues
# ---------------------------------------------------------------------------

STATE_PRESENT=0
STATE_CORRUPTED=0

# Un état ABSENT, ILLISIBLE ou CORROMPU vaut « premier lancement » : un fichier
# tronqué ne doit JAMAIS faire planter le démarrage, et ne doit jamais non plus
# passer pour un état valide. La lecture est un VRAI parsing JSON confié à Node
# (déjà requis par l'application) : une simple recherche textuelle de
# « installedAt » se contenterait d'un fichier TRONQUÉ
# (`{"installedAt":"2026-...","node":`) et ferait passer un état inexploitable
# pour valide. Le repli SANS Node est volontairement prudent : il exige la clé et
# une valeur entre guillemets non vides (une valeur contenant un espace ou une
# accolade reste correctement reconnue, puisqu'on ne cherche pas la fin du JSON),
# mais il ne peut pas détecter une troncature ; sans Node, l'application ne peut
# de toute façon pas démarrer, et un horodatage douteux fait rejouer une phase
# d'installation IDEMPOTENTE (jamais destructive).
read_install_state() {
  STATE_PRESENT=0
  STATE_CORRUPTED=0
  local f="$ROOT/data/install.json"
  [ -f "$f" ] || return 0
  if [ ! -s "$f" ]; then
    STATE_CORRUPTED=1
    return 0
  fi
  if command_available node; then
    # `process.argv[1]` = le chemin du fichier (arguments après le script).
    if node -e 'const fs=require("fs");try{const d=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));process.exit(d&&typeof d.installedAt==="string"&&d.installedAt.trim()!==""?0:1);}catch{process.exit(1);}' "$f" >/dev/null 2>&1; then
      STATE_PRESENT=1
    else
      STATE_CORRUPTED=1
    fi
    return 0
  fi
  if grep -Eq '"installedAt"[[:space:]]*:[[:space:]]*"[^"]+"' "$f" 2>/dev/null; then
    STATE_PRESENT=1
  else
    STATE_CORRUPTED=1
  fi
  return 0
}

PIECE_DEPS=0
PIECE_ENV=0
PIECE_DB=0
PIECES_ALL=0

test_install_pieces() {
  PIECE_DEPS=0
  PIECE_ENV=0
  PIECE_DB=0
  if [ -e "$ROOT/node_modules/.bin/tsx" ]; then PIECE_DEPS=1; fi
  if [ -f "$ROOT/.env" ]; then PIECE_ENV=1; fi
  if [ -f "$ROOT/data/chapters.db" ]; then PIECE_DB=1; fi
  PIECES_ALL=0
  if [ "$PIECE_DEPS" = 1 ] && [ "$PIECE_ENV" = 1 ] && [ "$PIECE_DB" = 1 ]; then PIECES_ALL=1; fi
  return 0
}

FIRST_LAUNCH=0
INSTALL_PHASE=0

launch_mode() {
  read_install_state
  test_install_pieces
  FIRST_LAUNCH=0
  if [ "$STATE_PRESENT" != 1 ] || [ "$PIECES_ALL" != 1 ]; then FIRST_LAUNCH=1; fi
  INSTALL_PHASE=0
  if [ "$OPT_FORCE_INSTALL" = 1 ] || [ "$FIRST_LAUNCH" = 1 ]; then INSTALL_PHASE=1; fi
  return 0
}

# ---------------------------------------------------------------------------
# Clé OpenRouter configurée ?
# ---------------------------------------------------------------------------

# Hors serveur (mode --install-only) : on lit `.env` avec les mêmes règles
# d'exemple que le lanceur PowerShell (`Test-KeyConfiguredFromEnv`) : vide, trop
# courte, contenant « ... », ou un exemple manifeste → NON configurée.
key_configured_from_env() {
  local f="$ROOT/.env" raw value lower
  [ -f "$f" ] || return 1
  raw="$(grep -E '^[[:space:]]*OPENROUTER_API_KEY[[:space:]]*=' "$f" 2>/dev/null | tail -n 1)"
  [ -n "$raw" ] || return 1
  value="${raw#*=}"
  value="$(printf '%s' "$value" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  value="${value%$'\r'}"
  case "$value" in
    \"*\") value="${value#\"}"; value="${value%\"}" ;;
  esac
  case "$value" in
    \'*\') value="${value#\'}"; value="${value%\'}" ;;
  esac
  [ -n "$value" ] || return 1
  [ "${#value}" -ge 20 ] || return 1
  case "$value" in *'...'*) return 1 ;; esac
  case "$value" in *'…'*) return 1 ;; esac
  lower="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"
  case "$lower" in
    *votre*|*your*|*change*|*remplace*|*replace*|*exemple*|*example*|*placeholder*|*todo*|*xxx*) return 1 ;;
  esac
  return 0
}

# Avec un serveur qui tourne : la source de vérité est le SERVEUR lui-même
# (`/local/health`), donc la vraie résolution base + `.env`.
key_configured_from_server() {
  local port="$1" body
  body="$(curl -fsS --max-time 3 "http://127.0.0.1:$port/local/health" 2>/dev/null)" || return 1
  printf '%s' "$body" | grep -Eq '"openrouterKey"[[:space:]]*:[[:space:]]*\{[[:space:]]*"ok"[[:space:]]*:[[:space:]]*true'
}

# ---------------------------------------------------------------------------
# Ports
# ---------------------------------------------------------------------------

# Un port est libre s'il n'y a AUCUN programme en écoute dessus.
test_port_free() {
  local p="$1"
  if command_available lsof; then
    # `lsof` sort non nul quand rien n'écoute : c'est le cas « libre ».
    if lsof -nP -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1; then return 1; fi
    return 0
  fi
  # Repli portatif (Git Bash, Linux, macOS sans lsof) : une liaison éphémère.
  if command_available node; then
    if node -e 'const n=require("net");const s=n.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"127.0.0.1",()=>s.close(()=>process.exit(0)));' "$p" >/dev/null 2>&1; then
      return 0
    fi
    return 1
  fi
  # Ni `lsof` ni `node` : on suppose libre. Si le port est occupé, le serveur
  # répondra EADDRINUSE et le diagnostic le dira.
  return 0
}

SELECTED_PORT=3000
PORT_FREE=0
PORT_FORCED=0

select_port() {
  SELECTED_PORT=3000
  PORT_FREE=0
  PORT_FORCED=0
  local p
  if [ "$OPT_PORT" -gt 0 ] 2>/dev/null; then
    SELECTED_PORT="$OPT_PORT"
    PORT_FORCED=1
    if test_port_free "$SELECTED_PORT"; then PORT_FREE=1; fi
    return 0
  fi
  p=3000
  while [ "$p" -le 3010 ]; do
    if test_port_free "$p"; then
      SELECTED_PORT="$p"
      PORT_FREE=1
      return 0
    fi
    p=$((p + 1))
  done
  SELECTED_PORT=3000
  PORT_FREE=0
  return 0
}

# ---------------------------------------------------------------------------
# Résumé d'installation
# ---------------------------------------------------------------------------

REPORT=''
report_add() {
  if [ -z "$REPORT" ]; then
    REPORT="$1|$2"
  else
    REPORT="$REPORT
$1|$2"
  fi
}

# Une URL de serveur n'est affichée QUE si un serveur tourne réellement sur un
# port valide : jamais « :0 », jamais d'adresse quand rien n'écoute.
show_install_summary() {
  local key_configured="$1" server_port="$2" server_ready="$3" install_only="$4"
  local label status show_url
  say_title "Résumé de l'installation"
  say 'INFO' 'Ce qui a été préparé (installé ou déjà présent) :'
  printf '%s\n' "$REPORT" | while IFS='|' read -r label status; do
    [ -n "$label" ] || continue
    say 'INFO' "  - $label : $status"
  done
  show_url=0
  if [ "$server_ready" = 1 ] && [ "$server_port" -gt 0 ] 2>/dev/null; then show_url=1; fi
  if [ "$key_configured" = 1 ]; then
    if [ "$show_url" = 1 ]; then
      say 'OK' "Étape suivante : ouvrez http://127.0.0.1:$server_port/ et lancez un chapitrage."
    elif [ "$install_only" = 1 ]; then
      say 'OK' 'Étape suivante : démarrez le serveur (Démarrer.command), puis ouvrez la page principale.'
    else
      say 'OK' 'Étape suivante : corrigez la cause ci-dessus, puis relancez Démarrer.command.'
    fi
  else
    if [ "$show_url" = 1 ]; then
      say 'MANQUANT' "Étape suivante : aucune clé OpenRouter n'est configurée. Ouvrez http://127.0.0.1:$server_port/admin, collez votre clé, puis cliquez Enregistrer et Tester."
    elif [ "$install_only" = 1 ]; then
      say 'MANQUANT' "Étape suivante : aucune clé OpenRouter n'est configurée. Démarrez le serveur (Démarrer.command), puis ouvrez /admin pour la renseigner."
    else
      say 'MANQUANT' "Étape suivante : aucune clé OpenRouter n'est configurée. Une fois le serveur démarré, ouvrez /admin pour la renseigner."
    fi
  fi
}

# ---------------------------------------------------------------------------
# Phase d'installation complète (premier lancement, ou --force-install)
# ---------------------------------------------------------------------------

# Chaque étape est IDEMPOTENTE : si elle est déjà faite, elle est signalée puis
# SAUTÉE. Renvoie 0 en cas de succès, un code non nul si le démarrage doit
# s'arrêter (test de fumée en échec, base impossible à créer…).
do_install_phase() {
  local trigger="$1"

  if [ "$trigger" = 'force' ]; then
    say 'INFO' "Phase d'installation demandée (--force-install) : les étapes déjà faites sont signalées puis sautées."
  else
    say 'INFO' "Premier lancement : installation complète, étape par étape."
  fi

  # ---------- a. dossiers d'exécution ----------
  say_title "Installation : dossiers d'exécution"
  local dir existed
  for dir in "$ROOT/data" "$LOG_DIR"; do
    existed=0
    if [ -d "$dir" ]; then existed=1; fi
    if ! mkdir -p "$dir" 2>/dev/null; then
      say 'ERREUR' "Dossier inutilisable : $dir"
      return 1
    fi
    if [ "$existed" = 1 ]; then
      say 'OK' "Dossier déjà présent : $dir"
    else
      say 'OK' "Dossier créé : $dir"
    fi
  done
  report_add 'Dossiers' 'data/ et logs/ disponibles'

  # ---------- b. dépendances ----------
  say_title "Installation : dépendances"
  local code
  if [ -e "$ROOT/node_modules/.bin/tsx" ]; then
    say 'OK' 'Dépendances déjà installées (node_modules/.bin/tsx présent) — étape sautée.'
    report_add 'Dépendances' 'déjà présentes'
  else
    say 'INFO' 'Installation des dépendances…'
    code=0
    if [ -f "$ROOT/package-lock.json" ]; then
      # `npm ci` exige un verrou ; un échec (verrou périmé) retombe sur `install`.
      npm_run 'npm ci' ci
      code="$NPM_CODE"
      if [ "$code" -ne 0 ]; then
        say 'MANQUANT' 'npm ci a échoué : nouvel essai avec npm install.'
        npm_run 'npm install' install
        code="$NPM_CODE"
      fi
    else
      say 'INFO' 'Verrou absent (package-lock.json) : installation avec npm install.'
      npm_run 'npm install' install
      code="$NPM_CODE"
    fi
    if [ "$code" -ne 0 ]; then
      say 'ERREUR' "L'installation des dépendances a échoué. Vérifiez votre connexion Internet, puis relancez ce fichier."
      pause_for_reading
      return 1
    fi
    say 'OK' 'Dépendances installées.'
    report_add 'Dépendances' 'installées'
  fi

  # ---------- c. configuration (.env) ----------
  say_title 'Installation : configuration (.env)'
  local env_file="$ROOT/.env"
  if [ -f "$env_file" ]; then
    say 'OK' 'Fichier .env déjà présent — étape sautée.'
    report_add '.env' 'déjà présent'
  else
    if [ -f "$ROOT/.env.example" ]; then
      if cp "$ROOT/.env.example" "$env_file" 2>/dev/null; then
        say 'OK' 'Fichier .env créé depuis .env.example (la clé se renseigne dans /admin).'
        report_add '.env' 'créé depuis .env.example'
      else
        say 'MANQUANT' 'Impossible de créer le fichier .env : la suite continue avec les valeurs par défaut.'
        report_add '.env' 'non créé (valeurs par défaut)'
      fi
    else
      say 'MANQUANT' 'Fichier .env.example absent : la suite continue avec les valeurs par défaut.'
      report_add '.env' 'non créé (.env.example absent)'
    fi
  fi

  # ---------- d. base de données ----------
  say_title 'Installation : base de données'
  local db_file="$ROOT/data/chapters.db"
  if [ -f "$db_file" ]; then
    say 'OK' 'Base de données déjà présente (data/chapters.db) — étape sautée.'
    report_add 'Base de données' 'déjà présente'
  else
    say 'INFO' 'Base de données absente : application du schéma (npm run db:push)…'
    # Arguments passés SÉPARÉMENT (`run`, `db:push`) : les joindre en une seule
    # chaîne ferait répondre « Unknown command: "run db:push" » à npm.
    npm_run 'npm run db:push' run db:push
    local db_code="$NPM_CODE"
    if [ "$db_code" -ne 0 ]; then
      # Ne JAMAIS démarrer sur une base sans schéma : l'erreur serait ensuite
      # attribuée à tort au serveur (« il ne répond pas »). On explique et on stop.
      say 'ERREUR' "La création du schéma a échoué (npm run db:push, code $db_code) : le serveur ne sera PAS démarré."
      say 'INFO' 'Dernières lignes de la commande :'
      printf '%s\n' "$NPM_OUT" | tail -n 10
      say 'ERREUR' "Corrigez la cause ci-dessus (droits d'écriture sur data/, connexion Internet), puis relancez Démarrer.command."
      pause_for_reading
      return 1
    fi
    say 'OK' 'Schéma appliqué (data/chapters.db).'
    report_add 'Base de données' 'schéma appliqué'
  fi

  # ---------- e. test de fumée multimédia ----------
  say_title 'Installation : test de la chaîne multimédia'
  media_smoke_test
  if [ "$SMOKE_OK" != 1 ]; then
    # Tout le chapitrage local dépend de cette capacité : on s'arrête ICI, avant
    # de démarrer un serveur qui échouerait à chaque découpage.
    say 'ERREUR' "Votre installation de ffmpeg est incomplète : elle ne sait pas encoder en mp3."
    say 'ERREUR' "Le test a échoué pendant la phase « $SMOKE_PHASE » : le chapitrage local en dépend."
    say 'INFO' "Réinstallez FFmpeg (brew install ffmpeg, ou téléchargez-le sur https://ffmpeg.org/download.html), puis relancez Démarrer.command."
    log_line 'SMOKE' "smoke: $SMOKE_OUTPUT"
    report_add 'Test multimédia' "ÉCHEC ($SMOKE_PHASE mp3)"
    return 1
  fi
  say 'OK' "Test réussi : ffmpeg a encodé le mp3 et ffprobe l'a relu."
  report_add 'Test multimédia' 'réussi (mp3 encodé puis relu)'

  # ---------- f. horodatage d'installation ----------
  say_title "Installation : horodatage"
  node_info
  local ff_ver rev short_rev
  ff_ver="$(ffmpeg_version 2>/dev/null)"; [ -n "$ff_ver" ] || ff_ver='inconnue'
  rev="$(repo_revision 2>/dev/null)" || rev=''
  if [ -n "$rev" ]; then short_rev="$(printf '%s' "$rev" | cut -c1-7)"; else short_rev='inconnue'; fi
  if write_install_state "$NODE_VERSION" "$ff_ver" "$rev"; then
    say 'OK' "Horodatage écrit dans $ROOT/data/install.json (Node $NODE_VERSION, ffmpeg $ff_ver, révision $short_rev)."
    report_add 'Horodatage' 'écrit (data/install.json)'
  else
    say 'MANQUANT' "Impossible d'écrire l'horodatage : il sera retenté au prochain lancement."
    report_add 'Horodatage' 'non écrit (nouvel essai au prochain lancement)'
  fi

  return 0
}

# Test de fumée multimédia : 1 s de silence encodée en mp3, puis relue. Une
# installation « amputée » du codec mp3 répond à `-version` mais échoue ici :
# c'est exactement le cas que ce test doit attraper.
SMOKE_OK=0
SMOKE_PHASE='preparation'
SMOKE_OUTPUT=''
media_smoke_test() {
  SMOKE_OK=0
  SMOKE_PHASE='preparation'
  SMOKE_OUTPUT=''
  local dir mp3 enc probe enc_code probe_code
  dir="$(mktemp -d "${TMPDIR:-/tmp}/ckr-smoke.XXXXXXXX" 2>/dev/null)" || return 1
  mp3="$dir/smoke.mp3"
  say 'INFO' 'Encodage de 1 s de silence en mp3 (ffmpeg), puis relecture (ffprobe)…'
  enc="$(ffmpeg -hide_banner -loglevel error -y -f lavfi -i 'anullsrc=r=16000:cl=mono' -t 1 -c:a libmp3lame "$mp3" 2>&1)"
  enc_code=$?
  if [ "$enc_code" -ne 0 ] || [ ! -s "$mp3" ]; then
    SMOKE_PHASE='encodage'
    SMOKE_OUTPUT="$enc"
    rm -rf "$dir" 2>/dev/null || true
    return 1
  fi
  probe="$(ffprobe -hide_banner -loglevel error -show_entries format=duration -of default=noprint_wrappers=1 "$mp3" 2>&1)"
  probe_code=$?
  if [ "$probe_code" -ne 0 ]; then
    SMOKE_PHASE='relecture'
    SMOKE_OUTPUT="$probe"
    rm -rf "$dir" 2>/dev/null || true
    return 1
  fi
  rm -rf "$dir" 2>/dev/null || true
  SMOKE_OK=1
  SMOKE_PHASE=''
  SMOKE_OUTPUT=''
  return 0
}

# Horodatage d'installation : écriture UTF-8 sans BOM, JSON lisible par
# n'importe quel outil (relu par `read_install_state`).
write_install_state() {
  local node_v="$1" ffmpeg_v="$2" revision="$3" now
  mkdir -p "$ROOT/data" 2>/dev/null || return 1
  now="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  {
    printf '{\n'
    printf '  "installedAt": "%s",\n' "$now"
    printf '  "node": "%s",\n' "$node_v"
    printf '  "ffmpeg": "%s",\n' "$ffmpeg_v"
    printf '  "revision": "%s"\n' "$revision"
    printf '}\n'
  } >"$ROOT/data/install.json" 2>/dev/null || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Préflight : lecture seule, aucune installation, aucun démarrage.
# ---------------------------------------------------------------------------

do_check() {
  node_info
  if [ "$NODE_OK" = 1 ]; then
    say 'OK' "Node.js $NODE_VERSION (20 minimum requis)"
  elif [ -n "$NODE_VERSION" ]; then
    say 'MANQUANT' "Node.js $NODE_VERSION est trop ancien : 20 minimum requis"
  else
    say 'MANQUANT' 'Node.js introuvable dans le PATH (20 minimum requis)'
  fi

  if command_available ffmpeg; then say 'OK' 'ffmpeg trouvé'; else say 'MANQUANT' 'ffmpeg introuvable'; fi
  if command_available ffprobe; then say 'OK' 'ffprobe trouvé'; else say 'MANQUANT' 'ffprobe introuvable'; fi

  if [ -e "$ROOT/node_modules/.bin/tsx" ]; then
    say 'OK' 'Dépendances installées (node_modules/.bin/tsx présent)'
  else
    say 'MANQUANT' 'Dépendances absentes : npm ci sera lancé au démarrage'
  fi

  if [ -f "$ROOT/.env" ]; then
    say 'OK' 'Fichier .env présent'
  else
    say 'MANQUANT' 'Fichier .env absent : il sera créé depuis .env.example au démarrage'
  fi

  if [ -f "$ROOT/data/chapters.db" ]; then
    say 'OK' 'Base de données présente (data/chapters.db)'
  else
    say 'MANQUANT' 'Base de données absente (data/chapters.db) : npm run db:push sera lancé au démarrage'
  fi

  select_port
  if [ "$PORT_FORCED" = 1 ]; then
    if [ "$PORT_FREE" = 1 ]; then
      say 'OK' "Port forcé $SELECTED_PORT : libre"
    else
      say 'MANQUANT' "Port forcé $SELECTED_PORT : déjà utilisé"
    fi
  elif [ "$PORT_FREE" = 1 ]; then
    say 'OK' "Port $SELECTED_PORT : libre (il sera utilisé)"
  else
    say 'MANQUANT' 'Aucun port libre entre 3000 et 3010'
  fi

  launch_mode
  if [ "$STATE_CORRUPTED" = 1 ]; then
    say 'MANQUANT' "Fichier d'état d'installation illisible ou corrompu : traité comme un premier lancement."
  fi
  if [ "$OPT_FORCE_INSTALL" = 1 ]; then
    say 'INFO' "Premier lancement forcé (--force-install) : la phase d'installation serait rejouée."
  elif [ "$FIRST_LAUNCH" = 1 ]; then
    say 'INFO' "Premier lancement : la phase d'installation sera jouée au démarrage."
  else
    say 'OK' 'Déjà installé : le démarrage passera par le chemin rapide.'
  fi

  show_startup_log_path
  say 'OK' "Préflight terminé : rien n'a été installé ni démarré."
  printf '\n'
  return 0
}

# ---------------------------------------------------------------------------
# Démarrage réel
# ---------------------------------------------------------------------------

SERVER_PID=''
SERVER_PGID=''
SERVER_PORT=''
SERVER_STOPPED=0

# Vrai si le serveur tourne encore. On juge sur le PROCESSUS — le GROUPE de
# processus (npm → tsx → node), qui porte réellement le serveur — et JAMAIS sur
# le tuyau `tee`, qui peut survivre à la mort de npm. Repli quand l'identifiant de
# groupe n'a pas pu être obtenu : la réponse du PORT (un serveur vivant répond).
server_alive() {
  if [ -n "$SERVER_PGID" ]; then
    kill -s 0 -- "-$SERVER_PGID" 2>/dev/null
    return $?
  fi
  if [ -n "$SERVER_PORT" ] && command_available curl; then
    curl -fsS --max-time 2 -o /dev/null "http://127.0.0.1:$SERVER_PORT/local/health" >/dev/null 2>&1
    return $?
  fi
  return 1
}

# Arrête npm ET ses descendants (tsx → node) : tout le groupe de processus créé
# par `set -m`, jamais le lanceur lui-même.
stop_server() {
  if [ -n "$SERVER_PGID" ]; then
    kill -TERM -- "-$SERVER_PGID" 2>/dev/null || true
  elif [ -n "$SERVER_PID" ]; then
    kill -TERM "$SERVER_PID" 2>/dev/null || true
  fi
  sleep 0.3 2>/dev/null || sleep 1
  if [ -n "$SERVER_PGID" ]; then
    kill -KILL -- "-$SERVER_PGID" 2>/dev/null || true
  elif [ -n "$SERVER_PID" ]; then
    kill -KILL "$SERVER_PID" 2>/dev/null || true
  fi
}

# Nettoyage final : branché sur le trap EXIT, il s'exécute aussi bien à la fin
# normale qu'après un signal (le handler INT/TERM se contente de sortir). Il est
# IDEMPOTENT (le trap EXIT peut suivre le handler de signal) et n'annonce quelque
# chose que s'il restait effectivement un serveur à arrêter.
cleanup_server() {
  if [ "$SERVER_STOPPED" = 1 ]; then return 0; fi
  SERVER_STOPPED=1
  if server_alive; then
    log_line 'EXIT' 'Trap EXIT exécuté : un serveur tournait encore, arrêt du groupe de processus.'
    say 'INFO' 'Arrêt du serveur…'
    stop_server
    say 'OK' 'Serveur arrêté proprement.'
  else
    log_line 'EXIT' 'Trap EXIT exécuté : aucun serveur à arrêter.'
  fi
  return 0
}

# Démarre le serveur : sortie dupliquée dans le journal ET visible (tee), dans un
# groupe de processus dédié pour pouvoir l'arrêter entier d'un seul coup.
start_server() {
  local port="$1"
  SERVER_PID=''
  SERVER_PGID=''
  SERVER_PORT="$port"
  set -m
  PORT="$port" npm start 2>&1 | tee "$SERVER_LOG" &
  SERVER_PID=$!
  # `jobs -p` donne le chef de file du tube (npm) : c'est l'identifiant du groupe.
  SERVER_PGID="$(jobs -p 2>/dev/null | tail -n 1)"
  set +m
  return 0
}

do_start() {
  say_title 'Démarrage de yt-chapters'
  say 'INFO' "Dossier du projet : $ROOT"

  local node_was_installed=0 ffmpeg_was_installed=0

  # ---------- 1. Node.js ----------
  node_info
  if [ "$NODE_OK" != 1 ]; then
    if [ -n "$NODE_VERSION" ]; then
      say 'MANQUANT' "Node.js $NODE_VERSION est trop ancien (20 minimum requis)."
    else
      say 'MANQUANT' 'Node.js est introuvable sur cet ordinateur (20 minimum requis).'
    fi

    if ! command_available brew; then
      say 'ERREUR' "Homebrew (« brew ») n'est pas disponible : impossible d'installer automatiquement."
      say 'ERREUR' "Installez Node.js LTS sur https://nodejs.org/fr/download (ou Homebrew depuis https://brew.sh), puis relancez ce fichier."
      open_url 'https://nodejs.org/fr/download'
      pause_for_reading
      return 1
    fi

    if ! read_consent "Installer Node.js LTS maintenant avec Homebrew ? (o/N) "; then
      say 'ERREUR' 'Installation refusée.'
      say 'ERREUR' "Téléchargez Node.js LTS sur https://nodejs.org/fr/download, installez-le, puis relancez ce fichier."
      open_url 'https://nodejs.org/fr/download'
      pause_for_reading
      return 1
    fi

    brew_run install node
    # Après une installation Homebrew, le binaire est présent mais reste souvent
    # hors du PATH de CETTE session : on complète le PATH puis on revérifie
    # (équivalent macOS de la relecture du registre côté Windows).
    refresh_path
    node_info
    if [ "$NODE_OK" != 1 ]; then
      say 'MANQUANT' "Node.js n'est toujours pas utilisable dans cette fenêtre."
      say 'MANQUANT' "Fermez cette fenêtre, puis relancez Démarrer.command : le nouveau PATH sera pris en compte."
      open_url 'https://nodejs.org/fr/download'
      pause_for_reading
      return 1
    fi
    node_was_installed=1
  fi
  say 'OK' "Node.js $NODE_VERSION"

  # ---------- 2. ffmpeg / ffprobe ----------
  local have_ffmpeg=0 have_ffprobe=0 missing=''
  if command_available ffmpeg; then have_ffmpeg=1; fi
  if command_available ffprobe; then have_ffprobe=1; fi
  if [ "$have_ffmpeg" != 1 ] || [ "$have_ffprobe" != 1 ]; then
    if [ "$have_ffmpeg" != 1 ]; then missing='ffmpeg'; fi
    if [ "$have_ffprobe" != 1 ]; then
      if [ -n "$missing" ]; then missing="$missing et ffprobe"; else missing='ffprobe'; fi
    fi
    say 'MANQUANT' "$missing introuvable(s) : le chapitrage local ne peut pas fonctionner sans eux."

    local installed=0
    if command_available brew; then
      # Même règle de consentement que pour Node.js (refus par défaut).
      if read_consent "Installer $missing maintenant avec Homebrew ? (o/N) "; then
        brew_run install ffmpeg
        # Le binaire vient d'être installé : on complète le PATH de la session
        # AVANT de revérifier, sinon il resterait « introuvable ».
        refresh_path
        if command_available ffmpeg; then have_ffmpeg=1; fi
        if command_available ffprobe; then have_ffprobe=1; fi
        if [ "$have_ffmpeg" = 1 ] && [ "$have_ffprobe" = 1 ]; then installed=1; fi
      else
        say 'MANQUANT' "Installation de $missing refusée : l'installation manuelle est expliquée ci-dessous."
      fi
    fi

    if [ "$installed" != 1 ]; then
      say 'ERREUR' 'ffmpeg et ffprobe restent introuvables : installez-les manuellement.'
      say 'INFO' 'Avec Homebrew : brew install ffmpeg. Sinon, téléchargez une version macOS sur https://ffmpeg.org/download.html'
      say 'INFO' 'Placez les binaires « ffmpeg » et « ffprobe » dans le PATH, puis relancez Démarrer.command.'
      open_url 'https://ffmpeg.org/download.html'
      say 'MANQUANT' 'Fermez cette fenêtre, puis double-cliquez de nouveau sur Démarrer.command après installation.'
      pause_for_reading
      return 1
    fi
    say 'OK' 'ffmpeg et ffprobe sont maintenant disponibles.'
    ffmpeg_was_installed=1
  else
    say 'OK' 'ffmpeg et ffprobe trouvés'
  fi

  # ---------- 3. Premier lancement ou chemin rapide ----------
  # La phase d'installation est jouée si l'horodatage manque, si une pièce manque
  # (dépendances, .env, base) ou si --force-install est demandé. Sinon, on prend
  # le chemin rapide : rien n'est réinstallé, l'horodatage n'est pas réécrit.
  launch_mode
  if [ "$STATE_CORRUPTED" = 1 ]; then
    say 'MANQUANT' "Fichier d'état d'installation illisible ou corrompu : traité comme un premier lancement."
  fi

  local node_label ff_label install_phase_ran=0
  if [ "$node_was_installed" = 1 ]; then node_label="installé (Homebrew), version $NODE_VERSION"; else node_label="présent, version $NODE_VERSION"; fi
  if [ "$ffmpeg_was_installed" = 1 ]; then ff_label='installés (Homebrew)'; else ff_label='présents'; fi

  if [ "$INSTALL_PHASE" = 1 ]; then
    local trigger='premier-lancement'
    if [ "$OPT_FORCE_INSTALL" = 1 ]; then trigger='force'; fi
    report_add 'Node.js' "$node_label"
    report_add 'ffmpeg/ffprobe' "$ff_label"
    if ! do_install_phase "$trigger"; then return 1; fi
    install_phase_ran=1
  else
    say_title 'Chemin rapide : déjà installé'
    # Pièces forcément en place ici (sinon on serait en phase d'installation) : on
    # n'annonce donc jamais une pièce absente. En revanche, Node/ffmpeg ont pu
    # être installés PENDANT ce lancement (Homebrew) : le résumé doit le dire.
    say 'OK' "Node.js $NODE_VERSION, ffmpeg/ffprobe présents, dépendances, .env et base en place"
    say 'OK' 'Installation déjà faite : aucune étape rejouée, horodatage inchangé.'
    report_add 'Node.js' "$node_label"
    report_add 'ffmpeg/ffprobe' "$ff_label"
    report_add 'Dépendances' 'déjà présentes'
    report_add '.env' 'déjà présent'
    report_add 'Base de données' 'déjà présente'
    report_add 'Installation' 'déjà faite (chemin rapide)'
    install_phase_ran=0
  fi

  # ---------- 3bis. Arrêt après installation (--install-only) ----------
  if [ "$OPT_INSTALL_ONLY" = 1 ]; then
    # Aucun serveur ne tourne : le résumé ne doit afficher AUCUNE URL de serveur
    # (ni un port 0), mais désigner /admin quand la clé manque.
    local key_only=0
    if key_configured_from_env; then key_only=1; fi
    say_title "Mode installation seule (--install-only) : le serveur n'est pas démarré"
    show_install_summary "$key_only" 0 0 1
    show_startup_log_path
    return 0
  fi

  # ---------- 4. Port ----------
  select_port
  if [ "$PORT_FREE" != 1 ]; then
    if [ "$PORT_FORCED" = 1 ]; then
      say 'ERREUR' "Le port $SELECTED_PORT est déjà utilisé. Fermez le programme qui l'occupe, ou relancez avec --port <autre port>."
    else
      say 'ERREUR' 'Aucun port libre entre 3000 et 3010. Fermez les programmes qui les occupent, puis relancez.'
    fi
    pause_for_reading
    return 1
  fi
  local port="$SELECTED_PORT"
  # Pas d'URL ici : une adresse de serveur n'est annoncée qu'une fois qu'un
  # serveur répond réellement (jamais « :0 », jamais après un échec).
  say 'OK' "Port $port libre : le serveur l'utilisera."

  # ---------- 5. Démarrage + duplication des journaux ----------
  SERVER_LOG="$LOG_DIR/serveur-$STAMP.log"
  say 'INFO' "Démarrage du serveur (sortie visible ici ET enregistrée dans $SERVER_LOG)"
  start_server "$port"

  # ---------- 6. Attente de disponibilité puis navigateur ----------
  local url="http://127.0.0.1:$port/"
  local health_url="http://127.0.0.1:$port/local/health"
  local ready=0 i=0
  while [ "$i" -lt 60 ]; do
    if ! server_alive; then break; fi
    if curl -fsS --max-time 2 -o /dev/null "$health_url" >/dev/null 2>&1; then
      ready=1
      break
    fi
    sleep 0.5 2>/dev/null || sleep 1
    i=$((i + 1))
  done

  if [ "$ready" != 1 ]; then
    say 'ERREUR' "Le serveur n'a pas répondu dans les 30 secondes."
    if [ -f "$SERVER_LOG" ]; then
      say 'INFO' 'Dernières lignes du journal du serveur :'
      tail -n 25 "$SERVER_LOG"
      local tail_txt
      tail_txt="$(tail -n 25 "$SERVER_LOG" 2>/dev/null)"
      case "$tail_txt" in
        *EADDRINUSE*) say 'ERREUR' "Diagnostic : le port $port est déjà occupé par un autre programme." ;;
        *ffmpeg*|*ENOENT*) say 'ERREUR' 'Diagnostic : ffmpeg/ffprobe introuvable pour ce processus.' ;;
        *SQLITE_BUSY*|*'database is locked'*) say 'ERREUR' 'Diagnostic : la base de données est verrouillée par un autre programme.' ;;
        *) say 'ERREUR' 'Diagnostic : consultez le journal ci-dessus (cause exacte en anglais).' ;;
      esac
    fi
    if [ "$install_phase_ran" = 1 ]; then
      local key_now=0
      if key_configured_from_env; then key_now=1; fi
      show_install_summary "$key_now" "$port" 0 0
    fi
    pause_for_reading
    return 1
  fi

  # Page d'accueil : /admin quand AUCUNE clé n'est configurée (c'est la seule
  # action utile à ce moment), la page principale sinon. L'état vient du serveur
  # lui-même (/local/health), donc de la vraie résolution base + .env.
  local key_configured=0 open_target
  if key_configured_from_server "$port"; then key_configured=1; fi
  if [ "$key_configured" = 1 ]; then open_target="$url"; else open_target="http://127.0.0.1:$port/admin"; fi
  say 'OK' "Serveur prêt : $open_target"
  if [ "$OPT_NO_BROWSER" = 1 ]; then
    say 'INFO' "Navigateur non ouvert (--no-browser) : ouvrez $open_target"
  else
    say 'INFO' 'Ouverture du navigateur…'
    open_url "$open_target"
  fi
  if [ "$install_phase_ran" = 1 ]; then
    show_install_summary "$key_configured" "$port" 1 0
  fi
  show_startup_log_path
  printf '\n'
  say 'INFO' "Le serveur tourne dans cette fenêtre. Pour l'arrêter : Ctrl+C, ou fermez cette fenêtre."
  printf '\n'

  # ---------- 7. Attente de l'arrêt ----------
  wait "$SERVER_PID" 2>/dev/null
  say 'INFO' "Le serveur s'est arrêté."
  return 0
}

# ---------------------------------------------------------------------------
# Point d'entrée
# ---------------------------------------------------------------------------

# Le nettoyage est UN SEUL chemin : le trap EXIT. Un signal se contente de
# sortir, et c'est l'EXIT qui arrête le serveur — quelle que soit la façon dont le
# script se termine (fin normale, erreur, Ctrl+C, TERM).
trap 'exit 130' INT TERM
trap cleanup_server EXIT

printf '\n'
printf '%s\n' 'yt-chapters - démarrage en un clic (macOS)'
log_line 'TITRE' "Démarrage du lanceur (check=$OPT_CHECK, no-browser=$OPT_NO_BROWSER, port=$OPT_PORT)"

# La détection d'OS est isolée dans `is_macos` (neutralisable par les tests via
# CKR_TEST_OS). Sur une autre plateforme, on le dit franchement — sans bloquer :
# la logique reste identique, seuls les outils externes diffèrent.
if ! is_macos; then
  say 'INFO' "Note : ce lanceur est prévu pour macOS ; plateforme détectée : « $(uname -s) »."
fi

# PRÉCAUTION macOS, AVANT le préflight : un Node/ffmpeg/brew installé par
# Homebrew peut être absent du PATH de la session (cas classique du double-clic
# depuis le Finder, qui n'hérite pas du PATH d'un Terminal configuré). On le
# complète d'abord, pour trouver les outils déjà installés au lieu de proposer une
# installation inutile.
refresh_path

CODE=0
if [ "$OPT_CHECK" = 1 ]; then
  do_check || CODE=$?
else
  do_start || CODE=$?
fi
exit "$CODE"
