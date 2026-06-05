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
 * Step 2 — Threshold cutoff: keep candidates above μ, μ+σ, or μ+2σ depending
 *           on cutoffMode ('mean' | 'mean+1sd' | 'mean+2sd').
 * Step 3 — Clamp result to [min, max].
 *
 * Expects candidates sorted descending by score. Does not mutate input.
 *
 * @api-declaration
 * distributionalCutoff(candidates, { min, max, signalStrength, cutoffMode }) → object[]
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
 * @param {string}   opts.cutoffMode    'mean' | 'mean+1sd' | 'mean+2sd'
 * @returns {object[]}
 */
export function distributionalCutoff(candidates, { min = 2, max = 8, signalStrength = 0.35, cutoffMode = 'mean' }) {
    if (!candidates.length) return [];

    const sorted   = [...candidates].sort((a, b) => b.score - a.score);
    const maxScore = sorted[0].score;
    const minScore = sorted.at(-1).score;

    // Step 1 — signal strength test
    const strength = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;
    if (strength < signalStrength) {
        return sorted.slice(0, Math.min(min, sorted.length));
    }

    // Step 2 — threshold cutoff
    const mean = sorted.reduce((s, c) => s + c.score, 0) / sorted.length;
    let threshold = mean;
    if (cutoffMode === 'mean+1sd' || cutoffMode === 'mean+2sd') {
        const stdev    = Math.sqrt(sorted.reduce((s, c) => s + (c.score - mean) ** 2, 0) / sorted.length);
        const sdFactor = cutoffMode === 'mean+2sd' ? 2 : 1;
        threshold      = mean + sdFactor * stdev;
    }
    const aboveThreshold = sorted.filter(c => c.score > threshold);

    // Step 3 — clamp to [min, max]
    const floored = aboveThreshold.length < min ? sorted.slice(0, Math.min(min, sorted.length)) : aboveThreshold;
    return floored.slice(0, max);
}
