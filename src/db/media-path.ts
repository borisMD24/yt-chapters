// Auto-réparation de la table `videos` : ajout idempotent de la colonne
// `media_path` (chemin du média d'un chapitrage local : fichier du cache
// d'envoi, ou fichier de MEDIA_DIR).
//
// Même intention que `src/db/app-settings.ts` : le schéma Drizzle
// (`src/db/schema.ts`) reste la source de vérité DÉCLARÉE, mais un
// `npm run db:push` oublié ne doit pas faire échouer la route média ni
// l'éditeur de bornes sur une erreur SQL brute.
//
// Ce module n'importe PAS `src/db/index.ts` : il se teste sur une base isolée.

/** Surface minimale de `better-sqlite3` utilisée ici. */
export type SqliteLike = {
  exec(sql: string): unknown;
  prepare(sql: string): { all(...params: unknown[]): unknown[] };
};

/** Vrai si `videos.media_path` existe déjà. */
function hasMediaPathColumn(sqlite: SqliteLike): boolean {
  const cols = sqlite.prepare('PRAGMA table_info(videos)').all() as { name?: unknown }[];
  return Array.isArray(cols) && cols.some((c) => c && c.name === 'media_path');
}

/**
 * Ajoute `media_path` si la table existe et que la colonne manque. Ne jette
 * jamais : renvoie `true` si la colonne est disponible APRÈS l'appel, `false`
 * sinon (table absente — un `db:push` reste alors nécessaire).
 */
export function ensureVideosMediaPathColumn(sqlite: SqliteLike): boolean {
  try {
    if (hasMediaPathColumn(sqlite)) return true;
    sqlite.exec('ALTER TABLE videos ADD COLUMN media_path TEXT');
    return true;
  } catch {
    return false;
  }
}
