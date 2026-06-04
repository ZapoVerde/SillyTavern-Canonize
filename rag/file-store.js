/**
 * @file data/default-user/extensions/canonize/rag/file-store.js
 * @stamp {"utc":"2026-06-04T02:00:00.000Z"}
 * @version 3.0.0
 * @architectural-role IO Wrapper — chunk metadata and vector operations
 * @description
 * Chunk insert, query, and purge operations against the per-chat RAG store.
 * All data lives in cnz_store_{chatKey}.json via chat-store.js — one file per ST
 * chat, keyed internally by anchor UUID. No separate vector file; vectors are stored
 * inline in the anchor data and decoded to Float32Arrays via the vec cache in
 * chat-store.js. FTS index is built at query time from the unioned valid-anchor chunks;
 * it is not serialized to disk.
 *
 * @api-declaration
 * insertSyncChunks(chatKey, anchorUuid, chatFile, chunks, pairOffset) → Promise<{inserted}>
 * querySyncChunks(chatKey, validAnchorUuids, queryText, signal)       → Promise<Result[]>
 * purgeAnchorChunks(chatKey, anchorUuid)                              → Promise<void>
 * purgeChatChunks(chatKey)                                            → Promise<void>
 * anchorChunkCount(chatKey, anchorUuid)                               → Promise<object>
 * anchorStats(chatKey, anchorUuid)                                    → Promise<object>
 * warmCache(chatKey)                                                  → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none — chat-store.js owns the cache]
 *     external_io:     [chat-store.js, embed-direct.js, fts.js, rrf.js]
 */

import { getStringHash }    from '../../../../utils.js';
import { embedCfg, reportEmbedUsage } from './embed-client.js';
import { embedBatch }       from './embed-direct.js';
import { buildFtsIndex, queryFts } from './fts.js';
import { rrf }              from './rrf.js';
import { dot, encodeVec }   from './vec-math.js';
import { emit, BUS_EVENTS } from '../bus.js';
import { log, error }       from '../log.js';
import {
    getAnchor, saveAnchor, deleteAnchor, listAnchorUuids, purgeChatStore,
    getChunkVecMaps, invalidateVecCache,
} from './chat-store.js';

// ── Insert ────────────────────────────────────────────────────────────────────

export async function insertSyncChunks(chatKey, anchorUuid, chatFile, chunks, pairOffset) {
    const settled = chunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length) return { inserted: 0 };

    const anchor   = await getAnchor(chatKey, anchorUuid) ?? { chunks: [], vecChunks: { content: {}, header: {} }, lbEntries: [], vecLb: { content: {} }, plotHistory: {} };
    const vecMaps  = await getChunkVecMaps(chatKey, anchorUuid);
    const seenHashes = new Set(anchor.chunks.filter(c => vecMaps.content.has(c.hash)).map(c => c.hash));
    const toInsert   = settled.filter(c => !seenHashes.has(getStringHash(c.content)));
    if (!toInsert.length) return { inserted: 0 };

    const cfg       = embedCfg();
    const totalChars = toInsert.reduce((s, c) => s + c.content.length, 0);
    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: 0 });

    const contentVecs = await embedBatch(toInsert.map(c => c.content), cfg, false);

    const headerIdxMap = new Map();
    const headerTexts  = [];
    for (let i = 0; i < toInsert.length; i++) {
        if (toInsert[i].header) { headerIdxMap.set(i, headerTexts.length); headerTexts.push(toInsert[i].header); }
    }
    const headerVecs = headerTexts.length ? await embedBatch(headerTexts, cfg, false) : [];

    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: toInsert.length });
    reportEmbedUsage(totalChars, cfg.model);

    for (const [i, c] of toInsert.entries()) {
        const hash = getStringHash(c.content);
        anchor.chunks.push({
            hash, anchorUuid, chatFile: chatFile ?? null,
            pairStart: pairOffset + c.pairStart, pairEnd: pairOffset + c.pairEnd,
            header: c.header ?? null, turnRange: c.turnRange ?? null, content: c.content,
        });
        anchor.vecChunks.content[hash] = encodeVec(contentVecs[i]);
        if (headerIdxMap.has(i)) anchor.vecChunks.header[hash] = encodeVec(headerVecs[headerIdxMap.get(i)]);
    }

    invalidateVecCache(chatKey, anchorUuid);
    await saveAnchor(chatKey, anchorUuid, anchor);
    log('FileStore', `insertSyncChunks: +${toInsert.length} for anchor ${anchorUuid.slice(0, 8)}`);
    return { inserted: toInsert.length };
}

// ── Query ─────────────────────────────────────────────────────────────────────

export async function querySyncChunks(chatKey, validAnchorUuids, queryText, signal) {
    if (!queryText?.trim() || !validAnchorUuids.length) return [];

    const cfg = embedCfg();
    const [queryVec] = await embedBatch([queryText], cfg, true, signal);

    const allChunks  = [];
    const vecContent = new Map();
    const vecHeader  = new Map();

    for (const uuid of validAnchorUuids) {
        const anchor = await getAnchor(chatKey, uuid);
        if (!anchor) continue;
        allChunks.push(...anchor.chunks);
        const maps = await getChunkVecMaps(chatKey, uuid);
        for (const [h, v] of maps.content) vecContent.set(h, v);
        for (const [h, v] of maps.header)  vecHeader.set(h, v);
    }

    if (!allChunks.length) return [];
    const hashMap = new Map(allChunks.map(c => [c.hash, c]));

    const contentRows = [];
    for (const [hash, vec] of vecContent) {
        const meta = hashMap.get(hash);
        if (!meta) continue;
        contentRows.push({ ...meta, score: dot(queryVec, vec) });
    }
    contentRows.sort((a, b) => b.score - a.score);

    const headerRows = [];
    for (const [hash, vec] of vecHeader) {
        const meta = hashMap.get(hash);
        if (!meta) continue;
        headerRows.push({ ...meta, score: dot(queryVec, vec) });
    }
    headerRows.sort((a, b) => b.score - a.score);

    const ftsIdx = buildFtsIndex(allChunks);
    const kwRows = queryFts(ftsIdx, allChunks, queryText, validAnchorUuids, 100_000);

    return rrf({ content: contentRows, header: headerRows, keyword: kwRows })
        .map(r => ({
            text: r.content, header: r.header, turnRange: r.turnRange,
            pairStart: r.pairStart, pairEnd: r.pairEnd, score: Number(r.score),
            chatFile: r.chatFile ?? null, anchorUuid: r.anchorUuid,
            sources: r.sources?.length ? r.sources : ['vec'],
        }));
}

// ── Purge ─────────────────────────────────────────────────────────────────────

export async function purgeAnchorChunks(chatKey, anchorUuid) {
    const anchor = await getAnchor(chatKey, anchorUuid);
    if (!anchor) return;
    anchor.chunks     = [];
    anchor.vecChunks  = { content: {}, header: {} };
    invalidateVecCache(chatKey, anchorUuid);
    await saveAnchor(chatKey, anchorUuid, anchor);
}

export async function purgeChatChunks(chatKey) {
    await purgeChatStore(chatKey);
}

// ── Stats ─────────────────────────────────────────────────────────────────────

export async function anchorChunkCount(chatKey, anchorUuid) {
    const anchor = anchorUuid ? await getAnchor(chatKey, anchorUuid) : null;
    return {
        chunksForAnchor:    anchor?.chunks?.length ?? 0,
        lbEntriesForAnchor: anchor?.lbEntries?.length ?? 0,
        lbHashesForAnchor:  anchor?.lbEntries?.map(e => e.hash) ?? [],
    };
}

export async function anchorStats(chatKey, anchorUuid) {
    const anchor = await getAnchor(chatKey, anchorUuid);
    return {
        chunksForAnchor:    anchor?.chunks?.length ?? 0,
        lbEntriesForAnchor: anchor?.lbEntries?.length ?? 0,
        lbHashesForAnchor:  anchor?.lbEntries?.map(e => e.hash) ?? [],
    };
}

// ── Cache warm ────────────────────────────────────────────────────────────────

export async function warmCache(chatKey) {
    await listAnchorUuids(chatKey); // triggers _loadStore → cache
    log('FileStore', `warmCache: store loaded for ${chatKey}`);
}

// ── Re-exports for backward compat ────────────────────────────────────────────

export { listAnchorUuids, deleteAnchor } from './chat-store.js';
