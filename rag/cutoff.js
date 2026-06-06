/**
 * @file data/default-user/extensions/canonize/rag/cutoff.js
 * @stamp {"utc":"2026-06-06T00:00:00.000Z"}
 * @architectural-role Pure — distributional cutoff for RAG channel results
 * @description
 * Single implementation of the two-step distributional cutoff shared by all
 * RAG channels (chat chunks, LB entries, plot LB entries).
 *
 * Step 1 — Threshold cutoff: keep candidates above μ, μ+σ, or μ+2σ depending
 *           on cutoffMode ('mean' | 'mean+1sd' | 'mean+2sd').
 * Step 2 — Clamp result to [min, max]. If nothing passes the threshold, the
 *           floor ensures at least min results are returned.
 *
 * Expects candidates sorted descending by score. Does not mutate input.
 *
 * @api-declaration
 * distributionalCutoff(candidates, { min, max, cutoffMode }) → object[]
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
 * @param {string}   opts.cutoffMode    'mean' | 'mean+1sd' | 'mean+2sd'
 * @returns {object[]}
 */
export function distributionalCutoff(candidates, { min = 2, max = 8, cutoffMode = 'mean' }) {
    if (!candidates.length) return [];

    const sorted = [...candidates].sort((a, b) => b.score - a.score);

    // Step 1 — threshold cutoff
    const mean = sorted.reduce((s, c) => s + c.score, 0) / sorted.length;
    let threshold = mean;
    if (cutoffMode === 'mean+1sd' || cutoffMode === 'mean+2sd') {
        const stdev    = Math.sqrt(sorted.reduce((s, c) => s + (c.score - mean) ** 2, 0) / sorted.length);
        const sdFactor = cutoffMode === 'mean+2sd' ? 2 : 1;
        threshold      = mean + sdFactor * stdev;
    }
    const aboveThreshold = sorted.filter(c => c.score > threshold);

    // Step 2 — clamp to [min, max]; floor ensures min results when nothing passes the threshold
    const floored = aboveThreshold.length < min ? sorted.slice(0, Math.min(min, sorted.length)) : aboveThreshold;
    return floored.slice(0, max);
}
