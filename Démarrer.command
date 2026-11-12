#!/bin/bash
#
# Démarrage en un clic de yt-chapters — macOS.
#
# Double-cliquez sur ce fichier depuis le Finder : il lance `scripts/launch.sh`,
# qui installe ce qui manque, démarre le serveur et ouvre le navigateur. La
# fenêtre du Terminal reste ouverte à la fin (pour lire un message d'erreur).
#
# IMPORTANT : ce fichier doit rester EXÉCUTABLE DANS L'INDEX GIT
# (`git update-index --chmod=+x Démarrer.command`). Sans le bit `+x`, un
# `git clone` restitue un fichier non exécutable et le double-clic échoue — de
# façon silencieuse et déroutante. Le dépôt pose le bit, pas l'utilisateur.
#
# Si macOS affiche « le fichier est endommagé » ou refuse l'exécution (dossier
# TÉLÉCHARGÉ en .zip, donc mis en quarantaine par Gatekeeper) : clic droit sur
# le fichier → « Ouvrir », puis confirmez. Un dépôt cloné par git n'est PAS mis
# en quarantaine.
#
# Options possibles (en ligne de commande) :
#   ./Démarrer.command --check         vérifie l'environnement sans rien installer
#   ./Démarrer.command --no-browser    démarre sans ouvrir le navigateur
#   ./Démarrer.command --port 3001     force le port
#   ./Démarrer.command --force-install rejoue la phase d'installation complète
#   ./Démarrer.command --install-only  installe puis s'arrête sans démarrer le serveur

set -u

# Toutes les commandes partent du dossier de ce fichier, même si le script est
# lancé depuis un autre dossier (le double-clic du Finder part souvent de $HOME).
SELF_DIR="$(cd -P "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
cd "$SELF_DIR" >/dev/null 2>&1 || {
  printf 'Dossier introuvable : %s\n' "$SELF_DIR" >&2
  exit 1
}

# On réutilise l'interpréteur bash courant (sur macOS : /bin/bash, version 3.2).
BASH_BIN="${BASH:-/bin/bash}"

"$BASH_BIN" "$SELF_DIR/scripts/launch.sh" "$@"
CODE=$?

printf '\n(Fin du démarrage, code %s.)\n' "$CODE"
printf 'Appuyez sur Entrée pour fermer…'
IFS= read -r _ || true
exit "$CODE"
