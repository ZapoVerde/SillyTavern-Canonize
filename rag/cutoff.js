/**
 * @file data/default-user/extensions/canonize/rag/cutoff.js
 * @stamp {"utc":"2026-06-07T00:00:00.000Z"}
 * @architectural-role Pure — dynamic RAG cutoff via micro-pool mean threshold
 * @description
 * Applies a mean threshold to a localised candidate pool rather than the full
 * database, eliminating the scale-smothering effect of global statistics.
 *
 * Pool size = max(poolMultiple × max, 6). The threshold (mean, mean+1σ, or
 * mean+2σ) is computed from pool scores only. Pearson skewness is calculated
 * and returned as display-only telemetry — it does not affect the cutoff.
 *
 * @api-declaration
 * distributionalCutoff(candidates, { min, max, poolMultiple, cutoffMode })
 *   → { results: object[], metadata: CutoffMeta|null }
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: [none]
 *     external_io:     [none]
 */

/**
 * @typedef {{
 *   database_total_items: number,
 *   candidate_pool_size:  number,
 *   local_mean:           number,
 *   local_median:         number,
 *   local_std_dev:        number,
 *   pearson_skewness:     number,
 *   threshold:            number,
 *   cutoff_mode:          string,
 *   final_returned_count: number,
 * }} CutoffMeta
 */

/**
 * @param {object[]} candidates    Sorted descending by score; each has { score }
 * @param {object}   opts
 * @param {number}   opts.min          Minimum results to return
 * @param {number}   opts.max          Maximum results to return
 * @param {number}   opts.poolMultiple Pool size = max(poolMultiple × max, 6)
 * @param {string}   opts.cutoffMode   'mean' | 'mean+1sd' | 'mean+2sd'
 * @returns {{ results: object[], metadata: CutoffMeta|null }}
 */
export function distributionalCutoff(candidates, { min = 2, max = 8, poolMultiple = 2, cutoffMode = 'mean' }) {
    if (!candidates.length) return { results: [], metadata: null };

    const sorted  = [...candidates].sort((a, b) => b.score - a.score);
    const V_total = sorted.length;

    // Cold-start bypass: too few items to analyse, return everything.
    if (V_total <= min) return { results: sorted, metadata: null };

    // ── Build candidate pool ───────────────────────────────────────────────────

    const N_C  = Math.max(Math.round(poolMultiple * max), 6);
    const pool = sorted.slice(0, N_C);

    // ── Pool statistics ────────────────────────────────────────────────────────

    const mu = pool.reduce((s, c) => s + c.score, 0) / pool.length;

    const pScores = pool.map(c => c.score).sort((a, b) => a - b);
    const mid     = Math.floor(pool.length / 2);
    const median  = pool.length % 2 === 0
        ? (pScores[mid - 1] + pScores[mid]) / 2
        : pScores[mid];

    const sigma = Math.max(
        Math.sqrt(pool.reduce((s, c) => s + (c.score - mu) ** 2, 0) / pool.length),
        0.01,
    );

    // Pearson skewness — display only, does not drive the cutoff.
    const skewness = 3 * (mu - median) / sigma;

    // ── Threshold cutoff ───────────────────────────────────────────────────────

    let threshold = mu;
    if (cutoffMode === 'mean+1sd') threshold = mu + sigma;
    if (cutoffMode === 'mean+2sd') threshold = mu + 2 * sigma;

    const aboveThreshold = pool.filter(c => c.score > threshold);

    // Nothing clears the threshold: fall back to the min floor.
    const floored = aboveThreshold.length < min
        ? sorted.slice(0, Math.min(min, sorted.length))
        : aboveThreshold;

    const results = floored.slice(0, max);

    return {
        results,
        metadata: {
            database_total_items: V_total,
            candidate_pool_size:  N_C,
            local_mean:           mu,
            local_median:         median,
            local_std_dev:        sigma,
            pearson_skewness:     skewness,
            threshold,
            cutoff_mode:          cutoffMode,
            final_returned_count: results.length,
        },
    };
}
