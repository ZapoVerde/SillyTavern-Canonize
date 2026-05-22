/**
 * @file server-plugin/routes.js
 * @description Express route handlers for the CNZ DB plugin. Registered under
 * /api/plugins/cnz/ by index.js. Each route is one logical operation: insert
 * chunks (embed + store), query chunks (embed + cosine rank), purge, or health.
 */

import {
    upsertChunks, queryChunksByAnchorUuids,
    purgeChunksByAnchor, purgeChunksByAvatarKey,
    chunkCountForAnchor, chunkCountForAvatar,
} from './db.js';
import { embedWithSource, embedBatchWithSource, cosineSimilarity } from './embed.js';

/**
 * @param {import('express').Router} router
 */
export function registerRoutes(router) {

    // ── POST /insert-chunks ─────────────────────────────────────────────────
    // Body: { avatarKey, anchorUuid, chatFile, chunks: [{hash, pairStart, pairEnd, header, turnRange, text}] }
    router.post('/insert-chunks', async (req, res) => {
        try {
            const { avatarKey, anchorUuid, chatFile, chunks,
                    embeddingSource, embeddingModel, embeddingApiKey } = req.body;
            if (!avatarKey || !anchorUuid || !Array.isArray(chunks) || chunks.length === 0) {
                return res.status(400).json({ error: 'avatarKey, anchorUuid, and non-empty chunks required' });
            }

            const embedCfg   = { source: embeddingSource ?? 'local', model: embeddingModel, apiKey: embeddingApiKey };
            const texts      = chunks.map(c => c.text);
            const embeddings = await embedBatchWithSource(embedCfg, texts);

            const rows = chunks.map((c, i) => ({
                hash:        c.hash,
                anchor_uuid: anchorUuid,
                avatar_key:  avatarKey,
                chat_file:   chatFile ?? null,
                pair_start:  c.pairStart,
                pair_end:    c.pairEnd,
                header:      c.header   ?? null,
                turn_range:  c.turnRange ?? null,
                text:        c.text,
                embedding:   JSON.stringify(embeddings[i]),
            }));

            upsertChunks(rows);
            return res.json({ inserted: rows.length });
        } catch (err) {
            console.error('[CNZ plugin] insert-chunks:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /query-chunks ──────────────────────────────────────────────────
    // Body: { queryText, validAnchorUuids: string[], topK?: number }
    // Returns: [{ text, header, turnRange, pairStart, pairEnd, score }]
    router.post('/query-chunks', async (req, res) => {
        try {
            const { queryText, validAnchorUuids, topK = 5,
                    embeddingSource, embeddingModel, embeddingApiKey } = req.body;
            if (!queryText || !Array.isArray(validAnchorUuids) || validAnchorUuids.length === 0) {
                return res.json([]);
            }

            const embedCfg = { source: embeddingSource ?? 'local', model: embeddingModel, apiKey: embeddingApiKey };
            const queryVec = await embedWithSource(embedCfg, queryText);
            const rows     = queryChunksByAnchorUuids(validAnchorUuids);

            const scored = rows
                .map(r => ({
                    text:      r.text,
                    header:    r.header,
                    turnRange: r.turn_range,
                    pairStart: r.pair_start,
                    pairEnd:   r.pair_end,
                    score:     cosineSimilarity(queryVec, JSON.parse(r.embedding)),
                }))
                .sort((a, b) => b.score - a.score)
                .slice(0, topK);

            return res.json(scored);
        } catch (err) {
            console.error('[CNZ plugin] query-chunks:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /purge-anchor ──────────────────────────────────────────────────
    // Body: { anchorUuid }
    router.post('/purge-anchor', (req, res) => {
        try {
            const { anchorUuid } = req.body;
            if (!anchorUuid) return res.status(400).json({ error: 'anchorUuid required' });
            purgeChunksByAnchor(anchorUuid);
            return res.json({ ok: true });
        } catch (err) {
            console.error('[CNZ plugin] purge-anchor:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /purge-character ───────────────────────────────────────────────
    // Body: { avatarKey }
    router.post('/purge-character', (req, res) => {
        try {
            const { avatarKey } = req.body;
            if (!avatarKey) return res.status(400).json({ error: 'avatarKey required' });
            purgeChunksByAvatarKey(avatarKey);
            return res.json({ ok: true });
        } catch (err) {
            console.error('[CNZ plugin] purge-character:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── GET /health ─────────────────────────────────────────────────────────
    // Query params: ?avatarKey=...&anchorUuid=...
    router.get('/health', (req, res) => {
        try {
            const { avatarKey, anchorUuid } = req.query;
            const result = {};
            if (anchorUuid) result.chunksForAnchor   = chunkCountForAnchor(String(anchorUuid));
            if (avatarKey)  result.chunksForCharacter = chunkCountForAvatar(String(avatarKey));
            return res.json(result);
        } catch (err) {
            console.error('[CNZ plugin] health:', err);
            return res.status(500).json({ error: err.message });
        }
    });
}
