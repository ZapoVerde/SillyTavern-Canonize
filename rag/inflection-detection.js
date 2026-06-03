/**
 * @file data/default-user/extensions/canonize/rag/inflection-detection.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Pure Functions — two-signal adaptive inflection detection for RAG result filtering
 * @description
 * Replaces the static noiseFloor gate with an adaptive boundary that finds where
 * genuine relevant memories end and noise begins. Uses two orthogonal signals:
 * Signal A (gap-based: score distribution discontinuities) and Signal C (diversity-
 * based: retrieval path agreement). Either signal triggering declares the boundary.
 * Hard constraints (minimum count, score floor, result ceiling) are applied after.
 *
 * Receives candidates already sorted by decayed score descending. Does not mutate
 * input. Returns filtered results and metadata for caller logging.
 *
 * @api-declaration
 * findInflectionPoint(candidates, settings, { log }) → { filtered: object[], metadata: object }
 *
 * @contract
 *   assertions:
 *     purity:          pure (log is injected — no direct I/O imports)
 *     state_ownership: [none]
 *     external_io:     [none]
 */

const TAG              = 'Inflect';
const GAP_MULTIPLIER   = 2.0;   // gap must exceed this × mean to trigger Signal A
const GAP_MIN_MEAN     = 0.015; // below this mean gap, distribution has no useful variation
const DIVERSITY_FLOOR  = 2;     // minimum paths for a result to count as high-confidence
const MIN_GUARANTEE    = 3;     // always return at least this many results

/**
 * Finds the adaptive inflection boundary in a sorted, decayed candidate list.
 *
 * @param {object[]} candidates  Sorted descending by score; each has { text, score, sources[] }
 * @param {object}   settings    CNZ settings snapshot
 * @param {{ log: Function }} io  Injected logger (tag-prefixed like log('Inflect', msg))
 * @returns {{ filtered: object[], metadata: object }}
 */
export function findInflectionPoint(candidates, settings, { log: _log }) {
    const minScore   = settings.ragInflectionMinScore          ?? 0.15;
    const maxResults = settings.ragInflectionMaxResults        ?? 7;
    const verbose    = settings.ragInflectionVerbose           ?? false;

    const log = (msg) => _log(TAG, msg);

    // ── Entry summary ────────────────────────────────────────────────────────

    log(`=== inflection start: ${candidates.length} candidates | minScore=${minScore} maxResults=${maxResults} minGuarantee=${MIN_GUARANTEE} ===`);

    if (candidates.length === 0) {
        log('no candidates — returning empty');
        return { filtered: [], metadata: _meta(null, null, null, 'empty', 0, 0, 0, 0, 0) };
    }

    const scores     = candidates.map(c => c.score);
    const pathCounts = candidates.map(c => (c.sources ?? []).length);

    log(`scores:     [${scores.map(s => s.toFixed(4)).join(', ')}]`);
    log(`path-count: [${pathCounts.join(', ')}]`);
    log(`sources:    [${candidates.map(c => (c.sources ?? []).join('+')).join(', ')}]`);

    // ── Signal A: Gap-based detection ────────────────────────────────────────

    let gapBoundary = null;

    if (candidates.length < 3) {
        log(`signal-A (gap): SKIP — fewer than 3 candidates (${candidates.length})`);
    } else {
        const gaps = [];
        for (let i = 0; i < scores.length - 1; i++) gaps.push(scores[i] - scores[i + 1]);

        const meanGap      = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        const gapThreshold = meanGap * GAP_MULTIPLIER;

        log(`signal-A (gap): gaps=[${gaps.map(g => g.toFixed(4)).join(', ')}]`);
        log(`signal-A (gap): mean=${meanGap.toFixed(4)} threshold=${gapThreshold.toFixed(4)} (${GAP_MULTIPLIER}× mean)`);

        if (meanGap < GAP_MIN_MEAN) {
            log(`signal-A (gap): NO — mean gap ${meanGap.toFixed(4)} < ${GAP_MIN_MEAN} (distribution has no meaningful variation)`);
        } else {
            for (let i = 0; i < gaps.length; i++) {
                if (gaps[i] > gapThreshold) {
                    gapBoundary = i + 1; // keep 0..i, discard i+1..
                    log(`signal-A (gap): YES at position ${gapBoundary} — gap[${i}]=${gaps[i].toFixed(4)} > threshold ${gapThreshold.toFixed(4)}`);
                    break;
                }
            }
            if (gapBoundary === null) {
                log(`signal-A (gap): NO — no gap exceeds ${GAP_MULTIPLIER}× mean (threshold=${gapThreshold.toFixed(4)})`);
            }
        }
    }

    // ── Signal C: Path diversity detection ───────────────────────────────────

    let diversityBoundary = null;

    if (candidates.length < 2) {
        log(`signal-C (diversity): SKIP — fewer than 2 candidates (${candidates.length})`);
    } else if (pathCounts.every(p => p <= 1)) {
        log(`signal-C (diversity): NO — all results are single-path; cannot distinguish quality boundary`);
    } else if (pathCounts.every(p => p >= DIVERSITY_FLOOR)) {
        log(`signal-C (diversity): NO — all results have ${DIVERSITY_FLOOR}+ paths throughout; no boundary`);
    } else {
        for (let i = 0; i < pathCounts.length; i++) {
            if (pathCounts[i] < DIVERSITY_FLOOR) {
                diversityBoundary = i; // keep 0..i-1, discard i..
                log(`signal-C (diversity): YES at position ${diversityBoundary} — first single-path result (paths=${pathCounts[i]}, sources=[${(candidates[i].sources ?? []).join('+')}])`);
                break;
            }
        }
    }

    // ── Consensus: OR logic ───────────────────────────────────────────────────

    let inflectionBoundary;
    let boundaryReason;

    if (gapBoundary !== null && diversityBoundary !== null) {
        inflectionBoundary = Math.min(gapBoundary, diversityBoundary);
        boundaryReason     = `both signals fired — gap@${gapBoundary} diversity@${diversityBoundary} → taking earlier (${inflectionBoundary})`;
    } else if (gapBoundary !== null) {
        inflectionBoundary = gapBoundary;
        boundaryReason     = `gap signal only — position ${gapBoundary}`;
    } else if (diversityBoundary !== null) {
        inflectionBoundary = diversityBoundary;
        boundaryReason     = `diversity signal only — position ${diversityBoundary}`;
    } else {
        inflectionBoundary = candidates.length;
        boundaryReason     = 'no signal triggered — keeping all candidates (ceiling will limit)';
    }

    if (inflectionBoundary === 0) {
        log(`WARNING: boundary landed at position 0 — possible RRF misconfiguration; minimum guarantee will recover`);
    }

    log(`consensus boundary: position ${inflectionBoundary} — ${boundaryReason}`);

    // ── Verbose per-position breakdown ────────────────────────────────────────

    if (verbose) {
        log('--- per-position breakdown ---');
        for (let i = 0; i < candidates.length; i++) {
            const kept      = i < inflectionBoundary ? 'KEEP' : 'CUT ';
            const gapToNext = i < scores.length - 1
                ? (scores[i] - scores[i + 1]).toFixed(4)
                : '------';
            log(`  [${String(i).padStart(2)}] ${kept} score=${scores[i].toFixed(4)} gap_next=${gapToNext} paths=${pathCounts[i]} sources=[${(candidates[i].sources ?? []).join('+')}]`);
        }
        log('--- end per-position ---');
    }

    // ── Safety bound 1: inflection slice ─────────────────────────────────────

    const afterInflection = candidates.slice(0, inflectionBoundary);
    log(`after inflection: ${afterInflection.length}`);

    // ── Safety bound 2: absolute score floor ─────────────────────────────────

    const aboveFloor    = afterInflection.filter(c => c.score >= minScore);
    const floorRejects  = afterInflection.length - aboveFloor.length;
    if (floorRejects > 0) {
        const rejected = afterInflection.filter(c => c.score < minScore);
        log(`floor (min ${minScore}): removed ${floorRejects} — scores=[${rejected.map(c => c.score.toFixed(4)).join(', ')}]`);
    } else {
        log(`floor (min ${minScore}): all ${afterInflection.length} pass`);
    }

    // ── Safety bound 3: absolute result ceiling ───────────────────────────────

    const afterCeiling = aboveFloor.slice(0, maxResults);
    if (aboveFloor.length > maxResults) {
        log(`ceiling (max ${maxResults}): trimmed ${aboveFloor.length - maxResults} — keeping top ${maxResults}`);
    } else {
        log(`ceiling (max ${maxResults}): ${afterCeiling.length} results (under ceiling)`);
    }

    // ── Safety bound 4: minimum result guarantee ──────────────────────────────

    let finalResults = afterCeiling;

    if (finalResults.length < MIN_GUARANTEE) {
        const alreadyIn   = new Set(finalResults.map(c => c.text));
        const pool        = candidates.filter(c => !alreadyIn.has(c.text));
        const needed      = Math.min(MIN_GUARANTEE - finalResults.length, pool.length);

        if (needed > 0) {
            const reAdmitted = pool.slice(0, needed);
            log(`minimum guarantee (${MIN_GUARANTEE}): re-admitting ${needed} result(s) — had ${finalResults.length}`);
            for (const r of reAdmitted) {
                const why = r.score < minScore ? `score ${r.score.toFixed(4)} below floor` : `cut by inflection/ceiling`;
                log(`  re-admitted: score=${r.score.toFixed(4)} paths=${(r.sources ?? []).length} sources=[${(r.sources ?? []).join('+')}] — ${why}`);
            }
            finalResults = [...finalResults, ...reAdmitted].sort((a, b) => b.score - a.score);
        } else {
            log(`minimum guarantee (${MIN_GUARANTEE}): only ${candidates.length} candidates exist — returning all (${finalResults.length})`);
        }
    }

    // ── Final summary ─────────────────────────────────────────────────────────

    if (finalResults.length) {
        const hi         = finalResults[0].score.toFixed(4);
        const lo         = finalResults.at(-1).score.toFixed(4);
        const srcTotals  = { content: 0, header: 0, keyword: 0 };
        let   multiPath  = 0;
        for (const r of finalResults) {
            for (const s of (r.sources ?? [])) if (s in srcTotals) srcTotals[s]++;
            if ((r.sources ?? []).length >= 2) multiPath++;
        }
        log(`=== FINAL: ${finalResults.length} memories | scores ${lo}–${hi} | content=${srcTotals.content} header=${srcTotals.header} keyword=${srcTotals.keyword} | multi-path=${multiPath}/${finalResults.length} ===`);
    } else {
        log('=== FINAL: 0 memories (empty database or all candidates exhausted) ===');
    }

    return {
        filtered: finalResults,
        metadata: _meta(
            gapBoundary, diversityBoundary, inflectionBoundary, boundaryReason,
            candidates.length, afterInflection.length, aboveFloor.length,
            afterCeiling.length, finalResults.length,
        ),
    };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function _meta(gapBoundary, diversityBoundary, inflectionBoundary, boundaryReason,
               candidatesIn, afterInflection, afterFloor, afterCeiling, finalCount) {
    return { gapBoundary, diversityBoundary, inflectionBoundary, boundaryReason,
             candidatesIn, afterInflection, afterFloor, afterCeiling, finalCount };
}
