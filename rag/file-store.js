/**
 * @file data/default-user/extensions/canonize/rag/file-store.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — JSON file IO, chunk operations, shared cache helpers
 * @description
 * Owns the ST file API calls, the in-memory cache maps, and all chunk-level
 * RAG operations. Lorebook and plot operations live in file-store-lb.js, which
 * accesses shared state through the exported cache accessors below.
 *
 * Files per character:
 *   cnz_chunks_{avatarKey}.json — RAG chunks with Base64-encoded embeddings + FTS index
 *   cnz_lb_{avatarKey}.json     — lorebook entries (owned by file-store-lb.js)
 *   cnz_plot_{avatarKey}.json   — plot filler history (owned by file-store-lb.js)
 *
 * @api-declaration
 * readFile(name)                     → Promise<object|null>
 * writeFile(name, obj)               → Promise<void>
 * getChunks(avatarKey)               → Promise<object>
 * setChunks(avatarKey, data)         → Promise<void>
 * insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset)
 * querySyncChunks(validAnchorUuids, queryText, topK, signal)
 * purgeAnchorChunks(anchorUuid)
 * purgeCharacterChunks(avatarKey)
 * anchorChunkCount(avatarKey, anchorUuid)
 * anchorStats(anchorUuid)
 * warmCache(avatarKey)
 * chunkCache                         (Map — read-only for file-store-lb.js)
 * lbCache                            (Map — owned by file-store-lb.js)
 * plotCache                          (Map — owned by file-store-lb.js)
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [chunkCache, lbCache, plotCache]
 *     external_io:     [GET /user/files/cnz_chunks_*.json, POST /api/files/upload,
 *                       embed-client.js, cosine.js, fts.js, rrf.js]
 */

import { getRequestHeaders }  from '../../../../../script.js';
import { getStringHash }      from '../../../../utils.js';
import { embedCfg, embedText, embedBatch } from './embed-client.js';
import { encodeEmbedding, linearScan, linearScanHeader } from './cosine.js';
import { buildFtsIndex, addChunkToIndex, queryFts,
         serialiseFtsIndex, deserialiseFtsIndex } from './fts.js';
import { rrf }  from './rrf.js';
import { log }  from '../log.js';

// ── Shared cache maps (exported for file-store-lb.js) ────────────────────────

export const chunkCache = new Map();
export const lbCache    = new Map();
export const plotCache  = new Map();

// ── File IO ───────────────────────────────────────────────────────────────────

function _encode(obj) {
    const bytes  = new TextEncoder().encode(JSON.stringify(obj));
    const parts  = [];
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

// ── Chunk cache helpers ───────────────────────────────────────────────────────

export async function getChunks(avatarKey) {
    if (chunkCache.has(avatarKey)) return chunkCache.get(avatarKey);
    const data = await readFile(`cnz_chunks_${avatarKey}.json`) ?? { version: 1, chunks: [], ftsIndex: null };
    chunkCache.set(avatarKey, data);
    return data;
}

export async function setChunks(avatarKey, data) {
    chunkCache.set(avatarKey, data);
    await writeFile(`cnz_chunks_${avatarKey}.json`, data);
}

function _getOrBuildFtsIndex(data) {
    if (data._ftsIndex) return data._ftsIndex;
    const idx = data.ftsIndex ? deserialiseFtsIndex(data.ftsIndex) : buildFtsIndex(data.chunks);
    data._ftsIndex = idx;
    return idx;
}

// ── Chunk operations ──────────────────────────────────────────────────────────

export async function insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset) {
    const settled = chunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length) return { inserted: 0 };

    const cfg  = embedCfg();
    const data = await getChunks(avatarKey);
    const existingHashes = new Set(data.chunks.filter(c => c.anchorUuid === anchorUuid).map(c => c.hash));
    const toEmbed = settled.filter(c => !existingHashes.has(getStringHash(c.content)));
    if (!toEmbed.length) return { inserted: 0 };

    const headerItems = toEmbed.filter(c => c.header);
    const [contentEmbs, headerEmbs] = await Promise.all([
        embedBatch(cfg, toEmbed.map(c => c.content)),
        headerItems.length ? embedBatch(cfg, headerItems.map(c => c.header)) : Promise.resolve([]),
    ]);

    const ftsIdx     = _getOrBuildFtsIndex(data);
    let   headerIdx  = 0;
    const headerMap  = new Map(headerItems.map((c, i) => [c.content, i]));

    for (let i = 0; i < toEmbed.length; i++) {
        const c = toEmbed[i];
        const hIdx = c.header ? headerMap.get(c.content) ?? headerIdx++ : -1;
        const record = {
            hash: getStringHash(c.content), anchorUuid, chatFile: chatFile ?? null,
            pairStart: pairOffset + c.pairStart, pairEnd: pairOffset + c.pairEnd,
            header: c.header ?? null, turnRange: c.turnRange ?? null, content: c.content,
            embedding:       encodeEmbedding(new Float32Array(contentEmbs[i])),
            headerEmbedding: c.header ? encodeEmbedding(new Float32Array(headerEmbs[hIdx])) : null,
        };
        addChunkToIndex(ftsIdx, record, data.chunks.length);
        data.chunks.push(record);
    }

    data.ftsIndex = serialiseFtsIndex(ftsIdx);
    data._ftsIndex = ftsIdx;
    await setChunks(avatarKey, data);
    log('FileStore', `insertSyncChunks: +${toEmbed.length} for anchor ${anchorUuid.slice(0, 8)}`);
    return { inserted: toEmbed.length };
}

export async function querySyncChunks(validAnchorUuids, queryText, topK = 5, signal) {
    if (!queryText?.trim() || !validAnchorUuids.length) return [];

    const allChunks = [...chunkCache.values()].flatMap(d => d.chunks);
    const cfg       = embedCfg();
    const queryVec  = new Float32Array(await embedText(cfg, queryText, signal));
    const pool      = topK * 2;

    const contentRows = linearScan(allChunks, queryVec, validAnchorUuids, pool);
    const headerRows  = linearScanHeader(allChunks, queryVec, validAnchorUuids, pool);

    let kwRows = [];
    for (const data of chunkCache.values()) {
        const idx = _getOrBuildFtsIndex(data);
        kwRows.push(...queryFts(idx, data.chunks, queryText, validAnchorUuids, pool));
    }
    kwRows.sort((a, b) => b.score - a.score);
    kwRows = kwRows.slice(0, pool);

    return rrf({ content: contentRows, header: headerRows, keyword: kwRows }, topK)
        .map(r => ({
            text: r.content, header: r.header, turnRange: r.turnRange,
            pairStart: r.pairStart, pairEnd: r.pairEnd, score: Number(r.score),
            chatFile: r.chatFile ?? null, anchorUuid: r.anchorUuid, sources: ['vec'],
        }));
}

export async function purgeAnchorChunks(anchorUuid) {
    for (const [ak, data] of chunkCache) {
        const before = data.chunks.length;
        data.chunks  = data.chunks.filter(c => c.anchorUuid !== anchorUuid);
        if (data.chunks.length !== before) {
            const idx = buildFtsIndex(data.chunks);
            data.ftsIndex = serialiseFtsIndex(idx);
            data._ftsIndex = idx;
            await setChunks(ak, data);
        }
    }
    const { purgeAnchorLbEntries } = await import('./file-store-lb.js');
    await purgeAnchorLbEntries(anchorUuid);
}

export async function purgeCharacterChunks(avatarKey) {
    chunkCache.delete(avatarKey);
    await writeFile(`cnz_chunks_${avatarKey}.json`, { version: 1, chunks: [], ftsIndex: null });
}

export async function anchorChunkCount(avatarKey, anchorUuid) {
    const result = {};
    if (avatarKey) {
        const cd = await getChunks(avatarKey);
        const ld = lbCache.get(avatarKey) ?? await (async () => {
            const { getLb } = await import('./file-store-lb.js');
            return getLb(avatarKey);
        })();
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
