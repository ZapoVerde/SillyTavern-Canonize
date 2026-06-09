/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.4.0
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
import { logChannel } from './rag-fetch-log.js';

/**
 * @typedef {{ chunks:number, injection:string, toActivate:object[], bypassEntries:object[] }} RagResult
 * toActivate   — { world, uid } pairs for WORLDINFO_FORCE_ACTIVATE (primary LB + additional non-bypass)
 * bypassEntries — { lorebookName, uid, content, comment, key } for direct prompt injection (additional bypass LBs)
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

    // ── Keyword blend — all channels that carry kwTfidf ──────────────────────
    // Normalise TF-IDF scores so the top keyword match contributes exactly
    // (1 - kwBlend) × maxVectorScore. Keyword-only items (score=0 from RRF)
    // are ranked purely by this contribution.

    const _applyKwBlend = (raw) => {
        const maxVec = raw.reduce((m, r) => Math.max(m, r.score), 0);
        const maxKw  = raw.reduce((m, r) => Math.max(m, r.kwTfidf ?? 0), 0);
        const scale  = maxKw > 0 ? (1 - kwBlend) * maxVec : 0;
        for (const r of raw) {
            const contrib    = (scale > 0 && r.kwTfidf != null) ? (r.kwTfidf / maxKw) * scale : 0;
            r.kwContribution = contrib;
            r.score         += contrib;
        }
        return scale;
    };

    const kwScaleChat = _applyKwBlend(chatRaw);
    const kwScaleLb   = _applyKwBlend(lbRaw);
    const kwScalePlot = _applyKwBlend(plotRaw);

    // ── Distributional cutoff per channel ─────────────────────────────────────

    const cutoffOpts = { cutoffMode, poolMultiple };
    const { results: chunks,   metadata: chatMeta  } = distributionalCutoff(chatRaw, { min: chatMin, max: chatMax, ...cutoffOpts });
    const { results: lbHits,   metadata: lbMeta    } = distributionalCutoff(lbRaw,   { min: lbMin,   max: lbMax,   ...cutoffOpts });
    const { results: plotHits, metadata: plotMeta  } = distributionalCutoff(plotRaw,  { min: plotMin, max: plotMax, ...cutoffOpts });

    // ── Logging + health telemetry ────────────────────────────────────────────

    const cfg = embedCfg();
    const healthRows = [];

    const logCtx = { chatKey, cfg, healthRows };
    logChannel('chat', chatRaw.sort((a, b) => b.score - a.score), chunks,   chatMeta, kwScaleChat, logCtx);
    logChannel('lb',   lbRaw.sort((a, b) => b.score - a.score),   lbHits,   lbMeta,   kwScaleLb,  logCtx);
    logChannel('plot', plotRaw.sort((a, b) => b.score - a.score),  plotHits, plotMeta, kwScalePlot, logCtx);

    appendHealthRows(healthRows).catch(() => {});

    // ── Additional lorebooks — parallel queries, per-lorebook cutoff ─────────

    const additionalLbs = state._additionalLorebooks ?? [];
    const additionalRaw = additionalLbs.length
        ? await Promise.all(
            additionalLbs.map(lb =>
                queryLorebookEntries(chatKey, [headUuid], chatQuery, signal, lb.name)
                    .then(raw => {
                        _applyKwBlend(raw);
                        const { results, metadata } = distributionalCutoff(raw, {
                            min: lb.min ?? 1, max: lb.max ?? 3, cutoffMode, poolMultiple,
                        });
                        logChannel(`add-lb:${lb.name}`, raw.sort((a, b) => b.score - a.score), results, metadata, 0, logCtx);
                        return { lb, hits: results };
                    })
                    .catch(() => ({ lb, hits: [] }))
            )
        )
        : [];

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
            for (const uid of [...semanticUids, ...recencyUids])
                if (!activatedSet.has(uid) && !activeUids.has(uid)) {
                    activatedSet.add(uid);
                    toActivate.push({ world: plotLbName, uid });
                }
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

    // ── Sort additional LB hits into activation vs direct-inject buckets ─────

    const bypassEntries = [];
    for (const { lb, hits } of additionalRaw) {
        for (const h of hits) {
            if (activeUids.has(h.entryUid)) continue;
            if (lb.bypass) {
                bypassEntries.push({
                    lorebookName: h.lorebookName,
                    uid:     h.entryUid,
                    content: h.content ?? '',
                    comment: h.comment ?? '',
                    key:     h.entryKeys ?? [],
                });
            } else {
                toActivate.push({ world: h.lorebookName, uid: h.entryUid });
            }
        }
    }

    log('RagFetch', `done | chunks=${chunks.length} lbActivations=${lbHits.length} toActivate=${toActivate.length} bypass=${bypassEntries.length}`);
    return { chunks: chunks.length, injection, toActivate, bypassEntries };
}