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
 * Keyword-only items (no vector match) get score=0 here; the caller applies a
 * normalised keyword blend so they rank on actual TF-IDF strength rather than
 * an arbitrary constant.
 *
 * Each result carries laneScores.{content,header} (real cosines) and kwTfidf
 * (raw TF-IDF score, null if no keyword match) so the caller can blend them.
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

// Multiplier applied when a chunk appears in both content AND header vector lanes.
// Two independent representations agreeing strengthens the relevance signal.
const DUAL_BONUS = 1.08;

/**
 * @param {{ content: Row[], header: Row[], keyword: Row[] }} lists
 *   content/header rows must carry a real cosine score in row.score.
 *   keyword rows carry a TF-IDF score in row.score (preserved as kwTfidf).
 * @returns {Row[]}  Rows with score = best cosine (or 0 for keyword-only),
 *                   laneScores.{content,header}, and kwTfidf for caller blending.
 */
export function rrf({ content: contentRows, header: headerRows, keyword: kwRows }) {
    const acc = new Map();

    for (const row of contentRows) {
        const key = row.content;
        if (!acc.has(key)) acc.set(key, { bestScore: 0, contentScore: 0, headerScore: 0, kwTfidf: null, inContent: false, inHeader: false, sources: new Set(), row });
        const e = acc.get(key);
        e.bestScore    = Math.max(e.bestScore, row.score);
        e.contentScore = Math.max(e.contentScore, row.score);
        e.inContent    = true;
        e.sources.add('content');
    }

    for (const row of headerRows) {
        const key = row.content;
        if (!acc.has(key)) acc.set(key, { bestScore: 0, contentScore: 0, headerScore: 0, kwTfidf: null, inContent: false, inHeader: false, sources: new Set(), row });
        const e = acc.get(key);
        e.bestScore   = Math.max(e.bestScore, row.score);
        e.headerScore = Math.max(e.headerScore, row.score);
        e.inHeader    = true;
        e.sources.add('header');
    }

    for (const row of kwRows) {
        const key = row.content;
        if (!acc.has(key)) {
            // Keyword-only: no cosine score. Caller will assign score via blend.
            acc.set(key, { bestScore: 0, contentScore: 0, headerScore: 0, kwTfidf: row.score, inContent: false, inHeader: false, sources: new Set(['keyword']), row });
        } else {
            const e = acc.get(key);
            e.kwTfidf = row.score;
            e.sources.add('keyword');
        }
    }

    return [...acc.values()]
        .sort((a, b) => b.bestScore - a.bestScore)
        .map(e => {
            const boosted = (e.inContent && e.inHeader)
                ? Math.min(1, e.bestScore * DUAL_BONUS)
                : e.bestScore;
            return {
                ...e.row, score: boosted, sources: [...e.sources],
                laneScores: {
                    content: e.inContent ? e.contentScore : null,
                    header:  e.inHeader  ? e.headerScore  : null,
                },
                kwTfidf: e.kwTfidf,
            };
        });
}
