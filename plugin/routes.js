/**
 * @file plugins/cnz/routes.js
 * @stamp {"utc":"2026-05-31T00:00:00.000Z"}
 * @architectural-role IO Wrapper — Chunk route handlers
 * @description
 * Registers chunk, embed-stream, purge, and health endpoints, then delegates
 * lorebook and plot endpoints to routes-lb.js.
 *
 * @api-declaration
 * registerRoutes(router) → void
 *
 * Endpoints:
 *   POST /insert-chunks    — embed + upsert chat chunks
 *   POST /query-chunks     — embed query, return top-K chunks by cosine score
 *   POST /purge-anchor     — delete all chunks + lb entries for an anchor
 *   POST /purge-character  — delete all chunks + lb entries for an avatarKey
 *   POST /test-embed       — probe the configured embedding model with a short sentence
 *   GET  /embed-stats      — current embedding queue stats
 *   GET  /embed-stream     — SSE stream of embedding progress
 *   GET  /health           — chunk + lb entry counts for avatar / anchor
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [embed.js, db.js, db-lb.js, rrf.js]
 */

import { embedWithSource, embedBatchWithSource, getEmbedStats, addSseClient, removeSseClient, readMakerSuiteKey } from './embed.js';
import { ensureDimension, upsertChunks, queryChunks, queryChunksByHeader, queryChunksByKeyword,
         purgeChunksByAvatarKey, purgeChunksByAnchor, chunkCountForAvatar, chunkCountForAnchor } from './db.js';
import { purgeLbEntriesByAnchor, purgeLbEntriesByAvatarKey,
         lbEntryCountForAvatar, lbEntryCountForAnchor, lbHashesForAnchor,
         plotEntryCountForAnchor } from './db-lb.js';
import { rrf } from './rrf.js';
import { registerLbRoutes } from './routes-lb.js';

function embedCfg(req) {
    const b   = req.body;
    const cfg = { source: b.embeddingSource ?? 'openrouter', model: b.embeddingModel ?? '', directories: req.user.directories, request: req };
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
            const cSet = new Set(contentRows.map(r => r.content));
            const hSet = new Set(headerRows.map(r => r.content));
            const kSet = new Set(kwRows.map(r => r.content));
            const srcSummary = {};
            for (const r of merged) {
                const key = [cSet.has(r.content) && 'vec', hSet.has(r.content) && 'hdr', kSet.has(r.content) && 'kw'].filter(Boolean).join('+') || '?';
                srcSummary[key] = (srcSummary[key] || 0) + 1;
            }
            console.log(`[cnz] query-chunks merged=${merged.length} sources=${JSON.stringify(srcSummary)}`);
            return res.json(merged.map(r => ({
                text: r.content, header: r.header, turnRange: r.turn_range,
                pairStart: r.pair_start, pairEnd: r.pair_end, score: Number(r.score),
                chatFile: r.chat_file ?? null, anchorUuid: r.anchor_uuid,
                sources: [cSet.has(r.content) && 'vec', hSet.has(r.content) && 'hdr', kSet.has(r.content) && 'kw'].filter(Boolean),
            })));
        } catch (err) {
            console.error('[cnz] query-chunks:', err);
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
        } catch (err) { console.error('[cnz] purge-anchor:', err); return res.status(500).json({ error: err.message }); }
    });

    // ── POST /purge-character ─────────────────────────────────────────────────
    router.post('/purge-character', async (req, res) => {
        try {
            const { avatarKey } = req.body;
            if (!avatarKey) return res.status(400).json({ error: 'avatarKey required' });
            await purgeChunksByAvatarKey(avatarKey);
            await purgeLbEntriesByAvatarKey(avatarKey);
            return res.json({ ok: true });
        } catch (err) { console.error('[cnz] purge-character:', err); return res.status(500).json({ error: err.message }); }
    });

    // ── POST /test-embed ──────────────────────────────────────────────────────
    router.post('/test-embed', async (req, res) => {
        try {
            const cfg   = embedCfg(req);
            const start = Date.now();
            const vec   = await embedWithSource(cfg, 'The quick brown fox jumps over the lazy dog.');
            const ms    = Date.now() - start;
            return res.json({ ok: true, dim: vec.length, nonZero: vec.filter(v => v !== 0).length, ms });
        } catch (err) {
            console.error('[cnz] test-embed:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── GET /embed-stats ──────────────────────────────────────────────────────
    router.get('/embed-stats', (_req, res) => res.json(getEmbedStats()));

    // ── GET /embed-stream ─────────────────────────────────────────────────────
    router.get('/embed-stream', (req, res) => {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no');
        res.flushHeaders();
        res.write(`data: ${JSON.stringify(getEmbedStats())}\n\n`);
        addSseClient(res);
        const heartbeat = setInterval(() => { try { res.write(': keepalive\n\n'); } catch { clearInterval(heartbeat); } }, 20000);
        req.on('close', () => { clearInterval(heartbeat); removeSseClient(res); });
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
            if (anchorUuid) result.plotEntriesForAnchor  = await plotEntryCountForAnchor(String(anchorUuid));
            if (anchorUuid) result.lbHashesForAnchor     = await lbHashesForAnchor(String(anchorUuid));
            return res.json(result);
        } catch (err) { console.error('[cnz] health:', err); return res.status(500).json({ error: err.message }); }
    });

    // ── GET /aistudio-models ──────────────────────────────────────────────────
    router.get('/aistudio-models', async (req, res) => {
        try {
            const apiKey = readMakerSuiteKey(req.user.directories);
            if (!apiKey) return res.status(400).json({ error: 'Google AI Studio API key not configured in ST.' });
            const url  = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                const text = await resp.text();
                return res.status(resp.status).json({ error: `Google AI error ${resp.status}: ${text}` });
            }
            const data   = await resp.json();
            const models = (data.models ?? [])
                .filter(m => (m.supportedGenerationMethods ?? []).includes('embedContent'))
                .map(m => ({ id: m.name.replace(/^models\//, ''), displayName: m.displayName ?? '' }));
            return res.json({ models });
        } catch (err) {
            console.error('[cnz] aistudio-models:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    registerLbRoutes(router);
}
