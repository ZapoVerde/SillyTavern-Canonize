/**
 * @file server-plugin/db.js
 * @description SQLite schema init and low-level query helpers. One module-level
 * Database instance shared across all route handlers. Multi-user installs should
 * extend this to a per-user Map; for single-user self-hosted setups one DB is fine.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH   = path.join(__dirname, 'cnz.db');

/** @type {Database.Database} */
let _db;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS rag_chunks (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hash        INTEGER NOT NULL,
    anchor_uuid TEXT    NOT NULL,
    avatar_key  TEXT    NOT NULL,
    chat_file   TEXT,
    pair_start  INTEGER NOT NULL,
    pair_end    INTEGER NOT NULL,
    header      TEXT,
    turn_range  TEXT,
    text        TEXT    NOT NULL,
    embedding   TEXT    NOT NULL,
    indexed_at  INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_chunk    ON rag_chunks(hash, anchor_uuid);
CREATE INDEX        IF NOT EXISTS idx_avatar    ON rag_chunks(avatar_key);
CREATE INDEX        IF NOT EXISTS idx_anchor    ON rag_chunks(anchor_uuid);

CREATE TABLE IF NOT EXISTS lb_entries (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    hash           INTEGER NOT NULL,
    anchor_uuid    TEXT    NOT NULL,
    lorebook_name  TEXT    NOT NULL,
    entry_uid      TEXT    NOT NULL,
    entry_keys     TEXT,
    text           TEXT    NOT NULL,
    embedding      TEXT    NOT NULL,
    indexed_at     INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_lb_entry ON lb_entries(hash, anchor_uuid);
CREATE INDEX        IF NOT EXISTS idx_lb_book   ON lb_entries(lorebook_name);
`;

export function initDb() {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.exec(SCHEMA);
}

export function closeDb() {
    _db?.close();
}

export function getDb() {
    return _db;
}

// ─── RAG chunks ───────────────────────────────────────────────────────────────

export function upsertChunks(chunks) {
    const stmt = _db.prepare(`
        INSERT OR IGNORE INTO rag_chunks
            (hash, anchor_uuid, avatar_key, chat_file, pair_start, pair_end,
             header, turn_range, text, embedding)
        VALUES
            (@hash, @anchor_uuid, @avatar_key, @chat_file, @pair_start, @pair_end,
             @header, @turn_range, @text, @embedding)
    `);
    const tx = _db.transaction((rows) => { for (const r of rows) stmt.run(r); });
    tx(chunks);
}

export function queryChunksByAnchorUuids(anchorUuids) {
    if (!anchorUuids.length) return [];
    const placeholders = anchorUuids.map(() => '?').join(',');
    return _db.prepare(
        `SELECT id, hash, anchor_uuid, pair_start, pair_end, header, turn_range, text, embedding
         FROM rag_chunks WHERE anchor_uuid IN (${placeholders})`
    ).all(...anchorUuids);
}

export function purgeChunksByAnchor(anchorUuid) {
    _db.prepare('DELETE FROM rag_chunks WHERE anchor_uuid = ?').run(anchorUuid);
}

export function purgeChunksByAvatarKey(avatarKey) {
    _db.prepare('DELETE FROM rag_chunks WHERE avatar_key = ?').run(avatarKey);
}

export function chunkCountForAnchor(anchorUuid) {
    return _db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE anchor_uuid = ?').get(anchorUuid)?.n ?? 0;
}

export function chunkCountForAvatar(avatarKey) {
    return _db.prepare('SELECT COUNT(*) AS n FROM rag_chunks WHERE avatar_key = ?').get(avatarKey)?.n ?? 0;
}
