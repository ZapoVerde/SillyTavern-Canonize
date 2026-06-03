/**
 * @file data/default-user/extensions/canonize/rag/cosine.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Pure — cosine similarity math and embedding serialisation
 * @description
 * All vector arithmetic for the file-based RAG store. No external reads or
 * writes. Owns the Base64↔Float32Array encoding used for compact JSON storage,
 * and the linear-scan search functions that replace SQL vector queries.
 *
 * At typical CNZ data volumes (a few hundred to ~1 000 chunks per character)
 * a linear scan over in-memory vectors costs 2–8 ms — imperceptible beside
 * the embedding API round-trip that gates every operation.
 *
 * @api-declaration
 * encodeEmbedding(float32Array)                        → string  (Base64)
 * decodeEmbedding(base64)                              → Float32Array
 * cosineSimilarity(a, b)                               → number  [0, 1]
 * linearScan(chunks, queryVec, validUuids, topK)       → ScoredChunk[]
 * linearScanHeader(chunks, queryVec, validUuids, topK) → ScoredChunk[]
 * linearScanLb(entries, queryVec, validUuids, topK)    → ScoredLbEntry[]
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

// ── Encoding ──────────────────────────────────────────────────────────────────

/**
 * Encodes a Float32Array as a Base64 string for compact JSON storage.
 * A 768-dim vector → ~1 025 base64 chars vs ~7 500 JSON float chars.
 * @param {Float32Array} arr
 * @returns {string}
 */
export function encodeEmbedding(arr) {
    const bytes  = new Uint8Array(arr.buffer);
    const chunks = [];
    for (let i = 0; i < bytes.length; i += 0x8000)
        chunks.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
    return btoa(chunks.join(''));
}

/**
 * Decodes a Base64 string back to a Float32Array.
 * @param {string} b64
 * @returns {Float32Array}
 */
export function decodeEmbedding(b64) {
    const bin  = atob(b64);
    const buf  = new ArrayBuffer(bin.length);
    const view = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
    return new Float32Array(buf);
}

// ── Cosine math ───────────────────────────────────────────────────────────────

/**
 * Cosine similarity between two equal-length float arrays or Float32Arrays.
 * Returns a value in [0, 1] (embeddings are typically non-negative after
 * normalisation, but clamped to 0 for safety).
 * @param {number[]|Float32Array} a
 * @param {number[]|Float32Array} b
 * @returns {number}
 */
export function cosineSimilarity(a, b) {
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot  += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : Math.max(0, dot / denom);
}

// ── Linear scan helpers ───────────────────────────────────────────────────────

function _inScope(record, validUuids) {
    return validUuids.includes(record.anchorUuid);
}

/**
 * Scans all chunks in memory, scores by content-embedding cosine similarity,
 * and returns the top-K results for anchors in validUuids.
 * Result shape mirrors the plugin's /query-chunks response.
 * @param {object[]} chunks
 * @param {number[]|Float32Array} queryVec
 * @param {string[]} validUuids
 * @param {number} topK
 * @returns {{ content:string, header:string|null, turnRange:string|null,
 *             pairStart:number, pairEnd:number, chatFile:string|null,
 *             anchorUuid:string, score:number }[]}
 */
export function linearScan(chunks, queryVec, validUuids, topK) {
    const scored = [];
    for (const c of chunks) {
        if (!_inScope(c, validUuids) || !c.embedding) continue;
        const vec   = typeof c.embedding === 'string' ? decodeEmbedding(c.embedding) : c.embedding;
        const score = cosineSimilarity(queryVec, vec);
        scored.push({ content: c.content, header: c.header ?? null, turnRange: c.turnRange ?? null,
                      pairStart: c.pairStart, pairEnd: c.pairEnd, chatFile: c.chatFile ?? null,
                      anchorUuid: c.anchorUuid, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

/**
 * Same as linearScan but scores by header-embedding. Skips chunks without
 * a header embedding. Used as the "header" lane in the RRF merge.
 * @param {object[]} chunks
 * @param {number[]|Float32Array} queryVec
 * @param {string[]} validUuids
 * @param {number} topK
 * @returns {object[]}
 */
export function linearScanHeader(chunks, queryVec, validUuids, topK) {
    const scored = [];
    for (const c of chunks) {
        if (!_inScope(c, validUuids) || !c.headerEmbedding) continue;
        const vec   = typeof c.headerEmbedding === 'string' ? decodeEmbedding(c.headerEmbedding) : c.headerEmbedding;
        const score = cosineSimilarity(queryVec, vec);
        scored.push({ content: c.content, header: c.header ?? null, turnRange: c.turnRange ?? null,
                      pairStart: c.pairStart, pairEnd: c.pairEnd, chatFile: c.chatFile ?? null,
                      anchorUuid: c.anchorUuid, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}

/**
 * Scans lorebook entries by content-embedding cosine similarity.
 * Result shape mirrors the plugin's /query-lorebook response.
 * @param {object[]} entries
 * @param {number[]|Float32Array} queryVec
 * @param {string[]} validUuids
 * @param {number} topK
 * @param {string|null} [lorebookNameFilter]
 * @returns {{ lorebookName:string, entryUid:number, anchorUuid:string, score:number }[]}
 */
export function linearScanLb(entries, queryVec, validUuids, topK, lorebookNameFilter = null) {
    const scored = [];
    for (const e of entries) {
        if (!_inScope(e, validUuids) || !e.embedding) continue;
        if (lorebookNameFilter && e.lorebookName !== lorebookNameFilter) continue;
        const vec   = typeof e.embedding === 'string' ? decodeEmbedding(e.embedding) : e.embedding;
        const score = cosineSimilarity(queryVec, vec);
        scored.push({ lorebookName: e.lorebookName, entryUid: e.entryUid,
                      anchorUuid: e.anchorUuid, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
}
