import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const videos = sqliteTable('videos', {
  id: text('id').primaryKey(), // YouTube video id
  title: text('title').notNull(),
  channel: text('channel'),
  durationSec: integer('duration_sec').notNull().default(0),
  transcriptLang: text('transcript_lang'),
  /**
   * Chemin du média d'un chapitrage LOCAL (fichier du cache d'envoi ou fichier
   * de MEDIA_DIR) : permet de servir `GET /media/:id` et de retrouver le média
   * dans l'éditeur de bornes (`/edit`). `null` pour une vidéo YouTube.
   */
  mediaPath: text('media_path'),
  createdAt: integer('created_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const segments = sqliteTable(
  'transcript_segments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    startSec: real('start_sec').notNull(),
    endSec: real('end_sec').notNull(),
    text: text('text').notNull(),
  },
  (t) => ({ byVideo: index('seg_video_idx').on(t.videoId, t.startSec) }),
);

/**
 * Réglages applicatifs clé/valeur (ex. la clé OpenRouter). Le schéma Drizzle est
 * la source de vérité déclarée ; la MÊME définition est rejouée de façon
 * idempotente au démarrage (`src/db/app-settings.ts`) pour qu'un `db:push`
 * oublié n'entraîne pas une erreur SQL brute dans la section d'administration.
 */
export const appSettings = sqliteTable('app_settings', {
  id: text('id').primaryKey(),
  value: text('value').notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp' })
    .notNull()
    .default(sql`(unixepoch())`),
});

export const chapters = sqliteTable(
  'chapters',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    videoId: text('video_id')
      .notNull()
      .references(() => videos.id, { onDelete: 'cascade' }),
    startSec: integer('start_sec').notNull(),
    title: text('title').notNull(),
    source: text('source', { enum: ['llm', 'manual'] }).notNull(),
    validated: integer('validated', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp' })
      .notNull()
      .default(sql`(unixepoch())`),
  },
  (t) => ({ byVideo: index('chap_video_idx').on(t.videoId, t.startSec) }),
);
