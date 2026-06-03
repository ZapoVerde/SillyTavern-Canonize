/**
 * @file data/default-user/extensions/canonize/rag/file-store.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — chunk metadata file IO, Vectra-backed semantic search
 * @description
 * Owns chunk metadata JSON files and all chunk-level RAG operations.
 * Embedding and semantic search are delegated to ST's /api/vector/* endpoints
 * via embed-client.js. The JSON files store only metadata (no embedding vectors).
 * Lorebook and plot operations live in file-store-lb.js.
 *
 * Vectra collections per character:
 *   cnz_chunks_{avatarKey}  — chunk content embeddings
 *   cnz_headers_{avatarKey} — chunk header embeddings (header lane of RRF)
 *
 * JSON file per character:
 *   cnz_chunks_{avatarKey}.json — [{hash, anchorUuid, chatFile, pairStart,
 *                                    pairEnd, header, turnRange, content}]
 *                                 plus serialised FTS index
 *
 * @api-declaration
 * readFile(name)              → Promise<object|null>
 * writeFile(name, obj)        → Promise<void>
 * getChunks(avatarKey)        → Promise<ChunkStore>
 * setChunks(avatarKey, store) → Promise<void>
 * insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset)
 * querySyncChunks(avatarKey, validAnchorUuids, queryText, topK, signal)
 * purgeAnchorChunks(anchorUuid)
 * purgeCharacterChunks(avatarKey)
 * anchorChunkCount(avatarKey, anchorUuid)
 * anchorStats(anchorUuid)
 * warmCache(avatarKey)
 * chunkCache  — Map, exported for file-store-lb.js
 * lbCache     — Map, exported for file-store-lb.js
 * plotCache   — Map, exported for file-store-lb.js
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [chunkCache, lbCache, plotCache]
 *     external_io:     [GET /user/files/cnz_chunks_*.json, POST /api/files/upload,
 *                       embed-client.js (/api/vector/*), fts.js, rrf.js]
 */

import { getRequestHeaders }  from '../../../../../script.js';
import { getStringHash }      from '../../../../utils.js';
import { embedCfg, insertItems, queryItems, deleteItems,
         purgeCollection, reportEmbedUsage } from './embed-client.js';
import { buildFtsIndex, addChunkToIndex, queryFts,
         serialiseFtsIndex, deserialiseFtsIndex } from './fts.js';
import { rrf }  from './rrf.js';
import { emit, BUS_EVENTS } from '../bus.js';
import { log }  from '../log.js';

// ── Shared caches (exported for file-store-lb.js) ─────────────────────────────

export const chunkCache = new Map();
export const lbCache    = new Map();
export const plotCache  = new Map();

// ── File IO ───────────────────────────────────────────────────────────────────

function _encode(obj) {
    const bytes = new TextEncoder().encode(JSON.stringify(obj));
    const parts = [];
    for (let i = 0; i < bytes.length; i += 0x8000)
        parts.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    return btoa(parts.join(''));
}

export async function readFile(name) {
    const res = await fetch(`/user/files/${name}`, { headers: getRequestHeaders() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`CNZ file-store read ${name}: ${res.statusText}`);
    return res.json();
}

export async function writeFile(name, obj) {
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name, data: _encode(obj) }),
    });
    if (!res.ok) throw new Error(`CNZ file-store write ${name}: ${res.statusText}`);
}

// ── Chunk cache ───────────────────────────────────────────────────────────────

export async function getChunks(avatarKey) {
    if (chunkCache.has(avatarKey)) return chunkCache.get(avatarKey);
    const data = await readFile(`cnz_chunks_${avatarKey}.json`) ?? { version: 2, chunks: [], ftsIndex: null };
    chunkCache.set(avatarKey, data);
    return data;
}

export async function setChunks(avatarKey, data) {
    chunkCache.set(avatarKey, data);
    await writeFile(`cnz_chunks_${avatarKey}.json`, data);
}

function _getFtsIndex(data) {
    if (data._ftsIndex) return data._ftsIndex;
    const idx = data.ftsIndex ? deserialiseFtsIndex(data.ftsIndex) : buildFtsIndex(data.chunks);
    data._ftsIndex = idx;
    return idx;
}

// ── Collection names ──────────────────────────────────────────────────────────

const _colChunks  = ak => `cnz_chunks_${ak}`;
const _colHeaders = ak => `cnz_headers_${ak}`;

// ── Chunk operations ──────────────────────────────────────────────────────────

export async function insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset) {
    const settled = chunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length) return { inserted: 0 };

    const data        = await getChunks(avatarKey);
    const seenHashes  = new Set(data.chunks.map(c => c.hash));
    const toInsert    = settled.filter(c => !seenHashes.has(getStringHash(c.content)));
    if (!toInsert.length) return { inserted: 0 };

    const cfg         = embedCfg();
    const ftsIdx      = _getFtsIndex(data);

    const contentItems = toInsert.map((c, i) => ({
        hash:  getStringHash(c.content),
        text:  c.content,
        index: pairOffset + c.pairStart,
    }));
    const headerItems = toInsert
        .filter(c => c.header)
        .map(c => ({ hash: getStringHash(c.content), text: c.header, index: pairOffset + c.pairStart }));

    const totalChars = toInsert.reduce((s, c) => s + c.content.length, 0);
    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: 0 });

    await insertItems(_colChunks(avatarKey), contentItems, cfg);
    if (headerItems.length) await insertItems(_colHeaders(avatarKey), headerItems, cfg);

    emit(BUS_EVENTS.EMBED_PROGRESS, { total: toInsert.length, done: toInsert.length });
    reportEmbedUsage(totalChars, cfg.model);

    for (const c of toInsert) {
        const record = {
            hash:       getStringHash(c.content),
            anchorUuid,
            chatFile:   chatFile ?? null,
            pairStart:  pairOffset + c.pairStart,
            pairEnd:    pairOffset + c.pairEnd,
            header:     c.header ?? null,
            turnRange:  c.turnRange ?? null,
            content:    c.content,
        };
        addChunkToIndex(ftsIdx, record, data.chunks.length);
        data.chunks.push(record);
    }

    data.ftsIndex  = serialiseFtsIndex(ftsIdx);
    data._ftsIndex = ftsIdx;
    await setChunks(avatarKey, data);
    log('FileStore', `insertSyncChunks: +${toInsert.length} for anchor ${anchorUuid.slice(0, 8)}`);
    return { inserted: toInsert.length };
}

export async function querySyncChunks(avatarKey, validAnchorUuids, queryText, topK = 5, signal) {
    if (!queryText?.trim() || !validAnchorUuids.length) return [];

    const data    = await getChunks(avatarKey);
    const hashMap = new Map(data.chunks.map(c => [c.hash, c]));
    const cfg     = embedCfg();
    const pool    = topK * 2;

    const toRow = (m) => {
        const meta = hashMap.get(Number(m.hash));
        if (!meta || !validAnchorUuids.includes(meta.anchorUuid)) return null;
        return { content: meta.content, header: meta.header ?? null, turnRange: meta.turnRange ?? null,
                 pairStart: meta.pairStart, pairEnd: meta.pairEnd,
                 chatFile: meta.chatFile ?? null, anchorUuid: meta.anchorUuid, score: 1 };
    };

    const [contentResult, headerResult] = await Promise.all([
        queryItems(_colChunks(avatarKey),  queryText, pool, cfg, signal),
        queryItems(_colHeaders(avatarKey), queryText, pool, cfg, signal),
    ]);

    const contentRows = (contentResult?.metadata ?? []).map(toRow).filter(Boolean);
    const headerRows  = (headerResult?.metadata  ?? []).map(m => {
        const meta = hashMap.get(Number(m.hash));
        if (!meta || !validAnchorUuids.includes(meta.anchorUuid)) return null;
        return { content: meta.content, header: m.text, turnRange: meta.turnRange ?? null,
                 pairStart: meta.pairStart, pairEnd: meta.pairEnd,
                 chatFile: meta.chatFile ?? null, anchorUuid: meta.anchorUuid, score: 1 };
    }).filter(Boolean);

    const ftsIdx  = _getFtsIndex(data);
    const kwRows  = queryFts(ftsIdx, data.chunks, queryText, validAnchorUuids, pool);

    return rrf({ content: contentRows, header: headerRows, keyword: kwRows }, topK)
        .map(r => ({
            text: r.content, header: r.header, turnRange: r.turnRange,
            pairStart: r.pairStart, pairEnd: r.pairEnd, score: Number(r.score),
            chatFile: r.chatFile ?? null, anchorUuid: r.anchorUuid,
            sources: r.sources?.length ? r.sources : ['vec'],
        }));
}

export async function purgeAnchorChunks(anchorUuid) {
    for (const [ak, data] of chunkCache) {
        const toDelete = data.chunks.filter(c => c.anchorUuid === anchorUuid);
        if (!toDelete.length) continue;
        const hashes   = toDelete.map(c => c.hash);
        const cfg      = embedCfg();
        await deleteItems(_colChunks(ak),  hashes, cfg);
        await deleteItems(_colHeaders(ak), hashes, cfg);
        data.chunks    = data.chunks.filter(c => c.anchorUuid !== anchorUuid);
        const idx      = buildFtsIndex(data.chunks);
        data.ftsIndex  = serialiseFtsIndex(idx);
        data._ftsIndex = idx;
        await setChunks(ak, data);
    }
    const { purgeAnchorLbEntries } = await import('./file-store-lb.js');
    await purgeAnchorLbEntries(anchorUuid);
}

export async function purgeCharacterChunks(avatarKey) {
    await purgeCollection(_colChunks(avatarKey));
    await purgeCollection(_colHeaders(avatarKey));
    chunkCache.delete(avatarKey);
    await writeFile(`cnz_chunks_${avatarKey}.json`, { version: 2, chunks: [], ftsIndex: null });
}

export async function anchorChunkCount(avatarKey, anchorUuid) {
    const result = {};
    if (avatarKey) {
        const cd = await getChunks(avatarKey);
        const { getLb } = await import('./file-store-lb.js');
        const ld = await getLb(avatarKey);
        result.chunksForCharacter    = cd.chunks.length;
        result.lbEntriesForCharacter = ld.entries.length;
    }
    if (anchorUuid) {
        const allChunks  = [...chunkCache.values()].flatMap(d => d.chunks);
        const allEntries = [...lbCache.values()].flatMap(d => d.entries);
        result.chunksForAnchor    = allChunks.filter(c => c.anchorUuid === anchorUuid).length;
        result.lbEntriesForAnchor = allEntries.filter(e => e.anchorUuid === anchorUuid).length;
    }
    return result;
}

export async function anchorStats(anchorUuid) {
    const allChunks  = [...chunkCache.values()].flatMap(d => d.chunks);
    const allEntries = [...lbCache.values()].flatMap(d => d.entries);
    return {
        chunksForAnchor:    allChunks.filter(c => c.anchorUuid === anchorUuid).length,
        lbEntriesForAnchor: allEntries.filter(e => e.anchorUuid === anchorUuid).length,
        lbHashesForAnchor:  allEntries.filter(e => e.anchorUuid === anchorUuid).map(e => e.hash),
    };
}

export async function warmCache(avatarKey) {
    const { getLb } = await import('./file-store-lb.js');
    await Promise.all([getChunks(avatarKey), getLb(avatarKey)]);
}
