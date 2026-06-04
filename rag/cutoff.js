/**
 * @file data/default-user/extensions/canonize/rag/cutoff.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role Pure — distributional cutoff for RAG channel results
 * @description
 * Single implementation of the three-step distributional cutoff shared by all
 * RAG channels (chat chunks, LB entries, plot LB entries).
 *
 * Step 1 — Signal strength test: (max - min) / max. If below threshold,
 *           return the min-count slice — no distribution to trust.
 * Step 2 — Mean cutoff: keep all candidates where score > μ.
 * Step 3 — Clamp result to [min, max].
 *
 * Expects candidates sorted descending by score. Does not mutate input.
 *
 * @api-declaration
 * distributionalCutoff(candidates, { min, max, signalStrength }) → object[]
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

/**
 * @param {object[]} candidates   Sorted descending by score; each has { score }
 * @param {object}   opts
 * @param {number}   opts.min           Minimum results to return
 * @param {number}   opts.max           Maximum results to return
 * @param {number}   opts.signalStrength Normalised range threshold (0–1)
 * @returns {object[]}
 */
export function distributionalCutoff(candidates, { min = 2, max = 8, signalStrength = 0.35 }) {
    if (!candidates.length) return [];

    const sorted   = [...candidates].sort((a, b) => b.score - a.score);
    const maxScore = sorted[0].score;
    const minScore = sorted.at(-1).score;

    // Step 1 — signal strength test
    const strength = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;
    if (strength < signalStrength) {
        return sorted.slice(0, Math.min(min, sorted.length));
    }

    // Step 2 — mean cutoff
    const mean      = sorted.reduce((s, c) => s + c.score, 0) / sorted.length;
    const aboveMean = sorted.filter(c => c.score > mean);

    // Step 3 — clamp to [min, max]
    const floored = aboveMean.length < min ? sorted.slice(0, Math.min(min, sorted.length)) : aboveMean;
    return floored.slice(0, max);
}
