/**
 * @file plugins/cnz/db.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role IO Wrapper — PGlite connection, schema, and chunk operations
 * @description
 * Owns the PGlite connection, schema init, dimension management, and all
 * rag_chunks query helpers. Lorebook and plot operations live in db-lb.js,
 * which accesses the shared connection via getDb() / isSchemaReady().
 *
 * @api-declaration
 * initDb, ensureDimension, getDb, isSchemaReady
 * upsertChunks, queryChunks, queryChunksByHeader, queryChunksByKeyword
 * purgeChunksByAnchor, purgeChunksByAvatarKey
 * chunkCountForAvatar, chunkCountForAnchor
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_db, _dim, _schemaReady]
 *     external_io:     [filesystem via PGlite]
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';

const DATA_DIR = process.env.CNZ_DB_PATH ?? './data/cnz-pg';

let _db          = null;
let _dim         = null;
let _schemaReady = false;

export const getDb          = () => _db;
export const isSchemaReady  = () => _schemaReady;

async function _createTables(dim) {
    await _db.exec(`
        CREATE TABLE IF NOT EXISTS rag_chunks (
            id               SERIAL  PRIMARY KEY,
            hash             BIGINT  NOT NULL,
            anchor_uuid      TEXT    NOT NULL,
            avatar_key       TEXT    NOT NULL,
            chat_file        TEXT,
            pair_start       INTEGER NOT NULL,
            pair_end         INTEGER NOT NULL,
            header           TEXT,
            turn_range       TEXT,
            content          TEXT    NOT NULL,
            embedding        vector(${dim}) NOT NULL,
            header_embedding vector(${dim}),
            fts_vector       tsvector,
            indexed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_chunk       ON rag_chunks(hash, anchor_uuid);
        CREATE INDEX        IF NOT EXISTS idx_chunk_avatar ON rag_chunks(avatar_key);
        CREATE INDEX        IF NOT EXISTS idx_chunk_anchor ON rag_chunks(anchor_uuid);
        ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS header_embedding vector(${dim});
        ALTER TABLE rag_chunks ADD COLUMN IF NOT EXISTS fts_vector tsvector;
        CREATE INDEX IF NOT EXISTS idx_chunk_fts ON rag_chunks USING GIN(fts_vector);

        CREATE TABLE IF NOT EXISTS lb_entries (
            id             SERIAL  PRIMARY KEY,
            hash           BIGINT  NOT NULL,
            anchor_uuid    TEXT    NOT NULL,
            avatar_key     TEXT    NOT NULL,
            lorebook_name  TEXT    NOT NULL,
            entry_uid      INTEGER NOT NULL,
            entry_keys     TEXT,
            content        TEXT    NOT NULL,
            embedding      vector(${dim}) NOT NULL,
            fts_vector     tsvector,
            indexed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uniq_lb       ON lb_entries(hash, anchor_uuid);
        CREATE INDEX        IF NOT EXISTS idx_lb_avatar ON lb_entries(avatar_key);
        CREATE INDEX        IF NOT EXISTS idx_lb_anchor ON lb_entries(anchor_uuid);
        ALTER TABLE lb_entries ADD COLUMN IF NOT EXISTS fts_vector tsvector;
        CREATE INDEX IF NOT EXISTS idx_lb_fts ON lb_entries USING GIN(fts_vector);

        CREATE TABLE IF NOT EXISTS plot_filler_history (
            lorebook_name       TEXT    NOT NULL,
            arc_tag             TEXT    NOT NULL,
            last_surfaced_turn  INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (lorebook_name, arc_tag)
        );
    `);
    _schemaReady = true;
}

export async function initDb() {
    _db = await PGlite.create(DATA_DIR, { extensions: { vector } });
    await _db.exec('CREATE EXTENSION IF NOT EXISTS vector');
    await _db.exec('CREATE TABLE IF NOT EXISTS model_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
    const r = await _db.query("SELECT value FROM model_meta WHERE key = 'dim'");
    if (r.rows.length) {
        _dim = Number(r.rows[0].value);
        await _createTables(_dim);
    }
    console.log(`[cnz] DB ready at ${DATA_DIR} dim=${_dim ?? 'pending'}`);
}

export async function ensureDimension(dim) {
    if (_schemaReady && _dim === dim) return;
    if (_dim !== null && _dim !== dim) {
        console.warn(`[cnz] Embedding dimension changed ${_dim} → ${dim} — dropping vector tables for healer rebuild`);
        await _db.exec('DROP TABLE IF EXISTS rag_chunks; DROP TABLE IF EXISTS lb_entries;');
        _schemaReady = false;
    }
    _dim = dim;
    await _db.exec(
        `INSERT INTO model_meta (key, value) VALUES ('dim', '${dim}')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`
    );
    if (!_schemaReady) await _createTables(dim);
}

const toVec = arr => `[${arr.join(',')}]`;

export async function upsertChunks(rows) {
    for (const r of rows) {
        await _db.query(
            `INSERT INTO rag_chunks
                (hash, anchor_uuid, avatar_key, chat_file, pair_start, pair_end,
                 header, turn_range, content, embedding, header_embedding, fts_vector)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::vector,$11::vector,
                     to_tsvector('english', $9 || ' ' || coalesce($7, '')))
             ON CONFLICT (hash, anchor_uuid) DO NOTHING`,
            [r.hash, r.anchor_uuid, r.avatar_key, r.chat_file ?? null,
             r.pair_start, r.pair_end, r.header ?? null, r.turn_range ?? null,
             r.content, toVec(r.embedding),
             r.header_embedding ? toVec(r.header_embedding) : null]
        );
    }
}

export async function queryChunks(validUuids, queryVec, topK, threshold = 0) {
    if (!_schemaReady || !validUuids.length) return [];
    const r = await _db.query(
        `SELECT content, header, turn_range, pair_start, pair_end,
                chat_file, anchor_uuid,
                1 - (embedding <=> $1::vector) AS score
         FROM rag_chunks WHERE anchor_uuid = ANY($2)
         ORDER BY embedding <=> $1::vector LIMIT $3`,
        [toVec(queryVec), validUuids, topK]
    );
    return r.rows.filter(row => row.score >= threshold);
}

export async function queryChunksByHeader(validUuids, queryVec, topK) {
    if (!_schemaReady || !validUuids.length) return [];
    const r = await _db.query(
        `SELECT content, header, turn_range, pair_start, pair_end,
                chat_file, anchor_uuid,
                1 - (header_embedding <=> $1::vector) AS score
         FROM rag_chunks
         WHERE anchor_uuid = ANY($2) AND header_embedding IS NOT NULL
         ORDER BY header_embedding <=> $1::vector LIMIT $3`,
        [toVec(queryVec), validUuids, topK]
    );
    return r.rows;
}

export async function queryChunksByKeyword(validUuids, queryText, topK) {
    if (!_schemaReady || !validUuids.length || !queryText?.trim()) return [];
    const r = await _db.query(
        `SELECT content, header, turn_range, pair_start, pair_end,
                chat_file, anchor_uuid,
                ts_rank_cd(fts_vector, plainto_tsquery('english', $1)) AS score
         FROM rag_chunks
         WHERE anchor_uuid = ANY($2)
           AND fts_vector IS NOT NULL
           AND fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY score DESC LIMIT $3`,
        [queryText, validUuids, topK]
    );
    return r.rows;
}

export async function purgeChunksByAnchor(anchorUuid) {
    await _db.query('DELETE FROM rag_chunks WHERE anchor_uuid = $1', [anchorUuid]);
}

export async function purgeChunksByAvatarKey(avatarKey) {
    await _db.query('DELETE FROM rag_chunks WHERE avatar_key = $1', [avatarKey]);
}

export async function chunkCountForAvatar(avatarKey) {
    if (!_schemaReady) return 0;
    const r = await _db.query('SELECT COUNT(*) AS n FROM rag_chunks WHERE avatar_key = $1', [avatarKey]);
    return Number(r.rows[0].n);
}

export async function chunkCountForAnchor(anchorUuid) {
    if (!_schemaReady) return 0;
    const r = await _db.query('SELECT COUNT(*) AS n FROM rag_chunks WHERE anchor_uuid = $1', [anchorUuid]);
    return Number(r.rows[0].n);
}
