/**
 * @file data/default-user/extensions/canonize/rag/fts.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Pure — TF-IDF full-text search over RAG chunk records
 * @description
 * Builds and queries an in-memory inverted index over chunk content and header
 * fields. No external dependencies. The index is a plain JSON-serialisable
 * object stored alongside the chunk file and rebuilt incrementally on write.
 *
 * Scoring uses TF-IDF with field weighting (header terms score 3× content).
 * Tokenisation applies lowercase normalisation, a small English stop-word list,
 * and a simple suffix stemmer (removes -s, -ing, -ed, -er, -ly).
 *
 * @api-declaration
 * buildFtsIndex(chunks)                          → FtsIndex
 * addChunkToIndex(index, chunk, chunkIdx)        → void  (mutates index)
 * queryFts(index, chunks, queryText, validUuids, topK) → ScoredChunk[]
 * serialiseFtsIndex(index)                       → string  (JSON)
 * deserialiseFtsIndex(json)                      → FtsIndex
 *
 * @contract
 *   assertions:
 *     purity:          pure (buildFtsIndex, queryFts, serialise, deserialise)
 *                      mutates index only (addChunkToIndex)
 *     state_ownership: [none]
 *     external_io:     [none]
 */

// ── Tokenisation ──────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
    'a','an','the','and','or','but','in','on','at','to','for','of','with',
    'by','from','up','about','into','through','during','before','after',
    'is','was','are','were','be','been','being','have','has','had','do',
    'does','did','will','would','could','should','may','might','shall',
    'can','not','no','it','its','this','that','these','those','i','we',
    'you','he','she','they','them','their','our','your','my','his','her',
]);

const SUFFIX_RULES = [
    [/ing$/, ''], [/ings$/, ''], [/edly$/, ''], [/edly$/, ''],
    [/ed$/, ''],  [/er$/, ''],  [/ers$/, ''], [/ly$/, ''],
    [/s$/, ''],
];

function _stem(word) {
    if (word.length < 5) return word;
    for (const [pattern, replacement] of SUFFIX_RULES) {
        const stemmed = word.replace(pattern, replacement);
        if (stemmed.length >= 3 && stemmed !== word) return stemmed;
    }
    return word;
}

function _tokenise(text) {
    if (!text) return [];
    return text.toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter(t => t.length >= 2 && !STOP_WORDS.has(t))
        .map(_stem);
}

// ── Index structure ───────────────────────────────────────────────────────────
// {
//   termIndex: { stem → { chunkIdx → { contentTf, headerTf } } }
//   docCount:  number   (total indexed chunks)
//   df:        { stem → number }  (document frequency)
// }

/**
 * Builds a fresh FTS index from an array of chunk records.
 * @param {object[]} chunks
 * @returns {FtsIndex}
 */
export function buildFtsIndex(chunks) {
    const index = { termIndex: {}, docCount: 0, df: {} };
    for (let i = 0; i < chunks.length; i++) addChunkToIndex(index, chunks[i], i);
    return index;
}

/**
 * Adds a single chunk to an existing index. Mutates the index in place.
 * Call after appending a new chunk to the chunk array.
 * @param {object} index
 * @param {object} chunk
 * @param {number} chunkIdx
 */
export function addChunkToIndex(index, chunk, chunkIdx) {
    index.docCount++;
    const contentTerms = _tokenise(chunk.content ?? '');
    const headerTerms  = _tokenise(chunk.header  ?? '');

    const allStems = new Set([...contentTerms, ...headerTerms]);
    for (const stem of allStems) {
        index.df[stem] = (index.df[stem] ?? 0) + 1;
    }

    const contentFreq = {};
    for (const s of contentTerms) contentFreq[s] = (contentFreq[s] ?? 0) + 1;
    const headerFreq  = {};
    for (const s of headerTerms)  headerFreq[s]  = (headerFreq[s]  ?? 0) + 1;

    for (const stem of allStems) {
        if (!index.termIndex[stem]) index.termIndex[stem] = {};
        index.termIndex[stem][chunkIdx] = {
            contentTf: contentFreq[stem] ?? 0,
            headerTf:  headerFreq[stem]  ?? 0,
        };
    }
}

// ── Query ─────────────────────────────────────────────────────────────────────

const CONTENT_WEIGHT = 1;
const HEADER_WEIGHT  = 3;

/**
 * Queries the index and returns top-K chunks filtered to validUuids.
 * Result shape matches the `keyword` lane expected by rrf.js.
 * @param {object}   index
 * @param {object[]} chunks       — the same array used to build the index
 * @param {string}   queryText
 * @param {string[]} validUuids
 * @param {number}   topK
 * @returns {{ content:string, header:string|null, turnRange:string|null,
 *             pairStart:number, pairEnd:number, chatFile:string|null,
 *             anchorUuid:string, score:number }[]}
 */
export function queryFts(index, chunks, queryText, validUuids, topK) {
    if (!queryText?.trim() || !index.docCount) return [];
    const queryStems = _tokenise(queryText);
    if (!queryStems.length) return [];

    const N       = index.docCount;
    const scores  = {}; // chunkIdx → tfidf score

    for (const stem of queryStems) {
        const postings = index.termIndex[stem];
        if (!postings) continue;
        const df  = index.df[stem] ?? 1;
        const idf = Math.log((N + 1) / df);
        for (const [idxStr, { contentTf, headerTf }] of Object.entries(postings)) {
            const idx      = Number(idxStr);
            const chunk    = chunks[idx];
            if (!chunk || !validUuids.includes(chunk.anchorUuid)) continue;
            const tfScore  = contentTf * CONTENT_WEIGHT + headerTf * HEADER_WEIGHT;
            scores[idx]    = (scores[idx] ?? 0) + tfScore * idf;
        }
    }

    return Object.entries(scores)
        .sort((a, b) => b[1] - a[1])
        .slice(0, topK)
        .map(([idxStr, score]) => {
            const c = chunks[Number(idxStr)];
            return { content: c.content, header: c.header ?? null, turnRange: c.turnRange ?? null,
                     pairStart: c.pairStart, pairEnd: c.pairEnd, chatFile: c.chatFile ?? null,
                     anchorUuid: c.anchorUuid, score };
        });
}

// ── Serialisation ─────────────────────────────────────────────────────────────

/** @param {object} index @returns {string} */
export function serialiseFtsIndex(index) {
    return JSON.stringify(index);
}

/** @param {string} json @returns {object} */
export function deserialiseFtsIndex(json) {
    try { return JSON.parse(json); } catch { return { termIndex: {}, docCount: 0, df: {} }; }
}
