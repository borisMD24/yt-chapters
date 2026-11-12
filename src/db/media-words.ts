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
// IMPORTANT : ce DDL est la forme CANONIQUE produite par `drizzle-kit push`.
// Drizzle introspecte le SQL/les contraintes de la table ; une variante
// « équivalente » (clé étrangère en ligne plutôt qu'en contrainte de table) lui
// faisait RECONSTRUIRE `media_words` et émettre deux fois le CREATE INDEX
// (`SqliteError: index media_words_video_idx already exists`, `db:push` en
// échec). Ne pas modifier ces formes sans revérifier `db:push`.
//
// Cette table est DÉDIÉE : `transcript_segments` n'est jamais utilisée pour les
// médias locaux (elle reste réservée aux sous-titres YouTube).
//
// Ce module n'importe PAS `src/db/index.ts` : il se teste sur une base isolée.

/** DDL idempotent, forme canonique de Drizzle pour `media_words`. */
export const MEDIA_WORDS_DDL = `CREATE TABLE IF NOT EXISTS media_words (
  id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  video_id text NOT NULL,
  start_ms integer NOT NULL,
  end_ms integer NOT NULL,
  text text NOT NULL,
  FOREIGN KEY (video_id) REFERENCES videos(id) ON UPDATE no action ON DELETE cascade
)`;

/** Index idempotent, forme canonique de Drizzle (`media_words_video_idx`). */
export const MEDIA_WORDS_INDEX_DDL =
  'CREATE INDEX IF NOT EXISTS media_words_video_idx ON media_words (video_id,start_ms)';

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

/**
 * Vrai si l'erreur trahit l'ABSENCE de `media_words` (ou un schéma de cette
 * table incompatible) : dans ce cas seulement, on dégrade proprement au lieu de
 * répondre `500`. Une autre erreur (E/S, corruption, requête inattendue) reste
 * visible.
 *
 * Les colonnes `start_ms`/`end_ms` n'existent que dans cette table : un
 * « no such column » qui les cite vient forcément de `media_words`.
 */
export function isMediaWordsUnavailable(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  if (/no such table:?\s*[`"']?(main\.)?media_words/i.test(message)) return true;
  return /no such column:?\s*[`"']?(start_ms|end_ms)/i.test(message);
}
