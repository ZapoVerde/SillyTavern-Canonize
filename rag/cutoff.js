/**
 * @file data/default-user/extensions/canonize/rag/cutoff.js
 * @stamp {"utc":"2026-06-07T00:00:00.000Z"}
 * @architectural-role Pure — dynamic RAG cutoff via micro-pool shape analysis
 * @description
 * Two-pass localized shape analysis that scales the retrieval window based on
 * the statistical topology of the top-N candidates rather than a global
 * database average.
 *
 * Pass 1 — Pearson skewness of the candidate pool drives a scaling factor R
 *           applied to the user's Max ceiling, producing M_active.
 * Pass 2 — Cliff detection scans adjacent score drops within M_active and
 *           truncates earlier if a statistically anomalous break is found.
 *
 * A single pool multiple controls both passes. Higher values pull more tail
 * items into the pool, which stabilises μ_D for cliff calibration and
 * broadens the skewness sample.
 *
 * @api-declaration
 * distributionalCutoff(candidates, { min, max, k, poolMultiple }) → { results, metadata }
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
 *   sensitivity_k:        number,
 *   scaling_factor_R:     number,
 *   clamped_m_active:     number,
 *   cliff_detected:       boolean,
 *   cliff_index:          number|null,
 *   final_returned_count: number,
 * }} CutoffMeta
 */

/**
 * @param {object[]} candidates     Sorted descending by score; each has { score }
 * @param {object}   opts
 * @param {number}   opts.min           Minimum results to return
 * @param {number}   opts.max           Maximum results to return
 * @param {number}   opts.k             Sensitivity factor (strictness coefficient)
 * @param {number}   opts.poolMultiple  Candidate pool size = max(poolMultiple × max, 6)
 * @returns {{ results: object[], metadata: CutoffMeta|null }}
 */
export function distributionalCutoff(candidates, { min = 2, max = 8, k = 0.7, poolMultiple = 2 }) {
    if (!candidates.length) return { results: [], metadata: null };

    const sorted  = [...candidates].sort((a, b) => b.score - a.score);
    const V_total = sorted.length;

    // Cold-start bypass: too few items to shape-analyse, return everything.
    if (V_total <= min) return { results: sorted, metadata: null };

    // ── Build candidate pool ───────────────────────────────────────────────────

    const N_C = Math.max(Math.round(poolMultiple * max), 6);
    const C   = sorted.slice(0, N_C);

    // ── Pass 1: local skewness → scaling factor → M_active ────────────────────

    const mu_C = C.reduce((s, c) => s + c.score, 0) / C.length;

    const cScores = C.map(c => c.score).sort((a, b) => a - b);
    const mid     = Math.floor(C.length / 2);
    const median_C = C.length % 2 === 0
        ? (cScores[mid - 1] + cScores[mid]) / 2
        : cScores[mid];

    const sigma_C = Math.max(
        Math.sqrt(C.reduce((s, c) => s + (c.score - mu_C) ** 2, 0) / C.length),
        0.01,
    );

    const Sk = 3 * (mu_C - median_C) / sigma_C;
    const R  = Math.exp(-k * Sk);

    let M_active = Math.max(min, Math.min(Math.floor(max * R + 0.5), max));

    // ── Pass 2: cliff detection ────────────────────────────────────────────────

    // Compute adjacent drops across the full pool for μ_D calibration.
    const drops = [];
    for (let i = 0; i < C.length - 1; i++) drops.push(C[i].score - C[i + 1].score);
    const mu_D = drops.reduce((s, d) => s + d, 0) / drops.length;

    let cliff_detected = false;
    let cliff_index    = null;

    for (let i = 0; i < M_active - 1; i++) {
        if (drops[i] > 1.5 * mu_D && drops[i] > 0.015) {
            M_active       = i + 1;
            cliff_detected = true;
            cliff_index    = i;
            break;
        }
    }

    // ── Return ─────────────────────────────────────────────────────────────────

    const results  = sorted.slice(0, M_active);
    const metadata = {
        database_total_items: V_total,
        candidate_pool_size:  N_C,
        local_mean:           mu_C,
        local_median:         median_C,
        local_std_dev:        sigma_C,
        pearson_skewness:     Sk,
        sensitivity_k:        k,
        scaling_factor_R:     R,
        clamped_m_active:     M_active,
        cliff_detected,
        cliff_index,
        final_returned_count: results.length,
    };

    return { results, metadata };
}
