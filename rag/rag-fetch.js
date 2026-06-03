/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role IO Wrapper — RAG retrieval execution
 * @description
 * Executes all three RAG paths (chat-context chunks, lorebook-context chunks,
 * lorebook semantic activation) for a single generation and returns structured
 * results. Accepts an AbortSignal so in-flight embed requests can be cancelled
 * immediately when the user stops generation.
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
import { state } from '../state.js';
import { log, error } from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE, DEFAULT_RAG_CHUNK_TEMPLATE } from '../defaults.js';

/**
 * @typedef {{ chunks:number, injection:string, toActivate:object[] }} RagResult
 */

/**
 * Runs all three RAG paths in parallel and returns formatted results.
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
    const topK       = settings.ragRetrievalTopK    ?? 5;
    const topKLb     = settings.ragLbRetrievalTopK  ?? 3;
    const topKPlot         = settings.ragPlotRetrievalTopK ?? 3;
    const plotRecencyCount = settings.ragPlotRecencyCount  ?? 3;
    const plotMinArcs      = settings.ragPlotMinArcs        ?? 2;
    const plotFillerOn     = settings.ragPlotFillerEnabled  ?? true;
    const plotFillerCards  = settings.ragPlotFillerCards    ?? 1;
    const plotFillerStrat  = settings.ragPlotFillerStrategy ?? 'random';
    const noiseFloor = settings.ragScoreThreshold   ?? 0.1;

    const horizonPairs = Math.max(1, settings.ragClassifierHistory ?? 3);
    const allPairs     = buildProsePairs(messages);
    const chatQuery    = cleanForEmbedding(formatPairsAsTranscript(allPairs.slice(-horizonPairs)));

    const activatedWi = ctx.worldInfoActivated ?? [];
    const lbQuery     = cleanForEmbedding(activatedWi
        .map(e => [e.comment, ...(e.key ?? []), e.content].filter(Boolean).join(' '))
        .join('\n')
        .slice(0, 2000));

    const currentChatFile = ctx.getCurrentChatFile?.() ?? '(unknown)';
    const lastAnchorUuid  = validUuids.at(-1) ?? '(none)';
    const plotLbName = state._plotLorebookName ?? null;
    log('RagHook', `fetch anchors=${validUuids.length} topK=${topK} topKLb=${topKLb} topKPlot=${topKPlot} threshold=${noiseFloor}`);
    log('RagHook', `scope chatFile=${currentChatFile} lastAnchor=${lastAnchorUuid}`);

    const t0 = performance.now();

    const [chunkBatches, lbHitsRaw, plotHitsRaw] = await Promise.all([
        Promise.all([
            chatQuery.trim() && topK   > 0 ? querySyncChunks(validUuids, chatQuery, topK,   signal) : [],
            lbQuery.trim()   && topKLb > 0 ? querySyncChunks(validUuids, lbQuery,   topKLb, signal) : [],
        ]),
        topKLb  > 0 && chatQuery.trim() ? queryLorebookEntries(validUuids, chatQuery, topKLb,   signal)           : [],
        topKPlot > 0 && chatQuery.trim() && plotLbName ? queryLorebookEntries(validUuids, chatQuery, topKPlot, signal, plotLbName) : [],
    ]);

    log('RagHook', `all paths resolved in ${(performance.now() - t0).toFixed(0)}ms`);

    const allChunkRows = chunkBatches.flat();
    const chunkFiles   = [...new Set(allChunkRows.map(r => r.chatFile ?? '(null)'))];
    log('RagHook', `chunk chatFiles: ${chunkFiles.join(', ') || '(none)'}`);
    if (lbHitsRaw.length) {
        const lbAnchors = [...new Set(lbHitsRaw.map(r => r.anchorUuid ?? '(null)'))];
        log('RagHook', `lb anchorUuids: ${lbAnchors.join(', ')}`);
    }

    let chunks = [];
    const seen = new Set();
    for (const batch of chunkBatches) {
        for (const r of batch) {
            if (r.score < noiseFloor || seen.has(r.text)) continue;
            seen.add(r.text);
            chunks.push(r);
        }
    }
    log('RagHook', `score filter: ${allChunkRows.length} raw → ${chunks.length} above noiseFloor=${noiseFloor}`);

    const totalPairs = allPairs.length;
    if (totalPairs > 0) {
        for (const c of chunks) {
            const age    = Math.max(0, totalPairs - (c.pairEnd ?? totalPairs));
            const factor = Math.max(0.70, 1.0 - 0.025 * Math.log(age + 1));
            c.score      = c.score * factor;
        }
    }
    chunks.sort((a, b) => b.score - a.score);
    chunks = chunks.slice(0, topK);
    if (chunks.length) {
        const srcMap = {};
        for (const c of chunks) for (const s of (c.sources ?? [])) srcMap[s] = (srcMap[s] || 0) + 1;
        log('RagHook', `final chunks=${chunks.length} sources=${JSON.stringify(srcMap)} scores=${chunks.at(-1).score.toFixed(3)}–${chunks[0].score.toFixed(3)}`);
    }

    const activeUids = new Set((ctx.worldInfoActivated ?? []).map(e => e.uid));
    const toActivate = [...lbHitsRaw, ...plotHitsRaw]
        .filter(h => h.score >= noiseFloor && !activeUids.has(h.entryUid))
        .map(h => ({ world: h.lorebookName, uid: h.entryUid }));

    if (plotLbName && (plotHitsRaw.length > 0 || (plotFillerOn && plotMinArcs > 0))) {
        try {
            const semanticUids  = plotHitsRaw.map(h => h.entryUid);
            const recencyUids   = await queryRecentPlotEntries(plotLbName, validUuids, semanticUids, plotRecencyCount, signal, plotMinArcs, plotFillerOn, plotFillerCards, plotFillerStrat, allPairs.length);
            const activatedSet  = new Set(toActivate.map(a => a.uid));
            for (const uid of recencyUids)
                if (!activatedSet.has(uid) && !activeUids.has(uid))
                    toActivate.push({ world: plotLbName, uid });
            if (recencyUids.length) log('RagHook', `plot recency: +${recencyUids.length} entries`);
        } catch (err) { error('RagHook', 'Plot recency failed:', err); }
    }

    let injection = '';
    if (chunks.length) {
        const charName   = ctx.name2 ?? ctx.name ?? '';
        const chunkTmpl  = settings.ragChunkTemplate || DEFAULT_RAG_CHUNK_TEMPLATE;
        const body = chunks.map(r => {
            const content = r.header ? `[${r.header}]\n${r.text}` : r.text;
            return chunkTmpl
                .replace(/\{\{text\}\}/g,       content)
                .replace(/\{\{turn_range\}\}/g,  r.turnRange ?? '')
                .replace(/\{\{header\}\}/g,      r.header ?? '')
                .replace(/\{\{char_name\}\}/g,   charName);
        }).join('\n\n');
        const tmpl = settings.ragInjectionTemplate || DEFAULT_RAG_INJECTION_TEMPLATE;
        injection  = tmpl.replace('{{text}}', body);
    }

    return { chunks: chunks.length, injection, toActivate };
}
