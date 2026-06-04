/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
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

    const signalStrength = settings.ragSignalStrength          ?? 0.35;
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

    log('RagFetch', `fetch anchors=${validUuids.length} signal=${signalStrength} chat=[${chatMin},${chatMax}] lb=[${lbMin},${lbMax}] plot=[${plotMin},${plotMax}]`);

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

    // ── Distributional cutoff per channel ─────────────────────────────────────

    const chunks   = distributionalCutoff(chatRaw, { min: chatMin, max: chatMax, signalStrength });
    const lbHits   = distributionalCutoff(lbRaw,   { min: lbMin,  max: lbMax,   signalStrength });
    const plotHits = distributionalCutoff(plotRaw,  { min: plotMin, max: plotMax, signalStrength });

    // ── Logging + health telemetry ────────────────────────────────────────────

    const cfg = embedCfg();
    const healthRows = [];

    const _logChannel = (name, raw, result, maxBound) => {
        if (!raw.length) { log('RagFetch', `${name}: no candidates`); return; }
        const maxS = raw[0]?.score ?? 0;
        const minS = raw.at(-1)?.score ?? 0;
        const mu   = raw.reduce((s, c) => s + c.score, 0) / raw.length;
        const str  = maxS > 0 ? ((maxS - minS) / maxS).toFixed(3) : '0.000';
        const injectedScores = result.length ? ` (${result.map(c => c.score.toFixed(2)).join(', ')})` : '';
        log('RagFetch', `${name}: ${raw.length} raw | max=${maxS.toFixed(3)} min=${minS.toFixed(3)} μ=${mu.toFixed(3)} strength=${str} → ${result.length} injected${injectedScores}`);
        healthRows.push({
            character: chatKey, channel: name, provider: cfg.source, model: cfg.model,
            candidates: raw.length, maxScore: maxS, minScore: minS, meanScore: mu,
            signalThresh: signalStrength, returned: result.length, max: maxBound,
        });
    };
    _logChannel('chat', chatRaw.sort((a, b) => b.score - a.score), chunks,   chatMax);
    _logChannel('lb',   lbRaw.sort((a, b) => b.score - a.score),   lbHits,   lbMax);
    _logChannel('plot', plotRaw.sort((a, b) => b.score - a.score),  plotHits, plotMax);

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