/**
 * @file data/default-user/extensions/canonize/rag/rrf.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Pure — Reciprocal Rank Fusion over chunk result lists
 * @description
 * Merges content-embedding, header-embedding, and keyword result lists into a
 * single ranked list using Reciprocal Rank Fusion (k=60). Applies a dual-signal
 * bonus (+8%) when a chunk appears in both vector lists (content + header).
 * Scores are normalised to ≈[0,1] so they remain compatible with the client-side
 * noise floor and temporal-decay applied in generation-hook.js.
 *
 * @api-declaration
 * rrf({ content, header, keyword }, topK) → Row[]  merged + scored chunk rows
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

const K          = 60;
const DUAL_BONUS = 1.08;
const NUM_LISTS  = 3; // content + header + keyword
// Max possible raw RRF score (rank-1 in all lists, with bonus) — used for normalisation.
const MAX_RRF    = (NUM_LISTS / (K + 1)) * DUAL_BONUS; // ≈ 0.0531

/**
 * Merges three ranked chunk result lists using Reciprocal Rank Fusion.
 *
 * Deduplication key is `row.content` — matches the client-side dedup in
 * generation-hook.js and is sufficient because PG content values are unique
 * within any single anchor scope.
 *
 * @param {{ content: Row[], header: Row[], keyword: Row[] }} lists
 * @param {number} topK
 * @returns {Row[]}  Rows with `score` replaced by normalised RRF score.
 */
export function rrf({ content: contentRows, header: headerRows, keyword: kwRows }, topK) {
    const acc = new Map(); // content text → { rrfScore, inContent, inHeader, row }

    const add = (rows, listName) => {
        for (let i = 0; i < rows.length; i++) {
            const row = rows[i];
            const key = row.content;
            if (!acc.has(key)) acc.set(key, { rrfScore: 0, inContent: false, inHeader: false, row });
            const e   = acc.get(key);
            e.rrfScore += 1 / (K + i + 1);
            if (listName === 'content') e.inContent = true;
            if (listName === 'header')  e.inHeader  = true;
        }
    };

    add(contentRows, 'content');
    add(headerRows,  'header');
    add(kwRows,      'keyword');

    for (const e of acc.values()) {
        if (e.inContent && e.inHeader) e.rrfScore *= DUAL_BONUS;
    }

    return [...acc.values()]
        .sort((a, b) => b.rrfScore - a.rrfScore)
        .slice(0, topK)
        .map(e => ({ ...e.row, score: e.rrfScore / MAX_RRF }));
}
