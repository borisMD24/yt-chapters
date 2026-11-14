// Résolution de l'interface d'écoute HTTP.
//
// DÉFAUT = boucle locale : le serveur n'est joignable que depuis CET ordinateur.
// Deux conséquences voulues : aucune pop-up pare-feu au premier lancement (macOS
// comme Windows), et `/admin` (réglages, masque de clé) n'est pas exposé au
// réseau local. `HOST=0.0.0.0` (ou une adresse précise) ouvre explicitement.
export const DEFAULT_HOST = '127.0.0.1';

/**
 * Adresse d'écoute : `HOST` s'il est renseigné (espaces ignorés), sinon la
 * boucle locale. Une valeur vide ou blanche retombe sur le défaut.
 */
export function resolveHost(raw: string | undefined): string {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || DEFAULT_HOST;
}