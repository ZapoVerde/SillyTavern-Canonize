/**
 * @file data/default-user/extensions/canonize/rag/generation-hook.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
 * @version 2.3.0
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
 * resetRagState(ctx)   — clears stale prefetch + extension prompt on chat change
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [_prefetchPromise, _prefetchChatLen]
 *     external_io: [vec-store.js, setExtensionPrompt, WORLDINFO_FORCE_ACTIVATE]
 */

import { state }             from '../state.js';
import { getSettings }       from '../core/settings.js';
import { buildProsePairs, formatPairsAsTranscript, cleanForEmbedding } from '../core/transcript.js';
import { querySyncChunks, queryLorebookEntries } from './vec-store.js';
import { log, error }        from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE } from '../defaults.js';
import { eventSource, event_types } from '../../../../../script.js';

const EXT_PROMPT_KEY  = 'cnz_rag';
const INJECT_POSITION = 2;

let _prefetchPromise = null;
let _prefetchChatLen = -1;
let _prefetchResult  = null; // set synchronously when the promise settles

// ── Timing ────────────────────────────────────────────────────────────────────
// tSend        — performance.now() when prefetchRag() fires (MESSAGE_SENT)
// tInterceptor — when onGenerationStarted() enters (interceptor phase)
// tRagDone     — when RAG result is obtained and injected
// tFirstToken  — first STREAM_TOKEN_RECEIVED
// prefetchHit  — true if await _prefetchPromise returned in <50ms (was pre-settled)
let _timing = null;

function _ms(t) { return t != null ? `${Math.round(t)}ms` : '?'; }

function _printTimingSummary(tEnd) {
    if (!_timing) return;
    const t = _timing;
    _timing  = null;

    const prefetchWindow = t.tSend != null && t.tInterceptor != null
        ? t.tInterceptor - t.tSend : null;
    const ragCost = t.tInterceptor != null && t.tRagDone != null
        ? t.tRagDone - t.tInterceptor : null;
    const ttft = t.tRagDone != null && t.tFirstToken != null
        ? t.tFirstToken - t.tRagDone : null;
    const streaming = t.tFirstToken != null
        ? tEnd - t.tFirstToken : null;
    const total = t.tSend != null ? tEnd - t.tSend : null;

    const prefetchLabel = t.tSend == null
        ? 'no prefetch (swipe/regen)'
        : t.prefetchHit
            ? 'HIT — embed pre-settled, ~0ms blocking'
            : 'MISS — embed ran in interceptor';

    const lines = [
        '── CNZ Generation Timing ──────────────────────────────',
        `  prefetch window  send→interceptor: ${prefetchWindow != null ? _ms(prefetchWindow) : 'n/a (swipe/regen)'}  [concurrent with ST pipeline]`,
        `  RAG interceptor  (blocking):       ${_ms(ragCost)}  [prefetch: ${prefetchLabel}]`,
        `  prompt build + TTFT:               ${ttft != null ? _ms(ttft) : 'n/a (non-streaming)'}`,
        `  streaming        1st→last token:   ${streaming != null ? _ms(streaming) : 'n/a'}`,
        '  ────────────────────────────────────────────────────',
        `  total            send→last token:  ${total != null ? _ms(total) : _ms(ragCost != null ? tEnd - t.tInterceptor : null) + ' (interceptor→end)'}`,
    ];
    log('Perf', lines.join('\n'));
}

/**
 * Discards any in-flight prefetch and clears the RAG extension prompt.
 * Called by session.js on every CHAT_CHANGED so stale state from the previous
 * chat can never contaminate the incoming one.
 * @param {object|null} ctx  ST context, or null if unavailable.
 */
export function resetRagState(ctx) {
    _prefetchPromise = null;
    _prefetchChatLen = -1;
    _prefetchResult  = null;
    _timing          = null;
    ctx?.setExtensionPrompt?.(EXT_PROMPT_KEY, '', INJECT_POSITION, 0);
}

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

    // ── Paths 1 + 2 + 3: all three queries in parallel ────────────────────────
    // Path 3 (lb semantic) previously ran after 1+2, doubling latency.
    // All three embed independent query texts — run them together.
    const t0 = performance.now();

    const [chunkBatches, lbHitsRaw] = await Promise.all([
        // Paths 1 + 2: chunk queries (chat context + WI context)
        Promise.all([
            chatQuery.trim() && topK   > 0 ? querySyncChunks(validUuids, chatQuery, topK)   : [],
            lbQuery.trim()   && topKLb > 0 ? querySyncChunks(validUuids, lbQuery,   topKLb) : [],
        ]),
        // Path 3: lorebook semantic activation
        topKLb > 0 && chatQuery.trim() ? queryLorebookEntries(validUuids, chatQuery, topKLb) : [],
    ]);

    log('RagHook', `all paths resolved in ${(performance.now() - t0).toFixed(0)}ms`);

    // ── Diagnostic: source attribution ───────────────────────────────────────
    const allChunkRows = chunkBatches.flat();
    const chunkFiles   = [...new Set(allChunkRows.map(r => r.chatFile ?? '(null)'))];
    log('RagHook', `chunk chatFiles: ${chunkFiles.join(', ') || '(none)'}`);
    if (lbHitsRaw.length) {
        const lbAnchors = [...new Set(lbHitsRaw.map(r => r.anchorUuid ?? '(null)'))];
        log('RagHook', `lb anchorUuids: ${lbAnchors.join(', ')}`);
    }

    // ── Merge chunk results ────────────────────────────────────────────────────
    let chunks = [];
    const seen = new Set();
    for (const batch of chunkBatches) {
        for (const r of batch) {
            if (r.score < noiseFloor || seen.has(r.text)) continue;
            seen.add(r.text);
            chunks.push(r);
        }
    }
    // Logarithmic temporal decay: gently prefer recent chunks without burying old ones.
    // factor = max(0.70, 1 - 0.025 * ln(age + 1))
    // age=50 → 0.90, age=1000 → 0.83, age=5000 → 0.79 — curve flattens for ancient content.
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

    // ── Lorebook activation candidates ────────────────────────────────────────
    const activeUids = new Set((ctx.worldInfoActivated ?? []).map(e => e.uid));
    const toActivate = lbHitsRaw
        .filter(h => h.score >= noiseFloor && !activeUids.has(h.entryUid))
        .map(h => ({ world: h.lorebookName, uid: h.entryUid }));

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

    log('RagHook', `MESSAGE_SENT → prefetch start (chatLen=${messages.length}) t=${Date.now()}`);
    _timing          = { tSend: performance.now(), tInterceptor: null, tRagDone: null, tFirstToken: null, prefetchHit: false };
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
    const ctx      = SillyTavern.getContext();
    const settings = getSettings();
    if (!settings.enableRag) {
        ctx.setExtensionPrompt(EXT_PROMPT_KEY, '', INJECT_POSITION, 0);
        return;
    }
    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) {
        ctx.setExtensionPrompt(EXT_PROMPT_KEY, '', INJECT_POSITION, 0);
        return;
    }
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    const tInterceptor = performance.now();
    if (_timing) {
        _timing.tInterceptor = tInterceptor;
    } else {
        // swipe / regen: no MESSAGE_SENT prefetch, start timing fresh
        _timing = { tSend: null, tInterceptor: tInterceptor, tRagDone: null, tFirstToken: null, prefetchHit: false };
    }

    log('RagHook', `interceptor enter chatLen=${messages.length} prefetchLen=${_prefetchChatLen} source=${settings.ragEmbeddingSource ?? '(unset)'} model=${settings.ragEmbeddingModel ?? '(unset)'}`);

    // ST may append an AI placeholder message after MESSAGE_SENT and before
    // the interceptor, so allow up to +2 before declaring the prefetch stale.
    const prefetchValid = _prefetchPromise !== null
        && _prefetchChatLen >= 0
        && messages.length >= _prefetchChatLen
        && messages.length <= _prefetchChatLen + 2;

    let result = null;
    if (prefetchValid) {
        const tAwait = performance.now();
        result = await _prefetchPromise;
        const awaitMs = performance.now() - tAwait;
        if (_timing) _timing.prefetchHit = awaitMs < 50;
        log('RagHook', `prefetch awaited in ${Math.round(awaitMs)}ms (${awaitMs < 50 ? 'HIT' : 'MISS'})`);
    }
    _prefetchPromise = null;
    _prefetchChatLen = -1;

    if (!result) {
        try {
            result = await _doRagFetch(ctx, settings, chain);
        } catch (err) {
            error('RagHook', 'Failed to query CNZ vector store:', err);
            _timing = null;
            return;
        }
    }

    const tRagDone = performance.now();
    if (_timing) _timing.tRagDone = tRagDone;
    log('RagHook', `${result.chunks} chunks injected | rag=${Math.round(tRagDone - tInterceptor)}ms`);
    ctx.setExtensionPrompt(EXT_PROMPT_KEY, result.injection, INJECT_POSITION, result.depth);

    if (result.toActivate.length) {
        log('RagHook', `Semantic LB activation: ${result.toActivate.length} entries`);
        try {
            await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, result.toActivate);
        } catch (err) {
            error('RagHook', 'Lorebook semantic activation failed:', err);
        }
    }

    // ── Timing: one-shot listeners for first token and generation end ──────────
    eventSource.once(event_types.STREAM_TOKEN_RECEIVED, () => {
        if (_timing && !_timing.tFirstToken) _timing.tFirstToken = performance.now();
    });
    eventSource.once(event_types.GENERATION_ENDED, () => _printTimingSummary(performance.now()));
}
