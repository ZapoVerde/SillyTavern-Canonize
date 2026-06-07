/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch.js
 * @stamp {"utc":"2026-06-06T00:00:00.000Z"}
 * @version 1.3.0
 * @architectural-role IO Wrapper — RAG retrieval execution
 * @description
 * Executes all three RAG channels (chat chunks, LB entries, plot LB entries)
 * for a single generation and returns structured results. Each channel queries
 * its full collection (topK=100k), then the distributional cutoff decides how
 * many results to use. Accepts an AbortSignal so in-flight embed requests can
 * be cancelled immediately when the user stops generation.
 *
 * Does not touch state, events, or the DOM — callers handle injection.
 *
 * @api-declaration
 * doRagFetch(ctx, settings, chain, signal) → Promise<RagResult|null>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [file-store.js, file-store-lb.js]
 */

import { buildProsePairs, formatPairsAsTranscript, cleanForEmbedding } from '../core/transcript.js';
import { querySyncChunks } from './file-store.js';
import { queryLorebookEntries, queryRecentPlotEntries } from './file-store-lb.js';
import { distributionalCutoff } from './cutoff.js';
import { embedCfg } from './embed-client.js';
import { appendHealthRows } from './rag-health.js';
import { cnzGetActiveChatKey } from './api.js';
import { state } from '../state.js';
import { log, error } from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE, DEFAULT_RAG_CHUNK_TEMPLATE } from '../defaults.js';

/**
 * @typedef {{ chunks:number, injection:string, toActivate:object[] }} RagResult
 */

/**
 * Runs all three RAG channels in parallel and returns formatted results.
 * Returns null if aborted or if the query scope is empty.
 *
 * @param {object}      ctx       SillyTavern context
 * @param {object}      settings  CNZ settings snapshot
 * @param {object}      chain     Current DNA chain
 * @param {AbortSignal} [signal]  Optional abort signal
 * @returns {Promise<RagResult|null>}
 */
export async function doRagFetch(ctx, settings, chain, signal) {
    const messages   = ctx.chat ?? [];
    const validUuids = chain.anchors.map(r => r.anchor.uuid);

    const cutoffMode     = settings.ragCutoffMode               ?? 'mean';
    const poolMultiple   = settings.ragPoolMultiple             ?? 2;
    const kwBlend        = settings.ragKwBlend                  ?? 0.7;
    const chatMin        = settings.ragChatMin                  ?? 2;
    const chatMax        = settings.ragChatMax                  ?? 8;
    const lbMin          = settings.ragLbMin                    ?? 2;
    const lbMax          = settings.ragLbMax                    ?? 4;
    const plotMin        = settings.ragPlotMinArcs              ?? 2;
    const plotMax        = settings.ragPlotRetrievalTopK        ?? 5;
    const plotRecencyCount  = settings.ragPlotRecencyCount      ?? 3;
    const plotFillerOn      = settings.ragPlotFillerEnabled     ?? true;
    const plotFillerCards   = settings.ragPlotFillerCards       ?? 1;
    const plotFillerStrat   = settings.ragPlotFillerStrategy    ?? 'random';

    const horizonPairs = Math.max(1, settings.ragClassifierHistory ?? 3);
    const allPairs     = buildProsePairs(messages);
    const chatQuery    = cleanForEmbedding(formatPairsAsTranscript(allPairs.slice(-horizonPairs)));

    const chatKey    = cnzGetActiveChatKey();
    const plotLbName = state._plotLorebookName ?? null;

    log('RagFetch', `fetch anchors=${validUuids.length} cutoff=${cutoffMode} pool=${poolMultiple}x chat=[${chatMin},${chatMax}] lb=[${lbMin},${lbMax}] plot=[${plotMin},${plotMax}]`);

    if (!chatKey || !chatQuery.trim() || !validUuids.length) {
        return { chunks: 0, injection: '', toActivate: [] };
    }

    const t0 = performance.now();

    // ── Run all three channels in parallel ────────────────────────────────────

    // General LB: query head anchor only — it holds the current lorebook state.
    // Plot LB: append-only, entries are spread across all anchors, so all UUIDs are needed.
    const headUuid = validUuids[validUuids.length - 1];

    const [chatRaw, lbRaw, plotRaw] = await Promise.all([
        querySyncChunks(chatKey, validUuids, chatQuery, signal),
        queryLorebookEntries(chatKey, [headUuid], chatQuery, signal),
        plotLbName ? queryLorebookEntries(chatKey, validUuids, chatQuery, signal, plotLbName) : [],
    ]);

    log('RagFetch', `all channels resolved in ${(performance.now() - t0).toFixed(0)}ms — chat=${chatRaw.length} lb=${lbRaw.length} plot=${plotRaw.length} raw`);

    // ── Temporal decay on chat chunks (score adjusted before cutoff) ──────────

    const totalPairs = allPairs.length;
    if (totalPairs > 0) {
        for (const c of chatRaw) {
            const age    = Math.max(0, totalPairs - (c.pairEnd ?? totalPairs));
            const factor = Math.max(0.70, 1.0 - 0.025 * Math.log(age + 1));
            c.score      = c.score * factor;
        }
    }

    // ── Keyword blend (chat channel only — lb/plot have no FTS layer) ─────────
    // Normalise TF-IDF scores within this result set so the top keyword match
    // contributes exactly (1 - kwBlend) × maxVectorScore to the fused score.
    // Keyword-only items (score=0 from RRF) are ranked purely by this contribution.

    const maxVec    = chatRaw.reduce((m, r) => Math.max(m, r.score), 0);
    const maxKw     = chatRaw.reduce((m, r) => Math.max(m, r.kwTfidf ?? 0), 0);
    const kwScale   = maxKw > 0 ? (1 - kwBlend) * maxVec : 0;

    if (kwScale > 0) {
        for (const r of chatRaw) {
            const contrib    = r.kwTfidf != null ? (r.kwTfidf / maxKw) * kwScale : 0;
            r.kwContribution = contrib;
            r.score         += contrib;
        }
    } else {
        for (const r of chatRaw) r.kwContribution = 0;
    }

    // ── Distributional cutoff per channel ─────────────────────────────────────

    const cutoffOpts = { cutoffMode, poolMultiple };
    const { results: chunks,   metadata: chatMeta  } = distributionalCutoff(chatRaw, { min: chatMin, max: chatMax, ...cutoffOpts });
    const { results: lbHits,   metadata: lbMeta    } = distributionalCutoff(lbRaw,   { min: lbMin,   max: lbMax,   ...cutoffOpts });
    const { results: plotHits, metadata: plotMeta  } = distributionalCutoff(plotRaw,  { min: plotMin, max: plotMax, ...cutoffOpts });

    // ── Logging + health telemetry ────────────────────────────────────────────

    const cfg = embedCfg();
    const healthRows = [];

    // ── Lane color palette (chat channel only — lb/plot have no sources field) ──
    const LANE_COLORS = { content: '#4fc3f7', header: '#ffb74d', keyword: '#81c784' };
    const EMPTY_STYLE = 'color:#3a3a3a';
    const GRAY_STYLE  = 'color:#555';

    // Returns { format, styles } for a single bar line using %c segments.
    const _barLine = (score, sources, laneScores, kwContribution, isInjected, BAR_WIDTH, maxS) => {
        const barLen   = maxS > 0 ? Math.round((score / maxS) * BAR_WIDTH) : 0;
        const trailing = BAR_WIDTH - barLen;
        const total    = Math.round(score * 1000);
        const kw       = Math.round(kwContribution * 1000);
        const scoreInt = kw > 0 ? `  ${total - kw}+${kw}=${total}` : `  ${total}`;

        if (!isInjected) {
            const bar = '█'.repeat(barLen) + '░'.repeat(trailing);
            return { format: `%c  ${bar}${scoreInt}`, styles: [GRAY_STYLE] };
        }

        const lanes = (sources ?? []).filter(s => LANE_COLORS[s]);
        if (!lanes.length) {
            const bar = '█'.repeat(barLen) + '░'.repeat(trailing);
            return { format: `%c  ${bar}${scoreInt}`, styles: ['color:inherit'] };
        }

        // Keyword portion proportional to its actual contribution; vector fills the remainder.
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
            const cS    = laneScores?.content ?? 0;
            const hS    = laneScores?.header  ?? 0;
            const total = cS + hS;
            const cW    = total > 0 ? Math.round(vectorW * cS / total) : Math.floor(vectorW / 2);
            const hW    = vectorW - cW;
            if (cW > 0) { format += `%c${'█'.repeat(cW)}`; styles.push(`color:${LANE_COLORS.content}`); }
            if (hW > 0) { format += `%c${'█'.repeat(hW)}`; styles.push(`color:${LANE_COLORS.header}`); }
        }

        if (kwW > 0) { format += `%c${'█'.repeat(kwW)}`; styles.push(`color:${LANE_COLORS.keyword}`); }
        if (trailing > 0) { format += `%c${'░'.repeat(trailing)}`; styles.push(EMPTY_STYLE); }
        format += `%c${scoreInt}`;
        styles.push('color:inherit');
        return { format, styles };
    };

    const _logChannel = (name, raw, result, meta, kwMaxContrib = 0) => {
        if (!raw.length) { log('RagFetch', `${name}: no candidates`); return; }
        const maxS     = raw[0]?.score ?? 0;
        const minS     = raw.at(-1)?.score ?? 0;
        const M_active = result.length;

        // ── Collapsible group header ──────────────────────────────────────────
        let header = `[CNZ] ${name}`;
        if (meta) {
            const kwPart = kwMaxContrib > 0 ? `  kw≤${kwMaxContrib.toFixed(3)}` : '';
            header += ` | ${raw.length} raw  pool=${meta.candidate_pool_size}  μ=${meta.local_mean.toFixed(3)}  Sk=${meta.pearson_skewness.toFixed(2)}  (${meta.cutoff_mode})${kwPart}  → ${M_active} injected`;
        } else {
            header += ` | ${raw.length} raw (cold-start)  → ${M_active} injected`;
        }

        console.groupCollapsed(header);

        // ── Bar chart ─────────────────────────────────────────────────────────
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

        // ── Health telemetry ──────────────────────────────────────────────────
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
    };
    _logChannel('chat', chatRaw.sort((a, b) => b.score - a.score), chunks,   chatMeta, kwScale);
    _logChannel('lb',   lbRaw.sort((a, b) => b.score - a.score),   lbHits,   lbMeta);
    _logChannel('plot', plotRaw.sort((a, b) => b.score - a.score),  plotHits, plotMeta);

    appendHealthRows(healthRows).catch(() => {});

    // ── LB + plot activation ──────────────────────────────────────────────────

    const activeUids   = new Set((ctx.worldInfoActivated ?? []).map(e => e.uid));
    const toActivate   = lbHits
        .filter(h => !activeUids.has(h.entryUid))
        .map(h => ({ world: h.lorebookName, uid: h.entryUid }));

    if (plotLbName) {
        try {
            const semanticUids  = plotHits.map(h => h.entryUid);
            const recencyUids   = await queryRecentPlotEntries(
                chatKey, plotLbName, validUuids, semanticUids, plotRecencyCount, signal,
                plotMin, plotFillerOn, plotFillerCards, plotFillerStrat, allPairs.length,
            );
            const activatedSet  = new Set(toActivate.map(a => a.uid));
            for (const uid of recencyUids)
                if (!activatedSet.has(uid) && !activeUids.has(uid))
                    toActivate.push({ world: plotLbName, uid });
            if (recencyUids.length) log('RagFetch', `plot recency: +${recencyUids.length} entries`);
        } catch (err) { error('RagFetch', 'Plot recency failed:', err); }
    }

    // ── Build prose injection ─────────────────────────────────────────────────

    let injection = '';
    if (chunks.length) {
        const charName  = ctx.name2 ?? ctx.name ?? '';
        const chunkTmpl = settings.ragChunkTemplate || DEFAULT_RAG_CHUNK_TEMPLATE;
        const body = chunks.slice().sort((a, b) => (a.pairEnd ?? 0) - (b.pairEnd ?? 0)).map(r => {
            const content = r.header ? `[${r.header}]\n${r.text}` : r.text;
            return chunkTmpl
                .replace(/\{\{text\}\}/g,      content)
                .replace(/\{\{turn_range\}\}/g, r.turnRange ?? '')
                .replace(/\{\{header\}\}/g,     r.header ?? '')
                .replace(/\{\{char_name\}\}/g,  charName);
        }).join('\n\n');
        const tmpl = settings.ragInjectionTemplate || DEFAULT_RAG_INJECTION_TEMPLATE;
        injection  = tmpl.replace('{{text}}', body);
    }

    log('RagFetch', `done | chunks=${chunks.length} lbActivations=${lbHits.length} toActivate=${toActivate.length}`);
    return { chunks: chunks.length, injection, toActivate };
}