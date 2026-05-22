/**
 * @file data/default-user/extensions/canonize/rag/generation-hook.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 2.2.0
 * @architectural-role IO Wrapper
 * @description
 * Prefetch-optimised RAG retrieval. Three paths:
 *
 *   1. Chat-context path  — query built from the last N recent message pairs.
 *   2. Lorebook-context path — query built from currently activated WI entries.
 *   3. Lorebook semantic activation — recent chat queries the lb_entries table;
 *      matching entries not already keyword-activated are force-activated via
 *      WORLDINFO_FORCE_ACTIVATE so ST processes them through its normal WI pipeline.
 *
 * To minimise send-button lag, prefetchRag() is called on MESSAGE_SENT so the
 * embed round-trips to cnz-db start while ST is still appending the message
 * and saving chat. onGenerationStarted() then awaits the already-in-flight
 * promise rather than starting fresh. Swipe/regen have no MESSAGE_SENT event,
 * so the chat-length guard falls through to a fresh synchronous fetch.
 *
 * @api-declaration
 * prefetchRag()
 * onGenerationStarted()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [_prefetchPromise, _prefetchChatLen]
 *     external_io: [vec-store.js, setExtensionPrompt, WORLDINFO_FORCE_ACTIVATE]
 */

import { state }             from '../state.js';
import { getSettings }       from '../core/settings.js';
import { buildProsePairs, formatPairsAsTranscript } from '../core/transcript.js';
import { querySyncChunks, queryLorebookEntries } from './vec-store.js';
import { log, error }        from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE } from '../defaults.js';
import { eventSource, event_types } from '../../../../../script.js';

const EXT_PROMPT_KEY  = 'cnz_rag';
const INJECT_POSITION = 2;

let _prefetchPromise = null;
let _prefetchChatLen = -1;

// ── Core retrieval ────────────────────────────────────────────────────────────

/**
 * Runs all three RAG paths and returns structured results. Does NOT touch the DOM
 * or emit events — callers do that after awaiting.
 * @returns {Promise<{ chunks:number, injection:string, depth:number, toActivate:object[] }>}
 */
async function _doRagFetch(ctx, settings, chain) {
    const messages   = ctx.chat ?? [];
    const validUuids = chain.anchors.map(r => r.anchor.uuid);
    const topK       = settings.ragRetrievalTopK   ?? 5;
    const topKLb     = settings.ragLbRetrievalTopK ?? 3;
    const threshold  = settings.ragScoreThreshold  ?? 0;

    const horizonPairs = Math.max(1, settings.ragClassifierHistory ?? 3);
    const allPairs     = buildProsePairs(messages);
    const chatQuery    = formatPairsAsTranscript(allPairs.slice(-horizonPairs));

    const activatedWi = ctx.worldInfoActivated ?? [];
    const lbQuery     = activatedWi
        .map(e => [e.comment, ...(e.key ?? []), e.content].filter(Boolean).join(' '))
        .join('\n')
        .slice(0, 2000);

    log('RagHook', `fetch anchors=${validUuids.length} topK=${topK} topKLb=${topKLb} threshold=${threshold}`);

    // ── Paths 1 + 2: chunk retrieval (parallel) ───────────────────────────────
    let chunks = [];
    const promises = [];
    if (chatQuery.trim() && topK > 0)   promises.push(querySyncChunks(validUuids, chatQuery, topK));
    if (lbQuery.trim()   && topKLb > 0) promises.push(querySyncChunks(validUuids, lbQuery,   topKLb));

    if (promises.length) {
        const batches = await Promise.all(promises);
        const seen    = new Set();
        for (const batch of batches) {
            for (const r of batch) {
                if (r.score < threshold || seen.has(r.text)) continue;
                seen.add(r.text);
                chunks.push(r);
            }
        }
        chunks.sort((a, b) => b.score - a.score);
    }

    // ── Path 3: lorebook semantic activation ──────────────────────────────────
    let toActivate = [];
    if (topKLb > 0 && chatQuery.trim()) {
        const lbHits     = await queryLorebookEntries(validUuids, chatQuery, topKLb);
        const activeUids = new Set((ctx.worldInfoActivated ?? []).map(e => e.uid));
        toActivate = lbHits
            .filter(h => h.score >= threshold && !activeUids.has(h.entryUid))
            .map(h => ({ world: h.lorebookName, uid: h.entryUid }));
    }

    // ── Format injection ───────────────────────────────────────────────────────
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

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called on MESSAGE_SENT. Starts the RAG fetch immediately without blocking ST's
 * message-send flow. The promise is stored so onGenerationStarted can await an
 * already-in-flight result instead of waiting synchronously on send.
 */
export function prefetchRag() {
    const settings = getSettings();
    if (!settings.enableRag) return;
    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) return;
    const ctx      = SillyTavern.getContext();
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    log('RagHook', `Prefetch started (chatLen=${messages.length})`);
    _prefetchChatLen = messages.length;
    _prefetchPromise = _doRagFetch(ctx, settings, chain).catch(err => {
        error('RagHook', 'Prefetch failed:', err);
        return null;
    });
}

/**
 * Fired on GENERATION_STARTED. Awaits the pre-fetched result when the chat length
 * matches, otherwise falls back to a fresh fetch (swipe / regen paths). Injects
 * the result and fires lorebook semantic activation.
 */
export async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enableRag) return;
    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) return;
    const ctx      = SillyTavern.getContext();
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    log('RagHook', `source=${settings.ragEmbeddingSource ?? '(unset)'} model=${settings.ragEmbeddingModel ?? '(unset)'}`);

    let result = null;
    if (_prefetchPromise && _prefetchChatLen === messages.length) {
        log('RagHook', 'Awaiting prefetch');
        result = await _prefetchPromise;
    }
    _prefetchPromise = null;
    _prefetchChatLen = -1;

    if (!result) {
        try {
            result = await _doRagFetch(ctx, settings, chain);
        } catch (err) {
            error('RagHook', 'Failed to query CNZ vector store:', err);
            return;
        }
    }

    log('RagHook', `${result.chunks} chunks injected`);
    ctx.setExtensionPrompt(EXT_PROMPT_KEY, result.injection, INJECT_POSITION, result.depth);

    if (result.toActivate.length) {
        log('RagHook', `Semantic LB activation: ${result.toActivate.length} entries`);
        try {
            await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, result.toActivate);
        } catch (err) {
            error('RagHook', 'Lorebook semantic activation failed:', err);
        }
    }
}
