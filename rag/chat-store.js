/**
 * @file data/default-user/extensions/canonize/rag/chat-store.js
 * @stamp {"utc":"2026-06-04T03:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper — per-chat RAG store (chunks, vecs, lb entries, plot history)
 * @description
 * Owns the single JSON file per chat that holds all RAG artifacts keyed by anchor UUID.
 *
 * Write order (three tiers):
 *   1. DNA chain — written first by the sync pipeline; the canonical record.
 *   2. In-memory cache — updated synchronously on every mutation; the live working store.
 *   3. JSON file — written asynchronously via a debounced flush; enables fast cold-start
 *      restore. Any burst of mutations (reconcile, sync) produces exactly one disk write.
 *
 * If the JSON file is missing or stale the healer rebuilds it from the DNA chain.
 * This makes deferred disk writes safe: the chain is always the authority.
 *
 * File layout per chat:
 *   cnz_store_{chatKey}.json — { version, anchors: { [uuid]: AnchorData } }
 *
 * AnchorData shape:
 *   { chunks, vecChunks: { content, header }, lbEntries, vecLb: { content }, plotHistory }
 *
 * @api-declaration
 * getAnchor(chatKey, uuid)                        → Promise<AnchorData|null>
 * saveAnchor(chatKey, uuid, data)                 → void   (cache-immediate, disk-async)
 * deleteAnchor(chatKey, uuid)                     → Promise<void>
 * listAnchorUuids(chatKey)                        → Promise<string[]>
 * loadChatStore(chatKey)                          → Promise<StoreObj>  (mutable ref)
 * flushChatStore(chatKey, store)                  → void   (cache-immediate, disk-async)
 * purgeChatStore(chatKey)                         → Promise<void>      (disk-immediate)
 * getChunkVecMaps(chatKey, uuid)                  → Promise<{content:Map, header:Map}>
 * getLbVecMap(chatKey, uuid)                      → Promise<Map>
 * invalidateVecCache(chatKey, uuid)               → void
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [storeCache, chunkVecCache, lbVecCache, _flushTimers]
 *     external_io:     [GET /user/files/cnz_store_*.json, POST /api/files/upload]
 */

import { readFile, writeFile } from './file-io.js';
import { decodeVec, encodeVec } from './vec-math.js';
import { log, error } from '../log.js';

// ── In-memory caches ──────────────────────────────────────────────────────────

// chatKey → { version, anchors: { [uuid]: AnchorData } }
const storeCache = new Map();

// `${chatKey}:${uuid}` → { content: Map<number,Float32Array>, header: Map<number,Float32Array> }
const chunkVecCache = new Map();

// `${chatKey}:${uuid}` → Map<number,Float32Array>
const lbVecCache = new Map();

// ── Debounced flush ───────────────────────────────────────────────────────────

const _flushTimers = new Map(); // chatKey → timer id
const FLUSH_DELAY_MS = 600;

function _scheduleFlush(chatKey) {
    clearTimeout(_flushTimers.get(chatKey));
    _flushTimers.set(chatKey, setTimeout(() => {
        _flushTimers.delete(chatKey);
        const store = storeCache.get(chatKey);
        if (store) writeFile(`cnz_store_${chatKey}.json`, store)
            .catch(err => error('ChatStore', `flush failed for ${chatKey}:`, err));
    }, FLUSH_DELAY_MS));
}

// Best-effort flush of all pending writes before page unload.
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        for (const [chatKey, timer] of _flushTimers) {
            clearTimeout(timer);
            _flushTimers.delete(chatKey);
            const store = storeCache.get(chatKey);
            if (store) writeFile(`cnz_store_${chatKey}.json`, store).catch(() => {});
        }
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const _vcKey = (ck, uuid) => `${ck}:${uuid}`;

// ── Store load ────────────────────────────────────────────────────────────────

async function _loadStore(chatKey) {
    if (storeCache.has(chatKey)) return storeCache.get(chatKey);
    const data = await readFile(`cnz_store_${chatKey}.json`) ?? { version: 1, anchors: {} };
    storeCache.set(chatKey, data);
    return data;
}

// ── Anchor CRUD ───────────────────────────────────────────────────────────────

export async function getAnchor(chatKey, uuid) {
    const store = await _loadStore(chatKey);
    return store.anchors[uuid] ?? null;
}

export async function saveAnchor(chatKey, uuid, data) {
    const store = await _loadStore(chatKey);
    store.anchors[uuid] = data;
    _scheduleFlush(chatKey);
    log('ChatStore', `saveAnchor: ${uuid.slice(0, 8)} in ${chatKey}`);
}

export async function deleteAnchor(chatKey, uuid) {
    const store = await _loadStore(chatKey);
    if (!(uuid in store.anchors)) return;
    delete store.anchors[uuid];
    invalidateVecCache(chatKey, uuid);
    _scheduleFlush(chatKey);
    log('ChatStore', `deleteAnchor: ${uuid.slice(0, 8)} from ${chatKey}`);
}

export async function listAnchorUuids(chatKey) {
    const store = await _loadStore(chatKey);
    return Object.keys(store.anchors);
}

// ── Batch access (for orchestrators that need to mutate many anchors at once) ──

export async function loadChatStore(chatKey) {
    return _loadStore(chatKey);
}

export function flushChatStore(chatKey, store) {
    storeCache.set(chatKey, store);
    _scheduleFlush(chatKey);
}

// ── Purge (disk-immediate — must clear promptly on user request) ──────────────

export async function purgeChatStore(chatKey) {
    clearTimeout(_flushTimers.get(chatKey));
    _flushTimers.delete(chatKey);
    storeCache.delete(chatKey);
    for (const k of [...chunkVecCache.keys()]) if (k.startsWith(`${chatKey}:`)) chunkVecCache.delete(k);
    for (const k of [...lbVecCache.keys()])    if (k.startsWith(`${chatKey}:`)) lbVecCache.delete(k);
    await writeFile(`cnz_store_${chatKey}.json`, { version: 1, anchors: {} });
    log('ChatStore', `purgeChatStore: ${chatKey}`);
}

// ── Decoded vec caches ────────────────────────────────────────────────────────

export function invalidateVecCache(chatKey, uuid) {
    chunkVecCache.delete(_vcKey(chatKey, uuid));
    lbVecCache.delete(_vcKey(chatKey, uuid));
}

export async function getChunkVecMaps(chatKey, uuid) {
    const k = _vcKey(chatKey, uuid);
    if (chunkVecCache.has(k)) return chunkVecCache.get(k);
    const anchor = await getAnchor(chatKey, uuid);
    const raw    = anchor?.vecChunks ?? { content: {}, header: {} };
    const maps   = {
        content: new Map(Object.entries(raw.content ?? {}).map(([h, b]) => [Number(h), decodeVec(b)])),
        header:  new Map(Object.entries(raw.header  ?? {}).map(([h, b]) => [Number(h), decodeVec(b)])),
    };
    chunkVecCache.set(k, maps);
    return maps;
}

export async function getLbVecMap(chatKey, uuid) {
    const k = _vcKey(chatKey, uuid);
    if (lbVecCache.has(k)) return lbVecCache.get(k);
    const anchor = await getAnchor(chatKey, uuid);
    const raw    = anchor?.vecLb?.content ?? {};
    const map    = new Map(Object.entries(raw).map(([h, b]) => [Number(h), decodeVec(b)]));
    lbVecCache.set(k, map);
    return map;
}

export function encodeVecEntry(vec) { return encodeVec(vec); }
