/**
 * @file plugins/cnz/db-lb.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role IO Wrapper — Lorebook and plot DB operations
 * @description
 * Query helpers for the lb_entries and plot_filler_history tables.
 * Connection and schema init live in db.js; this file consumes them
 * via getDb() / isSchemaReady() accessors.
 *
 * @api-declaration
 * upsertLbEntries, queryLbEntries, queryLbEntriesByKeyword
 * purgeLbEntriesByAnchor, purgeLbEntriesByAvatarKey
 * lbEntryCountForAvatar, lbEntryCountForAnchor, lbHashesForAnchor
 * fetchEntryContentByUids, queryRecentByTag, getAllPlotEntries
 * getFillerHistory, upsertFillerHistory
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none — db state owned by db.js]
 *     external_io:     [PGlite via db.js]
 */

import { getDb, isSchemaReady } from './db.js';

const toVec = arr => `[${arr.join(',')}]`;

export async function upsertLbEntries(rows) {
    const db = getDb();
    for (const r of rows) {
        await db.query(
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

export async function queryLbEntries(validUuids, queryVec, topK, threshold = 0, lorebookName = null) {
    if (!isSchemaReady() || !validUuids.length) return [];
    const r = await getDb().query(
        `SELECT lorebook_name, entry_uid, entry_keys, anchor_uuid,
                1 - (embedding <=> $1::vector) AS score
         FROM lb_entries
         WHERE anchor_uuid = ANY($2)
           AND ($4::text IS NULL OR lorebook_name = $4)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [toVec(queryVec), validUuids, topK, lorebookName ?? null]
    );
    return r.rows.filter(row => row.score >= threshold);
}

export async function queryLbEntriesByKeyword(validUuids, queryText, topK, lorebookName = null) {
    if (!isSchemaReady() || !validUuids.length || !queryText?.trim()) return [];
    const r = await getDb().query(
        `SELECT lorebook_name, entry_uid, entry_keys, anchor_uuid,
                ts_rank_cd(fts_vector, plainto_tsquery('english', $1)) AS score
         FROM lb_entries
         WHERE anchor_uuid = ANY($2)
           AND ($4::text IS NULL OR lorebook_name = $4)
           AND fts_vector IS NOT NULL
           AND fts_vector @@ plainto_tsquery('english', $1)
         ORDER BY score DESC
         LIMIT $3`,
        [queryText, validUuids, topK, lorebookName ?? null]
    );
    return r.rows;
}

export async function purgeLbEntriesByAnchor(anchorUuid) {
    await getDb().query('DELETE FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
}

export async function purgeLbEntriesByAvatarKey(avatarKey) {
    await getDb().query('DELETE FROM lb_entries WHERE avatar_key = $1', [avatarKey]);
}

export async function lbEntryCountForAvatar(avatarKey) {
    if (!isSchemaReady()) return 0;
    const r = await getDb().query('SELECT COUNT(*) AS n FROM lb_entries WHERE avatar_key = $1', [avatarKey]);
    return Number(r.rows[0].n);
}

export async function lbEntryCountForAnchor(anchorUuid) {
    if (!isSchemaReady()) return 0;
    const r = await getDb().query('SELECT COUNT(*) AS n FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
    return Number(r.rows[0].n);
}

export async function lbHashesForAnchor(anchorUuid) {
    if (!isSchemaReady()) return [];
    const r = await getDb().query('SELECT hash FROM lb_entries WHERE anchor_uuid = $1', [anchorUuid]);
    return r.rows.map(row => Number(row.hash));
}

export async function plotEntryCountForAnchor(anchorUuid) {
    if (!isSchemaReady()) return 0;
    const r = await getDb().query(`SELECT COUNT(*) AS n FROM lb_entries WHERE anchor_uuid=$1 AND lorebook_name LIKE '%_plot'`, [anchorUuid]);
    return Number(r.rows[0].n);
}

export async function fetchEntryContentByUids(lorebookName, uids) {
    if (!isSchemaReady() || !uids.length) return [];
    return (await getDb().query(`SELECT entry_uid, content FROM lb_entries WHERE lorebook_name=$1 AND entry_uid=ANY($2::integer[])`, [lorebookName, uids.map(Number)])).rows;
}

export async function queryRecentByTag(lorebookName, validUuids, tag, limit) {
    if (!isSchemaReady() || !validUuids.length || !tag) return [];
    const r = await getDb().query(`SELECT entry_uid FROM lb_entries WHERE lorebook_name=$1 AND anchor_uuid=ANY($2) AND content ILIKE $3 ORDER BY entry_uid DESC LIMIT $4`, [lorebookName, validUuids, `%${tag}%`, limit]);
    return r.rows.map(row => Number(row.entry_uid));
}

export async function getAllPlotEntries(lorebookName, validUuids) {
    if (!isSchemaReady() || !validUuids.length) return [];
    const r = await getDb().query(`SELECT entry_uid, content FROM lb_entries WHERE lorebook_name=$1 AND anchor_uuid=ANY($2) ORDER BY entry_uid ASC`, [lorebookName, validUuids]);
    return r.rows;
}

export async function getFillerHistory(lorebookName) {
    if (!isSchemaReady()) return new Map();
    const r = await getDb().query('SELECT arc_tag, last_surfaced_turn FROM plot_filler_history WHERE lorebook_name=$1', [lorebookName]);
    return new Map(r.rows.map(row => [row.arc_tag, Number(row.last_surfaced_turn)]));
}

export async function upsertFillerHistory(lorebookName, arcTags, turnNumber) {
    if (!isSchemaReady() || !arcTags.length) return;
    for (const tag of arcTags)
        await getDb().query(`INSERT INTO plot_filler_history (lorebook_name, arc_tag, last_surfaced_turn) VALUES ($1,$2,$3) ON CONFLICT (lorebook_name, arc_tag) DO UPDATE SET last_surfaced_turn=$3`, [lorebookName, tag, turnNumber]);
}
