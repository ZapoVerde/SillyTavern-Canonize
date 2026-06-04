/**
 * @file data/default-user/extensions/canonize/rag/file-store-lb.js
 * @stamp {"utc":"2026-06-04T02:00:00.000Z"}
 * @version 3.0.0
 * @architectural-role IO Wrapper — lorebook entry and plot filler operations
 * @description
 * Lorebook entry and plot filler insert, query, and purge operations against the
 * per-chat RAG store. All data lives in cnz_store_{chatKey}.json via chat-store.js.
 * Plot filler history is stored per-anchor (head anchor for the current session);
 * it resets naturally at each anchor boundary.
 *
 * @api-declaration
 * insertLorebookEntries(chatKey, anchorUuid, lorebookName, entries) → Promise<{inserted}>
 * queryLorebookEntries(chatKey, validAnchorUuids, queryText, signal, lorebookName?)
 *   → Promise<Result[]>
 * queryRecentPlotEntries(chatKey, lorebookName, validAnchorUuids, semanticUids,
 *   recencyCount, signal, minArcs, fillerEnabled, fillerCards, fillerStrategy,
 *   currentTurn) → Promise<number[]>
 * purgeAnchorLbEntries(chatKey, anchorUuid) → Promise<void>
 * purgeChatLbEntries(chatKey)               → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none — chat-store.js owns the cache]
 *     external_io:     [chat-store.js, embed-direct.js]
 */

import { getStringHash }                    from '../../../../utils.js';
import { embedCfg, reportEmbedUsage }       from './embed-client.js';
import { embedBatch }                       from './embed-direct.js';
import { dot, encodeVec }                   from './vec-math.js';
import { emit, BUS_EVENTS }                 from '../bus.js';
import { log }                              from '../log.js';
import {
    getAnchor, saveAnchor, purgeChatStore,
    getLbVecMap, invalidateVecCache,
} from './chat-store.js';

const _empty = () => ({ chunks: [], vecChunks: { content: {}, header: {} }, lbEntries: [], vecLb: { content: {} }, plotHistory: {} });

// ── Insert ────────────────────────────────────────────────────────────────────

export async function insertLorebookEntries(chatKey, anchorUuid, lorebookName, entries) {
    if (!entries.length) return { inserted: 0 };

    const anchor   = await getAnchor(chatKey, anchorUuid) ?? _empty();
    const vecMap   = await getLbVecMap(chatKey, anchorUuid);
    const seenHashes = new Set(anchor.lbEntries.filter(e => vecMap.has(e.hash)).map(e => e.hash));
    const toInsert   = entries.filter(e => !seenHashes.has(getStringHash(e.content)));
    if (!toInsert.length) return { inserted: 0 };

    const cfg        = embedCfg();
    const totalChars = toInsert.reduce((s, e) => s + e.content.length, 0);
    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: 0 });

    const vecs = await embedBatch(toInsert.map(e => e.content), cfg, false);

    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: toInsert.length });
    reportEmbedUsage(totalChars, cfg.model);

    for (const [i, e] of toInsert.entries()) {
        const hash = getStringHash(e.content);
        anchor.lbEntries.push({ hash, anchorUuid, lorebookName, entryUid: e.uid, entryKeys: e.keys ?? [], content: e.content });
        anchor.vecLb.content[hash] = encodeVec(vecs[i]);
    }

    invalidateVecCache(chatKey, anchorUuid);
    await saveAnchor(chatKey, anchorUuid, anchor);
    log('FileStoreLb', `insertLorebookEntries: +${toInsert.length} for anchor ${anchorUuid.slice(0, 8)}`);
    return { inserted: toInsert.length };
}

// ── Query ─────────────────────────────────────────────────────────────────────

export async function queryLorebookEntries(chatKey, validAnchorUuids, queryText, signal, lorebookName = null) {
    if (!queryText?.trim() || !validAnchorUuids.length) return [];

    const cfg = embedCfg();
    const [queryVec] = await embedBatch([queryText], cfg, true, signal);

    const allEntries = [];
    const vecMap     = new Map();

    for (const uuid of validAnchorUuids) {
        const anchor = await getAnchor(chatKey, uuid);
        if (!anchor) continue;
        const filtered = lorebookName
            ? anchor.lbEntries.filter(e => e.lorebookName === lorebookName)
            : anchor.lbEntries;
        allEntries.push(...filtered);
        const maps = await getLbVecMap(chatKey, uuid);
        for (const [h, v] of maps) vecMap.set(h, v);
    }

    if (!allEntries.length) return [];
    const hashMap = new Map(allEntries.map(e => [e.hash, e]));

    const rows = [];
    for (const [hash, vec] of vecMap) {
        const meta = hashMap.get(hash);
        if (!meta) continue;
        rows.push({ ...meta, score: dot(queryVec, vec) });
    }
    rows.sort((a, b) => b.score - a.score);
    return rows;
}

// ── Plot filler ───────────────────────────────────────────────────────────────

export async function queryRecentPlotEntries(chatKey, lorebookName, validAnchorUuids, semanticUids = [], recencyCount = 3, signal, minArcs = 0, fillerEnabled = false, fillerCards = 1, fillerStrategy = 'random', currentTurn = 0) {
    if (!lorebookName || !validAnchorUuids.length) return [];

    const pool = [];
    for (const uuid of validAnchorUuids) {
        const anchor = await getAnchor(chatKey, uuid);
        if (!anchor) continue;
        pool.push(...anchor.lbEntries.filter(e => e.lorebookName === lorebookName));
    }

    const getTagsForUids = uids => {
        const rows = pool.filter(e => uids.includes(e.entryUid));
        return [...new Set(rows.flatMap(e => (e.content.match(/#\w+/g) ?? [])))];
    };
    const recentByTag = (tag, count) =>
        pool.filter(e => e.content.includes(tag))
            .sort((a, b) => b.entryUid - a.entryUid)
            .slice(0, count).map(e => e.entryUid);

    const seen   = new Set(semanticUids.map(Number));
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

            // Plot history lives on the head anchor (last valid UUID)
            const headUuid = validAnchorUuids.at(-1);
            const headAnchor = headUuid ? (await getAnchor(chatKey, headUuid) ?? _empty()) : _empty();

            if (fillerStrategy === 'oldest_arc') {
                candidates.sort((a, b) => a[1] - b[1]);
            } else if (fillerStrategy === 'oldest_surfaced') {
                candidates.sort((a, b) => {
                    const aT = headAnchor.plotHistory[`${lorebookName}/${a[0]}`]?.lastSurfacedTurn ?? 0;
                    const bT = headAnchor.plotHistory[`${lorebookName}/${b[0]}`]?.lastSurfacedTurn ?? 0;
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

            if (fills.length && headUuid) {
                for (const tag of fills)
                    headAnchor.plotHistory[`${lorebookName}/${tag}`] = { lastSurfacedTurn: currentTurn };
                await saveAnchor(chatKey, headUuid, headAnchor);
            }
        }
    }
    return result;
}

// ── Purge ─────────────────────────────────────────────────────────────────────

export async function purgeAnchorLbEntries(chatKey, anchorUuid) {
    const anchor = await getAnchor(chatKey, anchorUuid);
    if (!anchor) return;
    anchor.lbEntries  = [];
    anchor.vecLb      = { content: {} };
    anchor.plotHistory = {};
    invalidateVecCache(chatKey, anchorUuid);
    await saveAnchor(chatKey, anchorUuid, anchor);
}

export async function purgeChatLbEntries(chatKey) {
    await purgeChatStore(chatKey);
}
