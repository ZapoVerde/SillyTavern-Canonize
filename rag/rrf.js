/**
 * @file data/default-user/extensions/canonize/rag/rrf.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role Pure — multi-lane chunk fusion
 * @description
 * Merges content-embedding, header-embedding, and keyword result lists into a
 * single ranked list. Input rows from vector lanes carry real cosine scores
 * (Float32Array dot products computed in file-store.js). The fused output score
 * is the best cosine seen across lanes for each item — this is the value the
 * distributional cutoff in rag-fetch.js operates on.
 *
 * Keyword-only items (no vector match) receive KEYWORD_SCORE (0.3), ranking them
 * below semantic hits so the mean cutoff naturally filters them when a strong
 * semantic signal exists.
 *
 * Deduplication key is row.content (unique within an anchor scope).
 *
 * @api-declaration
 * rrf({ content, header, keyword }) → Row[]   merged list, score = best cosine
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

// Items that only appeared in keyword search get this fixed score.
// Below typical cosine scores so mean cutoff filters them when semantic signal is strong.
const KEYWORD_SCORE = 0.3;

// Multiplier applied when a chunk appears in both content AND header vector lanes.
// Two independent representations agreeing strengthens the relevance signal.
const DUAL_BONUS = 1.08;

/**
 * @param {{ content: Row[], header: Row[], keyword: Row[] }} lists
 *   content/header rows must carry a real cosine score in row.score.
 *   keyword rows' score field is not used.
 * @returns {Row[]}  Rows with score = best cosine, boosted 8% for dual-lane hits.
 */
export function rrf({ content: contentRows, header: headerRows, keyword: kwRows }) {
    // content text → { bestScore, inContent, inHeader, sources: Set, row }
    const acc = new Map();

    for (const row of contentRows) {
        const key = row.content;
        if (!acc.has(key)) acc.set(key, { bestScore: 0, inContent: false, inHeader: false, sources: new Set(), row });
        const e = acc.get(key);
        e.bestScore  = Math.max(e.bestScore, row.score);
        e.inContent  = true;
        e.sources.add('content');
    }

    for (const row of headerRows) {
        const key = row.content;
        if (!acc.has(key)) acc.set(key, { bestScore: 0, inContent: false, inHeader: false, sources: new Set(), row });
        const e = acc.get(key);
        e.bestScore = Math.max(e.bestScore, row.score);
        e.inHeader  = true;
        e.sources.add('header');
    }

    for (const row of kwRows) {
        const key = row.content;
        if (!acc.has(key)) {
            // Keyword-only: no cosine available, use deflated constant.
            acc.set(key, { bestScore: KEYWORD_SCORE, inContent: false, inHeader: false, sources: new Set(['keyword']), row });
        } else {
            // Already found by vector search — just mark the lane, don't lower the score.
            acc.get(key).sources.add('keyword');
        }
    }

    return [...acc.values()]
        .sort((a, b) => b.bestScore - a.bestScore)
        .map(e => {
            const boosted = (e.inContent && e.inHeader)
                ? Math.min(1, e.bestScore * DUAL_BONUS)
                : e.bestScore;
            return { ...e.row, score: boosted, sources: [...e.sources] };
        });
}
