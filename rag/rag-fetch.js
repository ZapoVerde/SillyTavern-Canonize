/**
 * @file data/default-user/extensions/canonize/rag/rag-fetch.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
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
 *     external_io:     [vec-store.js]
 */

import { buildProsePairs, formatPairsAsTranscript, cleanForEmbedding } from '../core/transcript.js';
import { querySyncChunks, queryLorebookEntries } from './vec-store.js';
import { log, error } from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE } from '../defaults.js';

/**
 * @typedef {{ chunks:number, injection:string, depth:number, toActivate:object[] }} RagResult
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
    const topK       = settings.ragRetrievalTopK   ?? 5;
    const topKLb     = settings.ragLbRetrievalTopK ?? 3;
    const noiseFloor = settings.ragScoreThreshold  ?? 0.1;

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
    log('RagHook', `fetch anchors=${validUuids.length} topK=${topK} topKLb=${topKLb} threshold=${noiseFloor}`);
    log('RagHook', `scope chatFile=${currentChatFile} lastAnchor=${lastAnchorUuid}`);

    const t0 = performance.now();

    const [chunkBatches, lbHitsRaw] = await Promise.all([
        Promise.all([
            chatQuery.trim() && topK   > 0 ? querySyncChunks(validUuids, chatQuery, topK,   signal) : [],
            lbQuery.trim()   && topKLb > 0 ? querySyncChunks(validUuids, lbQuery,   topKLb, signal) : [],
        ]),
        topKLb > 0 && chatQuery.trim() ? queryLorebookEntries(validUuids, chatQuery, topKLb, signal) : [],
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

    const activeUids = new Set((ctx.worldInfoActivated ?? []).map(e => e.uid));
    const toActivate = lbHitsRaw
        .filter(h => h.score >= noiseFloor && !activeUids.has(h.entryUid))
        .map(h => ({ world: h.lorebookName, uid: h.entryUid }));

    let injection = '';
    const depth = settings.ragInjectionDepth ?? 0;
    if (chunks.length) {
        const separator = settings.ragSeparator || '***';
        const lines     = chunks.map(r => {
            const label = r.header ? `[${r.header}]` : (r.turnRange ?? '');
            return label ? `${label}\n${r.text}` : r.text;
        });
        const body = lines.join(`\n${separator}\n`);
        const tmpl = settings.ragInjectionTemplate || DEFAULT_RAG_INJECTION_TEMPLATE;
        injection  = tmpl.replace('{{text}}', body);
    }

    return { chunks: chunks.length, injection, depth, toActivate };
}
