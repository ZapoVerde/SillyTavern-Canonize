/**
 * @file plugins/cnz/routes-lb.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role IO Wrapper — Lorebook and plot route handlers
 * @description
 * Registers lorebook and plot endpoints on the Express router.
 * Called by routes.js as part of registerRoutes().
 *
 * @api-declaration
 * registerLbRoutes(router) → void
 *
 * Endpoints:
 *   POST /insert-lorebook      — embed + upsert lorebook entries
 *   POST /query-lorebook       — embed query, return top-K lb entries
 *   POST /recent-plot-entries  — recency + filler arc selection
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [embed.js, db-lb.js]
 */

import { embedWithSource, embedBatchWithSource } from './embed.js';
import { ensureDimension } from './db.js';
import {
    upsertLbEntries, queryLbEntries, queryLbEntriesByKeyword,
    fetchEntryContentByUids, queryRecentByTag, getAllPlotEntries,
    getFillerHistory, upsertFillerHistory,
} from './db-lb.js';

function embedCfg(req) {
    const b   = req.body;
    const cfg = { source: b.embeddingSource ?? 'openrouter', model: b.embeddingModel ?? '', directories: req.user.directories, request: req };
    if (b.embeddingApiUrl)       cfg.apiUrl     = b.embeddingApiUrl;
    if (b.embeddingKeep != null) cfg.keep        = b.embeddingKeep;
    if (b.embeddingUrlOverride)  cfg.urlOverride = b.embeddingUrlOverride;
    return cfg;
}

export function registerLbRoutes(router) {

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
            const byUid = new Map();
            for (const r of semRows) byUid.set(Number(r.entry_uid), r);
            for (const r of kwRows)  if (!byUid.has(Number(r.entry_uid))) byUid.set(Number(r.entry_uid), { ...r, score: 0.85 });
            const merged = [...byUid.values()].slice(0, topK);
            console.log(`[cnz] query-lorebook hybrid: semantic=${semRows.length} keyword=${kwRows.length} → merged=${merged.length}`);
            return res.json(merged.map(r => ({ lorebookName: r.lorebook_name, entryUid: Number(r.entry_uid), entryKeys: r.entry_keys, score: Number(r.score), anchorUuid: r.anchor_uuid })));
        } catch (err) {
            console.error('[cnz] query-lorebook:', err);
            return res.status(500).json({ error: err.message });
        }
    });

    // ── POST /recent-plot-entries ─────────────────────────────────────────────
    router.post('/recent-plot-entries', async (req, res) => {
        try {
            const { lorebookName, validAnchorUuids, semanticUids = [], recencyCount = 3,
                    minArcs = 0, fillerEnabled = false, fillerCards = 1, fillerStrategy = 'random',
                    currentTurn = 0 } = req.body;
            if (!lorebookName || !Array.isArray(validAnchorUuids) || !validAnchorUuids.length)
                return res.json([]);
            const seen = new Set(semanticUids.map(Number));
            const result = [];
            if (semanticUids.length) {
                const rows  = await fetchEntryContentByUids(lorebookName, semanticUids);
                const tags  = [...new Set(rows.flatMap(r => (r.content.match(/#\w+/g) ?? [])))];
                const byTag = await Promise.all(tags.map(t => queryRecentByTag(lorebookName, validAnchorUuids, t, recencyCount)));
                for (const uids of byTag) for (const uid of uids) if (!seen.has(uid)) { seen.add(uid); result.push(uid); }
            }
            if (fillerEnabled && minArcs > 0) {
                const all  = await getAllPlotEntries(lorebookName, validAnchorUuids);
                const arcMap = new Map();
                for (const row of all)
                    for (const tag of (row.content.match(/#\w+/g) ?? []))
                        if (!arcMap.has(tag) || row.entry_uid > arcMap.get(tag)) arcMap.set(tag, row.entry_uid);
                const semanticRows = semanticUids.length ? await fetchEntryContentByUids(lorebookName, semanticUids) : [];
                const coveredTags  = new Set(semanticRows.flatMap(r => (r.content.match(/#\w+/g) ?? [])));
                const gap = minArcs - coveredTags.size;
                if (gap > 0) {
                    let candidates = [...arcMap.entries()].filter(([tag]) => !coveredTags.has(tag));
                    if (fillerStrategy === 'oldest_surfaced') {
                        const history = await getFillerHistory(lorebookName);
                        candidates.sort((a, b) => {
                            const aT = history.get(a[0]) ?? 0;
                            const bT = history.get(b[0]) ?? 0;
                            return (aT > currentTurn ? 0 : aT) - (bT > currentTurn ? 0 : bT);
                        });
                    } else if (fillerStrategy === 'oldest_arc') {
                        candidates.sort((a, b) => a[1] - b[1]);
                    } else {
                        for (let i = candidates.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [candidates[i], candidates[j]] = [candidates[j], candidates[i]]; }
                    }
                    const fills  = candidates.slice(0, gap).map(([tag]) => tag);
                    const byFill = await Promise.all(fills.map(t => queryRecentByTag(lorebookName, validAnchorUuids, t, fillerCards)));
                    for (const uids of byFill) for (const uid of uids) if (!seen.has(uid)) { seen.add(uid); result.push(uid); }
                    await upsertFillerHistory(lorebookName, fills, currentTurn);
                }
            }
            return res.json(result);
        } catch (err) {
            console.error('[cnz] recent-plot-entries:', err);
            return res.status(500).json({ error: err.message });
        }
    });
}
