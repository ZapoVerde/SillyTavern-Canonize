/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch-log.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Console bar-chart logging and health telemetry rows for RAG channels.
 * Extracted from rag-fetch.js to stay within the 300-line budget.
 * Receives all closed-over context (chatKey, cfg, healthRows) as explicit
 * parameters so this module carries no state.
 *
 * @api-declaration
 * logChannel(name, raw, result, meta, kwMaxContrib, { chatKey, cfg, healthRows }) → void
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [console] }
 */

import { log, isVerbose } from '../log.js';

const LANE_COLORS = { content: '#4fc3f7', header: '#ffb74d', keyword: '#81c784' };
const EMPTY_STYLE = 'color:#3a3a3a';

function _barLine(score, sources, laneScores, kwContribution, isInjected, BAR_WIDTH, maxS) {
    const barLen   = maxS > 0 ? Math.round((score / maxS) * BAR_WIDTH) : 0;
    const trailing = BAR_WIDTH - barLen;
    const total    = Math.round(score * 1000);
    const kw       = Math.round(kwContribution * 1000);
    const vecTotal = total - kw;
    const cS       = laneScores?.content ?? 0;
    const hS       = laneScores?.header  ?? 0;
    const vecSum   = cS + hS;
    const c        = vecSum > 0 ? Math.round(vecTotal * cS / vecSum) : vecTotal;
    const h        = vecTotal - c;
    const scoreInt = (laneScores && (cS > 0 || hS > 0))
        ? `  ${c}+${h}+${kw}=${total}`
        : `  ${total}`;

    const lanes = (sources ?? []).filter(s => LANE_COLORS[s]);
    if (!lanes.length) {
        const bar = '█'.repeat(barLen) + '░'.repeat(trailing);
        return { format: `%c  ${bar}${scoreInt}`, styles: ['color:inherit'] };
    }

    const kwW     = (score > 0 && kwContribution > 0)
        ? Math.min(barLen, Math.round(barLen * kwContribution / score))
        : 0;
    const vectorW = barLen - kwW;

    let format  = '  ';
    const styles = [];

    const vectorLanes = lanes.filter(l => l !== 'keyword');
    if (vectorLanes.length === 1) {
        if (vectorW > 0) { format += `%c${'█'.repeat(vectorW)}`; styles.push(`color:${LANE_COLORS[vectorLanes[0]]}`); }
    } else if (vectorLanes.length >= 2) {
        const cS2   = laneScores?.content ?? 0;
        const hS2   = laneScores?.header  ?? 0;
        const tot   = cS2 + hS2;
        const cW    = tot > 0 ? Math.round(vectorW * cS2 / tot) : Math.floor(vectorW / 2);
        const hW    = vectorW - cW;
        if (cW > 0) { format += `%c${'█'.repeat(cW)}`; styles.push(`color:${LANE_COLORS.content}`); }
        if (hW > 0) { format += `%c${'█'.repeat(hW)}`; styles.push(`color:${LANE_COLORS.header}`); }
    }

    if (kwW > 0) { format += `%c${'█'.repeat(kwW)}`; styles.push(`color:${LANE_COLORS.keyword}`); }
    if (trailing > 0) { format += `%c${'░'.repeat(trailing)}`; styles.push(EMPTY_STYLE); }
    format += `%c${scoreInt}`;
    styles.push('color:inherit');
    return { format, styles };
}

/**
 * Logs one RAG channel as a collapsible console group with a bar chart,
 * and appends a health telemetry row to healthRows.
 *
 * @param {string}   name          Channel label (e.g. 'chat', 'lb', 'add-lb:Foo')
 * @param {object[]} raw           All candidate results before cutoff
 * @param {object[]} result        Results selected by distributionalCutoff
 * @param {object}   meta          distributionalCutoff metadata
 * @param {number}   kwMaxContrib  Max kw scale value (0 if no kw blend)
 * @param {{ chatKey:string, cfg:object, healthRows:object[] }} ctx
 */
export function logChannel(name, raw, result, meta, kwMaxContrib = 0, { chatKey, cfg, healthRows }) {
    if (!raw.length) { log('RagFetch', `${name}: no candidates`); return; }
    const maxS     = raw[0]?.score ?? 0;
    const minS     = raw.at(-1)?.score ?? 0;
    const M_active = result.length;

    let header = `[CNZ] ${name}`;
    if (meta) {
        const kwPart = kwMaxContrib > 0 ? `  kw≤${kwMaxContrib.toFixed(3)}` : '';
        header += ` | ${raw.length} raw  pool=${meta.candidate_pool_size}  μ=${meta.local_mean.toFixed(3)}  Sk=${meta.pearson_skewness.toFixed(2)}  (${meta.cutoff_mode})${kwPart}  → ${M_active} injected`;
    } else {
        header += ` | ${raw.length} raw (cold-start)  → ${M_active} injected`;
    }

    if (isVerbose()) {
        console.groupCollapsed(header);

        if (meta) {
            const BAR_WIDTH = 20;
            const pool      = raw.slice(0, meta.candidate_pool_size);

            for (let i = 0; i < pool.length; i++) {
                const { format, styles } = _barLine(
                    pool[i].score, pool[i].sources, pool[i].laneScores,
                    pool[i].kwContribution ?? 0, i < M_active, BAR_WIDTH, maxS,
                );
                console.log(format, ...styles);

                if (i === M_active - 1 && i < pool.length - 1) {
                    console.log(`%c  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ cutoff  (threshold ${meta.threshold.toFixed(3)})`, 'color:#5c85d6');
                }
            }
        }

        console.groupEnd();
    }

    healthRows.push({
        character: chatKey, channel: name, provider: cfg.source, model: cfg.model,
        candidates: raw.length, maxScore: maxS, minScore: minS,
        returned:        result.length,
        poolSize:        meta?.candidate_pool_size ?? null,
        localMean:       meta?.local_mean          ?? null,
        localMedian:     meta?.local_median        ?? null,
        localStdDev:     meta?.local_std_dev       ?? null,
        pearsonSkewness: meta?.pearson_skewness    ?? null,
        threshold:       meta?.threshold           ?? null,
        cutoffMode:      meta?.cutoff_mode         ?? null,
    });
}
