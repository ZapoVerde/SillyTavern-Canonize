/**
 * @file data/default-user/extensions/canonize/rag/file-store-lb.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — lorebook entry and plot filler file operations
 * @description
 * Lorebook and plot filler operations for the file-based RAG store. Accesses
 * the shared lb and plot cache maps exported by file-store.js. Chunk operations
 * live in file-store.js; this module is strictly the lb/plot half.
 *
 * @api-declaration
 * getLb(avatarKey)               → Promise<object>   (exported for file-store.js)
 * insertLorebookEntries(avatarKey, anchorUuid, lorebookName, entries)
 * queryLorebookEntries(validAnchorUuids, queryText, topK, signal, lorebookName)
 * queryRecentPlotEntries(lorebookName, validAnchorUuids, semanticUids, recencyCount,
 *                        signal, minArcs, fillerEnabled, fillerCards, fillerStrategy, currentTurn)
 * purgeCharacterLbEntries(avatarKey)
 * purgeAnchorLbEntries(anchorUuid)
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [lbCache, plotCache — shared with file-store.js]
 *     external_io:     [GET /user/files/cnz_lb_*.json, GET /user/files/cnz_plot_*.json,
 *                       POST /api/files/upload, embed-client.js, cosine.js]
 */

import { getStringHash }                    from '../../../../utils.js';
import { embedCfg, embedText, embedBatch }  from './embed-client.js';
import { encodeEmbedding, linearScanLb }    from './cosine.js';
import { lbCache, plotCache, readFile, writeFile } from './file-store.js';
import { log }                              from '../log.js';

// ── Cache helpers ─────────────────────────────────────────────────────────────

export async function getLb(avatarKey) {
    if (lbCache.has(avatarKey)) return lbCache.get(avatarKey);
    const data = await readFile(`cnz_lb_${avatarKey}.json`) ?? { version: 1, entries: [] };
    lbCache.set(avatarKey, data);
    return data;
}

async function _setLb(avatarKey, data) {
    lbCache.set(avatarKey, data);
    await writeFile(`cnz_lb_${avatarKey}.json`, data);
}

async function _getPlot(avatarKey) {
    if (plotCache.has(avatarKey)) return plotCache.get(avatarKey);
    const data = await readFile(`cnz_plot_${avatarKey}.json`) ?? { version: 1, fillerHistory: {} };
    plotCache.set(avatarKey, data);
    return data;
}

async function _setPlot(avatarKey, data) {
    plotCache.set(avatarKey, data);
    await writeFile(`cnz_plot_${avatarKey}.json`, data);
}

// ── Lorebook operations ───────────────────────────────────────────────────────

export async function insertLorebookEntries(avatarKey, anchorUuid, lorebookName, entries) {
    if (!entries.length) return { inserted: 0 };

    const cfg  = embedCfg();
    const data = await getLb(avatarKey);
    const existingHashes = new Set(data.entries.filter(e => e.anchorUuid === anchorUuid).map(e => e.hash));
    const toEmbed = entries.filter(e => !existingHashes.has(getStringHash(e.content)));
    if (!toEmbed.length) return { inserted: 0 };

    const embeddings = await embedBatch(cfg, toEmbed.map(e => e.content));
    for (let i = 0; i < toEmbed.length; i++) {
        const e = toEmbed[i];
        data.entries.push({
            hash: getStringHash(e.content), anchorUuid, lorebookName,
            entryUid: e.uid, entryKeys: e.keys ?? [], content: e.content,
            embedding: encodeEmbedding(new Float32Array(embeddings[i])),
        });
    }
    await _setLb(avatarKey, data);
    log('FileStoreLb', `insertLorebookEntries: +${toEmbed.length} for anchor ${anchorUuid.slice(0, 8)}`);
    return { inserted: toEmbed.length };
}

export async function queryLorebookEntries(validAnchorUuids, queryText, topK = 3, signal, lorebookName = null) {
    if (!queryText?.trim() || !validAnchorUuids.length) return [];

    const allEntries = [...lbCache.values()].flatMap(d => d.entries);
    const cfg        = embedCfg();
    const queryVec   = new Float32Array(await embedText(cfg, queryText, signal));

    const semRows = linearScanLb(allEntries, queryVec, validAnchorUuids, topK * 2, lorebookName);
    const seen    = new Map(semRows.map(r => [r.entryUid, r]));

    const tokens = queryText.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
    for (const e of allEntries) {
        if (!validAnchorUuids.includes(e.anchorUuid)) continue;
        if (lorebookName && e.lorebookName !== lorebookName) continue;
        if (seen.has(e.entryUid)) continue;
        if (tokens.some(t => e.content.toLowerCase().includes(t)))
            seen.set(e.entryUid, { lorebookName: e.lorebookName, entryUid: e.entryUid, anchorUuid: e.anchorUuid, score: 0.85 });
    }

    return [...seen.values()].slice(0, topK);
}

// ── Plot filler ───────────────────────────────────────────────────────────────

export async function queryRecentPlotEntries(lorebookName, validAnchorUuids, semanticUids = [], recencyCount = 3, signal, minArcs = 0, fillerEnabled = false, fillerCards = 1, fillerStrategy = 'random', currentTurn = 0) {
    if (!lorebookName || !validAnchorUuids.length) return [];

    const pool = [...lbCache.values()].flatMap(d => d.entries)
        .filter(e => e.lorebookName === lorebookName && validAnchorUuids.includes(e.anchorUuid));

    const getTagsForUids = uids => {
        const rows = pool.filter(e => uids.includes(e.entryUid));
        return [...new Set(rows.flatMap(e => (e.content.match(/#\w+/g) ?? [])))];
    };
    const recentByTag = (tag, count) =>
        pool.filter(e => e.content.includes(tag))
            .sort((a, b) => b.entryUid - a.entryUid)
            .slice(0, count).map(e => e.entryUid);

    const seen = new Set(semanticUids.map(Number));
    const result = [];

    if (semanticUids.length)
        for (const tag of getTagsForUids(semanticUids))
            for (const uid of recentByTag(tag, recencyCount))
                if (!seen.has(uid)) { seen.add(uid); result.push(uid); }

    if (fillerEnabled && minArcs > 0) {
        const arcMap = new Map();
        for (const e of pool)
            for (const tag of (e.content.match(/#\w+/g) ?? []))
                if (!arcMap.has(tag) || e.entryUid > arcMap.get(tag)) arcMap.set(tag, e.entryUid);

        const coveredTags = new Set(getTagsForUids([...seen]));
        const gap         = minArcs - coveredTags.size;
        if (gap > 0) {
            let candidates = [...arcMap.entries()].filter(([tag]) => !coveredTags.has(tag));
            const ak = [...lbCache.keys()][0];

            if (fillerStrategy === 'oldest_arc') {
                candidates.sort((a, b) => a[1] - b[1]);
            } else if (fillerStrategy === 'oldest_surfaced' && ak) {
                const plot = await _getPlot(ak);
                candidates.sort((a, b) => {
                    const aT = plot.fillerHistory[`${lorebookName}/${a[0]}`]?.lastSurfacedTurn ?? 0;
                    const bT = plot.fillerHistory[`${lorebookName}/${b[0]}`]?.lastSurfacedTurn ?? 0;
                    return (aT > currentTurn ? 0 : aT) - (bT > currentTurn ? 0 : bT);
                });
            } else {
                for (let i = candidates.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
                }
            }

            const fills = candidates.slice(0, gap).map(([tag]) => tag);
            for (const tag of fills)
                for (const uid of recentByTag(tag, fillerCards))
                    if (!seen.has(uid)) { seen.add(uid); result.push(uid); }

            if (fills.length && ak) {
                const plot = await _getPlot(ak);
                for (const tag of fills)
                    plot.fillerHistory[`${lorebookName}/${tag}`] = { lastSurfacedTurn: currentTurn };
                await _setPlot(ak, plot);
            }
        }
    }
    return result;
}

// ── Purge ─────────────────────────────────────────────────────────────────────

export async function purgeCharacterLbEntries(avatarKey) {
    lbCache.delete(avatarKey);
    plotCache.delete(avatarKey);
    await writeFile(`cnz_lb_${avatarKey}.json`, { version: 1, entries: [] });
    await writeFile(`cnz_plot_${avatarKey}.json`, { version: 1, fillerHistory: {} });
}

export async function purgeAnchorLbEntries(anchorUuid) {
    for (const [ak, data] of lbCache) {
        const before  = data.entries.length;
        data.entries  = data.entries.filter(e => e.anchorUuid !== anchorUuid);
        if (data.entries.length !== before) await _setLb(ak, data);
    }
}
