/**
 * @file plugins/cnz/routes.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
 * @architectural-role IO Wrapper — Express route handlers
 * @description
 * Registers all CNZ vector store endpoints on the provided Express router.
 * Each route builds an embed config from the request (source, model, directories,
 * plus provider-specific extras), delegates embedding to embed.js, calls
 * ensureDimension on the resulting vector length, then delegates to db.js.
 * /insert-chunks embeds headers in parallel with content. /query-chunks runs
 * content, header, and keyword searches in parallel and fuses them via RRF.
 *
 * @api-declaration
 * registerRoutes(router) → void
 *
 * Endpoints:
 *   POST /insert-chunks    — embed + upsert chat chunks
 *   POST /query-chunks     — embed query, return top-K chunks by cosine score
 *   POST /insert-lorebook  — embed + upsert lorebook entries
 *   POST /query-lorebook   — embed query, return top-K lb entries by cosine score
 *   POST /purge-anchor     — delete all chunks + lb entries for an anchor
 *   POST /purge-character  — delete all chunks + lb entries for an avatarKey
 *   GET  /health           — chunk + lb entry counts, lb hashes for anchor
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [embed.js, db.js, rrf.js]
 */

import { embedWithSource, embedBatchWithSource, getEmbedStats, addSseClient, removeSseClient } from './embed.js';
import {
    ensureDimension,
    upsertChunks, queryChunks, queryChunksByHeader, queryChunksByKeyword,
    upsertLbEntries, queryLbEntries, queryLbEntriesByKeyword,
    purgeChunksByAnchor, purgeChunksByAvatarKey,
    purgeLbEntriesByAnchor, purgeLbEntriesByAvatarKey,
    chunkCountForAvatar, chunkCountForAnchor,
    lbEntryCountForAvatar, lbEntryCountForAnchor, lbHashesForAnchor,
    fetchEntryContentByUids, queryRecentByTag,
} from './db.js';
import { rrf } from './rrf.js';

function embedCfg(req) {
    const b   = req.body;
    const cfg = {
        source:      b.embeddingSource ?? 'openrouter',
        model:       b.embeddingModel  ?? '',
        directories: req.user.directories,
        request:     req,
    };
    if (b.embeddingApiUrl)       cfg.apiUrl     = b.embeddingApiUrl;
    if (b.embeddingKeep != null) cfg.keep        = b.embeddingKeep;
    if (b.embeddingUrlOverride)  cfg.urlOverride = b.embeddingUrlOverride;
    return cfg;
}

export function registerRoutes(router) {

    // ── POST /insert-chunks ───────────────────────────────────────────────────
    router.post('/insert-chunks', async (req, res) => {
        try {
            const { avatarKey, anchorUuid, chatFile, chunks } = req.body;
            if (!avatarKey || !anchorUuid || !Array.isArray(chunks) || !chunks.length)
                return res.status(400).json({ error: 'avatarKey, anchorUuid, and non-empty chunks required' });

            const cfg          = embedCfg(req);
            const headerChunks = chunks.filter(c => c.header);
            const [contentEmb, headerEmb] = await Promise.all([
                embedBatchWithSource(cfg, chunks.map(c => c.text)),
                headerChunks.length ? embedBatchWithSource(cfg, headerChunks.map(c => c.header)) : Promise.resolve([]),
            ]);
            await ensureDimension(contentEmb[0].length);

            const headerEmbByHash = new Map(headerChunks.map((c, i) => [c.hash, headerEmb[i]]));
            const rows = chunks.map((c, i) => ({
                hash: c.hash, anchor_uuid: anchorUuid, avatar_key: avatarKey,
                chat_file: chatFile ?? null, pair_start: c.pairStart, pair_end: c.pairEnd,
                header: c.header ?? null, turn_range: c.turnRange ?? null,
                content: c.text, embedding: contentEmb[i],
                header_embedding: headerEmbByHash.get(c.hash) ?? null,
            }));
            await upsertChunks(rows);
            return res.json({ inserted: rows.length });
        } catch (err) {
            console.error('[cnz] insert-chunks:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /query-chunks ────────────────────────────────────────────────────
    router.post('/query-chunks', async (req, res) => {
        try {
            const { queryText, validAnchorUuids, topK = 5 } = req.body;
            if (!queryText || !Array.isArray(validAnchorUuids) || !validAnchorUuids.length)
                return res.json([]);

            const cfg      = embedCfg(req);
            const queryVec = await embedWithSource(cfg, queryText);
            const pool     = topK * 2;
            const [contentRows, headerRows, kwRows] = await Promise.all([
                queryChunks(validAnchorUuids, queryVec, pool),
                queryChunksByHeader(validAnchorUuids, queryVec, pool),
                queryChunksByKeyword(validAnchorUuids, queryText, pool),
            ]);
            console.log(`[cnz] query-chunks hybrid: content=${contentRows.length} header=${headerRows.length} keyword=${kwRows.length} → rrf topK=${topK}`);
            const merged = rrf({ content: contentRows, header: headerRows, keyword: kwRows }, topK);
            return res.json(merged.map(r => ({
                text:       r.content,
                header:     r.header,
                turnRange:  r.turn_range,
                pairStart:  r.pair_start,
                pairEnd:    r.pair_end,
                score:      Number(r.score),
                chatFile:   r.chat_file ?? null,
                anchorUuid: r.anchor_uuid,
            })));
        } catch (err) {
            console.error('[cnz] query-chunks:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /insert-lorebook ─────────────────────────────────────────────────
    router.post('/insert-lorebook', async (req, res) => {
        try {
            const { avatarKey, anchorUuid, lorebookName, entries } = req.body;
            if (!avatarKey || !anchorUuid || !lorebookName || !Array.isArray(entries) || !entries.length)
                return res.status(400).json({ error: 'avatarKey, anchorUuid, lorebookName, and non-empty entries required' });

            const cfg        = embedCfg(req);
            const embeddings = await embedBatchWithSource(cfg, entries.map(e => e.content));
            await ensureDimension(embeddings[0].length);

            const rows = entries.map((e, i) => ({
                hash: e.hash, anchor_uuid: anchorUuid, avatar_key: avatarKey,
                lorebook_name: lorebookName, entry_uid: e.uid,
                entry_keys: Array.isArray(e.keys) ? e.keys.join(',') : (e.keys ?? null),
                content: e.content, embedding: embeddings[i],
            }));
            await upsertLbEntries(rows);
            return res.json({ inserted: rows.length });
        } catch (err) {
            console.error('[cnz] insert-lorebook:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /query-lorebook ──────────────────────────────────────────────────
    router.post('/query-lorebook', async (req, res) => {
        try {
            const { queryText, validAnchorUuids, topK = 3, lorebookName = null } = req.body;
            if (!queryText || !Array.isArray(validAnchorUuids) || !validAnchorUuids.length)
                return res.json([]);

            const cfg      = embedCfg(req);
            const queryVec = await embedWithSource(cfg, queryText);
            const [semRows, kwRows] = await Promise.all([
                queryLbEntries(validAnchorUuids, queryVec, topK * 2, 0, lorebookName),
                queryLbEntriesByKeyword(validAnchorUuids, queryText, topK * 2, lorebookName),
            ]);
            // Union by entry_uid — prefer semantic score; keyword hits use fixed 0.85
            const byUid = new Map();
            for (const r of semRows) byUid.set(Number(r.entry_uid), r);
            for (const r of kwRows) {
                if (!byUid.has(Number(r.entry_uid)))
                    byUid.set(Number(r.entry_uid), { ...r, score: 0.85 });
            }
            const merged = [...byUid.values()].slice(0, topK);
            console.log(`[cnz] query-lorebook hybrid: semantic=${semRows.length} keyword=${kwRows.length} → merged=${merged.length}`);
            return res.json(merged.map(r => ({
                lorebookName: r.lorebook_name,
                entryUid:     Number(r.entry_uid),
                entryKeys:    r.entry_keys,
                score:        Number(r.score),
                anchorUuid:   r.anchor_uuid,
            })));
        } catch (err) {
            console.error('[cnz] query-lorebook:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /purge-anchor ────────────────────────────────────────────────────
    router.post('/purge-anchor', async (req, res) => {
        try {
            const { anchorUuid } = req.body;
            if (!anchorUuid) return res.status(400).json({ error: 'anchorUuid required' });
            await purgeChunksByAnchor(anchorUuid);
            await purgeLbEntriesByAnchor(anchorUuid);
            return res.json({ ok: true });
        } catch (err) {
            console.error('[cnz] purge-anchor:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /purge-character ─────────────────────────────────────────────────
    router.post('/purge-character', async (req, res) => {
        try {
            const { avatarKey } = req.body;
            if (!avatarKey) return res.status(400).json({ error: 'avatarKey required' });
            await purgeChunksByAvatarKey(avatarKey);
            await purgeLbEntriesByAvatarKey(avatarKey);
            return res.json({ ok: true });
        } catch (err) {
            console.error('[cnz] purge-character:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── GET /embed-stats ──────────────────────────────────────────────────────
    router.get('/embed-stats', (req, res) => res.json(getEmbedStats()));

    // ── GET /embed-stream ─────────────────────────────────────────────────────
    router.get('/embed-stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // disable Traefik/nginx proxy buffering
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(getEmbedStats())}\n\n`); // send current state immediately
        addSseClient(res);
        const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); } }, 20000);
        req.on('close', () => { clearInterval(heartbeat); removeSseClient(res); });
    });

    // ── POST /recent-plot-entries ─────────────────────────────────────────────
    router.post('/recent-plot-entries', async (req, res) => {
        try {
            const { lorebookName, validAnchorUuids, semanticUids = [], recencyCount = 3 } = req.body;
            if (!lorebookName || !Array.isArray(validAnchorUuids) || !validAnchorUuids.length || !semanticUids.length)
                return res.json([]);
            const rows = await fetchEntryContentByUids(lorebookName, semanticUids);
            const tags = [...new Set(rows.flatMap(r => (r.content.match(/#\w+/g) ?? [])))];
            if (!tags.length) return res.json([]);
            const byTag  = await Promise.all(tags.map(t => queryRecentByTag(lorebookName, validAnchorUuids, t, recencyCount)));
            const seen   = new Set(semanticUids.map(Number));
            const result = [];
            for (const uids of byTag) for (const uid of uids) if (!seen.has(uid)) { seen.add(uid); result.push(uid); }
            return res.json(result);
        } catch (err) {
            console.error('[cnz] recent-plot-entries:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── GET /health ───────────────────────────────────────────────────────────
    router.get('/health', async (req, res) => {
        try {
            const { avatarKey, anchorUuid } = req.query;
            const result = {};
            if (avatarKey)  result.chunksForCharacter    = await chunkCountForAvatar(String(avatarKey));
            if (avatarKey)  result.lbEntriesForCharacter = await lbEntryCountForAvatar(String(avatarKey));
            if (anchorUuid) result.chunksForAnchor       = await chunkCountForAnchor(String(anchorUuid));
            if (anchorUuid) result.lbEntriesForAnchor    = await lbEntryCountForAnchor(String(anchorUuid));
            if (anchorUuid) result.lbHashesForAnchor     = await lbHashesForAnchor(String(anchorUuid));
            return res.json(result);
        } catch (err) {
            console.error('[cnz] health:', err);
            return res.status(500).json({ error: err.message });
        }
    });
}
