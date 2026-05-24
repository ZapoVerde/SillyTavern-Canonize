/**
 * @file plugins/cnz/db.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
 * @architectural-role IO Wrapper — PGlite embedded database
 * @description
 * Schema init and query helpers over an embedded PGlite (WASM Postgres) database.
 * Vector dimension is detected lazily on first insert and stored in model_meta.
 * If the model changes and the dimension differs, tables are dropped and recreated —
 * the healer handles data rebuild from stamps. Cosine similarity is computed by
 * pgvector's <=> operator inside the DB; no JS-side similarity loops.
 * Hybrid retrieval: rag_chunks carries a nullable header_embedding vector and a
 * tsvector fts_vector column (GIN-indexed) for BM25 keyword search.
 *
 * @api-declaration
 * initDb()                                           → Promise<void>
 * ensureDimension(dim)                               → Promise<void>
 * upsertChunks(rows)                                 → Promise<void>
 * queryChunks(validUuids, queryVec, topK, threshold) → Promise<Row[]>
 * queryChunksByHeader(validUuids, queryVec, topK)    → Promise<Row[]>
 * queryChunksByKeyword(validUuids, queryText, topK)  → Promise<Row[]>
 * upsertLbEntries(rows)                              → Promise<void>
 * queryLbEntries(validUuids, queryVec, topK, threshold) → Promise<Row[]>
 * purgeChunksByAnchor(anchorUuid)                    → Promise<void>
 * purgeChunksByAvatarKey(avatarKey)                  → Promise<void>
 * purgeLbEntriesByAnchor(anchorUuid)                 → Promise<void>
 * purgeLbEntriesByAvatarKey(avatarKey)               → Promise<void>
 * chunkCountForAvatar(avatarKey)                     → Promise<number>
 * chunkCountForAnchor(anchorUuid)                    → Promise<number>
 * lbEntryCountForAvatar(avatarKey)                   → Promise<number>
 * lbEntryCountForAnchor(anchorUuid)                  → Promise<number>
 * lbHashesForAnchor(anchorUuid)                      → Promise<number[]>
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

/**
 * Called on first insert once we know the embedding dimension.
 * Drops and recreates tables if the model changed (dimension differs).
 */
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

// ── Vector formatting ─────────────────────────────────────────────────────────

const toVec = arr => `[${arr.join(',')}]`;

// ── Chunks ────────────────────────────────────────────────────────────────────

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
         FROM rag_chunks
         WHERE anchor_uuid = ANY($2)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
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
         WHERE anchor_uuid = ANY($2)
           AND header_embedding IS NOT NULL
         ORDER BY header_embedding <=> $1::vector
         LIMIT $3`,
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
         ORDER BY score DESC
         LIMIT $3`,
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

// ── Lorebook entries ──────────────────────────────────────────────────────────

export async function upsertLbEntries(rows) {
    for (const r of rows) {
        await _db.query(
            `INSERT INTO lb_entries
                (hash, anchor_uuid, avatar_key, lorebook_name, entry_uid, entry_keys, content, embedding, fts_vector)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8::vector,
                     to_tsvector('english', $7 || ' ' || coalesce($6, '')))
             ON CONFLICT (hash, anchor_uuid) DO NOTHING`,
            [r.hash, r.anchor_uuid, r.avatar_key, r.lorebook_name,
             r.entry_uid, r.entry_keys ?? null, r.content, toVec(r.embedding)]
        );
    }
}

export async function queryLbEntries(validUuids, queryVec, topK, threshold = 0) {
    if (!_schemaReady || !validUuids.length) return [];
    const r = await _db.query(
        `SELECT lorebook_name, entry_uid, entry_keys, anchor_uuid,
                1 - (embedding <=> $1::vector) AS score
         FROM lb_entries
         WHERE anchor_uuid = ANY($2)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [toVec(queryVec), validUuids, topK]
    );
    return r.rows.filter(row => row.score >= threshold);
}

export async function queryLbEntriesByKeyword(validUuids, queryText, topK) {
    if (!_schemaReady || !validUuids.length || !queryText?.trim()) return [];
    const r = await _db.query(
        `SELECT lorebook_name, entry_uid, entry_keys, anchor_uuid,
                ts_rank_cd(fts_vector, plainto_tsquery('english', $1)) AS score
         FROM lb_entries
         WHERE anchor_uuid = ANY($2)
           AND fts_vector IS NOT NULL
           AND fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY score DESC
         LIMIT $3`,
        [queryText, validUuids, topK]
    );
    return r.rows;
}

export async function purgeLbEntriesByAnchor(anchorUuid) {
    await _db.query('DELETE FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
}

export async function purgeLbEntriesByAvatarKey(avatarKey) {
    await _db.query('DELETE FROM lb_entries WHERE avatar_key = $1', [avatarKey]);
}

export async function lbEntryCountForAvatar(avatarKey) {
    if (!_schemaReady) return 0;
    const r = await _db.query('SELECT COUNT(*) AS n FROM lb_entries WHERE avatar_key = $1', [avatarKey]);
    return Number(r.rows[0].n);
}

export async function lbEntryCountForAnchor(anchorUuid) {
    if (!_schemaReady) return 0;
    const r = await _db.query('SELECT COUNT(*) AS n FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
    return Number(r.rows[0].n);
}

export async function lbHashesForAnchor(anchorUuid) {
    if (!_schemaReady) return [];
    const r = await _db.query('SELECT hash FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
    return r.rows.map(row => Number(row.hash));
}
