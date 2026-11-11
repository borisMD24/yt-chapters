import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';
import { ensureAppSettingsTable } from './app-settings';

/** Chemin du fichier SQLite (affiché par la section d'administration). */
export const dbPath = process.env.DB_PATH ?? 'data/chapters.db';
mkdirSync(dirname(dbPath), { recursive: true });

/** Poignée SQLite brute (DDL idempotents, table de réglages). */
export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');

// Auto-réparation : la table des réglages est créée de façon idempotente au
// démarrage, sans dépendre de `npm run db:push` (voir src/db/app-settings.ts).
ensureAppSettingsTable(sqlite);

export const db = drizzle(sqlite, { schema });
