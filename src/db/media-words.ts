// Auto-réparation de la table `media_words` : les mots horodatés d'un
// chapitrage LOCAL, conservés pour l'éditeur de bornes (« Texte autour de la
// borne »).
//
// Même intention que `src/db/app-settings.ts` et `src/db/media-path.ts` : le
// schéma Drizzle (`src/db/schema.ts`) reste la source de vérité DÉCLARÉE, mais un
// `npm run db:push` oublié ne doit pas casser la lecture des mots ni l'éditeur
// sur une erreur SQL brute. La MÊME définition est rejouée de façon idempotente
// au démarrage.
//
// Cette table est DÉDIÉE : `transcript_segments` n'est jamais utilisée pour les
// médias locaux (elle reste réservée aux sous-titres YouTube).
//
// Ce module n'importe PAS `src/db/index.ts` : il se teste sur une base isolée.

/** DDL idempotent, aligné sur la table Drizzle `media_words`. */
export const MEDIA_WORDS_DDL = `CREATE TABLE IF NOT EXISTS media_words (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  video_id TEXT NOT NULL REFERENCES videos(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL
)`;

/** Index idempotent sur `(video_id, start_ms)` : lecture d'une fenêtre temporelle. */
export const MEDIA_WORDS_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS media_words_video_idx ON media_words (video_id, start_ms)';

/** Surface minimale de `better-sqlite3` utilisée ici (facilite les tests). */
export type SqliteLike = {
  exec(sql: string): unknown;
};

/**
 * Crée la table `media_words` et son index si elles manquent. Ne jette jamais :
 * renvoie `false` en échec (base verrouillée ou illisible).
 */
export function ensureMediaWordsTable(sqlite: SqliteLike): boolean {
  try {
    sqlite.exec(MEDIA_WORDS_DDL);
    sqlite.exec(MEDIA_WORDS_INDEX_DDL);
    return true;
  } catch {
    return false;
  }
}
