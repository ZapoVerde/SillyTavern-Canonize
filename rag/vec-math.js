/**
 * @file data/default-user/extensions/canonize/rag/vec-math.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role Pure — vector arithmetic and Float32Array serialisation
 * @description
 * Normalisation, dot product, cosine similarity, and base64 codec for Float32Arrays.
 * Used by embed-direct.js (at store time) and file-store.js / file-store-lb.js (at
 * query time). No IO, no state.
 *
 * @api-declaration
 * normalize(vec: Float32Array)         → Float32Array   unit-length copy
 * dot(a: Float32Array, b: Float32Array) → number        dot product (= cosine if both normalised)
 * cosine(a: Float32Array, b: Float32Array) → number     cosine similarity
 * encodeVec(vec: Float32Array)         → string         base64-encoded bytes
 * decodeVec(b64: string)               → Float32Array   decoded vector
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

/**
 * Returns a unit-length copy of vec. Returns a zero vector unchanged
 * (avoids NaN from dividing by zero).
 * @param {Float32Array} vec
 * @returns {Float32Array}
 */
export function normalize(vec) {
    let norm = 0;
    for (let i = 0; i < vec.length; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm);
    if (norm === 0) return new Float32Array(vec.length);
    const out = new Float32Array(vec.length);
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
    return out;
}

/**
 * Dot product of two equal-length arrays. Assumes both are pre-normalised
 * when used for cosine similarity.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function dot(a, b) {
    let sum = 0;
    for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
    return sum;
}

/**
 * Cosine similarity in [-1, 1]. Normalises both inputs before computing.
 * @param {Float32Array} a
 * @param {Float32Array} b
 * @returns {number}
 */
export function cosine(a, b) {
    return dot(normalize(a), normalize(b));
}

/**
 * Encodes a Float32Array to a base64 string for compact JSON storage.
 * @param {Float32Array} vec
 * @returns {string}
 */
export function encodeVec(vec) {
    const bytes = new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength);
    let str = '';
    for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
    return btoa(str);
}

/**
 * Decodes a base64 string produced by encodeVec back to a Float32Array.
 * @param {string} b64
 * @returns {Float32Array}
 */
export function decodeVec(b64) {
    const str  = atob(b64);
    const buf  = new Uint8Array(str.length);
    for (let i = 0; i < str.length; i++) buf[i] = str.charCodeAt(i);
    return new Float32Array(buf.buffer);
}
