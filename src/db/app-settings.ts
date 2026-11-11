// Accès brut à la table de réglages `app_settings` (clé/valeur), partagé par le
// démarrage de l'application et le résolveur de clé OpenRouter.
//
// Le schéma Drizzle (`src/db/schema.ts`) reste la source de vérité DÉCLARÉE ; ce
// module fournit la MÊME définition sous forme de DDL idempotent, exécuté au
// démarrage, afin qu'un utilisateur ayant oublié `npm run db:push` obtienne une
// section d'administration fonctionnelle plutôt qu'une erreur SQL brute.
//
// Aucune valeur de réglage n'est journalisée par ce module.

/** DDL idempotent, aligné sur la table Drizzle `app_settings`. */
export const APP_SETTINGS_DDL = `CREATE TABLE IF NOT EXISTS app_settings (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
)`;

/** Surface minimale de `better-sqlite3` utilisée ici (facilite les tests). */
export type SqliteLike = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): unknown;
  };
};

export type StoredSetting = { value: string; updatedAt: Date };

/** Crée la table si elle manque. Ne jette jamais : renvoie `false` en échec. */
export function ensureAppSettingsTable(sqlite: SqliteLike): boolean {
  try {
    sqlite.exec(APP_SETTINGS_DDL);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lit un réglage. Si la table manque (db:push oublié), elle est créée à la
 * volée puis la lecture est retentée une fois ; en cas d'échec persistant, la
 * fonction renvoie `undefined` au lieu de propager une erreur SQL.
 */
export function readAppSetting(sqlite: SqliteLike, id: string): StoredSetting | undefined {
  const attempt = (): StoredSetting | undefined => {
    const row = sqlite.prepare('SELECT value, updated_at FROM app_settings WHERE id = ?').get(id) as
      | { value?: unknown; updated_at?: unknown }
      | undefined;
    if (!row || typeof row.value !== 'string') return undefined;
    const seconds = Number(row.updated_at);
    return { value: row.value, updatedAt: Number.isFinite(seconds) ? new Date(seconds * 1000) : new Date(0) };
  };
  try {
    return attempt();
  } catch {
    if (!ensureAppSettingsTable(sqlite)) return undefined;
    try {
      return attempt();
    } catch {
      return undefined;
    }
  }
}

/** Écrit (ou remplace) un réglage. Renvoie `false` si la base refuse l'écriture. */
export function writeAppSetting(sqlite: SqliteLike, id: string, value: string): boolean {
  if (!ensureAppSettingsTable(sqlite)) return false;
  try {
    sqlite
      .prepare(
        `INSERT INTO app_settings (id, value, updated_at) VALUES (?, ?, unixepoch())
         ON CONFLICT(id) DO UPDATE SET value = excluded.value, updated_at = unixepoch()`,
      )
      .run(id, value);
    return true;
  } catch {
    return false;
  }
}

/** Supprime un réglage. Renvoie `false` si la base refuse l'opération. */
export function deleteAppSetting(sqlite: SqliteLike, id: string): boolean {
  if (!ensureAppSettingsTable(sqlite)) return false;
  try {
    sqlite.prepare('DELETE FROM app_settings WHERE id = ?').run(id);
    return true;
  } catch {
    return false;
  }
}
