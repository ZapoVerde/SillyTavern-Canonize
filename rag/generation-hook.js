/**
 * @file data/default-user/extensions/canonize/rag/generation-hook.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
 * @version 2.4.0
 * @architectural-role IO Wrapper
 * @description
 * Prefetch-optimised RAG retrieval lifecycle. Owns the prefetch promise,
 * the AbortController for in-flight embed requests, and ST event wiring.
 *
 * On MESSAGE_SENT: prefetchRag() fires doRagFetch() immediately so embed
 * round-trips run concurrently with ST's message-save pipeline.
 * On GENERATION_STARTED (via cnzMaskMessages): awaits the already-in-flight
 * promise rather than starting fresh. Swipe/regen fall back to a fresh fetch.
 * On GENERATION_STOPPED: aborts the in-flight controller so cnzMaskMessages
 * returns immediately instead of waiting for a full embed round-trip.
 *
 * @api-declaration
 * prefetchRag()
 * onGenerationStarted()
 * resetRagState(ctx)   — clears stale prefetch + extension prompt on chat change
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [_prefetchPromise, _prefetchChatLen, _abortController]
 *     external_io: [rag-fetch.js, setExtensionPrompt, WORLDINFO_FORCE_ACTIVATE]
 */

import { state }             from '../state.js';
import { getSettings }       from '../core/settings.js';
import { doRagFetch }        from './rag-fetch.js';
import { log, error }        from '../log.js';
import { eventSource, event_types } from '../../../../../script.js';

const EXT_PROMPT_KEY  = 'cnz_rag';
const INJECT_POSITION = 2;

let _prefetchPromise  = null;
let _prefetchChatLen  = -1;
let _abortController  = null;

// ── Timing ────────────────────────────────────────────────────────────────────

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

// ── Abort helpers ─────────────────────────────────────────────────────────────

function _newController() {
    _abortController = new AbortController();
    return _abortController.signal;
}

function _abortCurrent() {
    if (_abortController) {
        _abortController.abort();
        _abortController = null;
    }
}

// Abort in-flight embed requests the moment the user hits stop.
// cnzMaskMessages is awaiting _prefetchPromise at that point; aborting the
// fetch makes it reject with AbortError, which we catch and treat as a clean
// cancellation so the mask function returns immediately.
eventSource.on(event_types.GENERATION_STOPPED, () => {
    if (_prefetchPromise) {
        log('RagHook', 'GENERATION_STOPPED — aborting in-flight embed');
        _abortCurrent();
    }
});

// ── Public API ────────────────────────────────────────────────────────────────

export function resetRagState(ctx) {
    _abortCurrent();
    _prefetchPromise = null;
    _prefetchChatLen = -1;
    _timing          = null;
    ctx?.setExtensionPrompt?.(EXT_PROMPT_KEY, '', INJECT_POSITION, 0);
}

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
    const signal     = _newController();
    _prefetchPromise = doRagFetch(ctx, settings, chain, signal).catch(err => {
        if (err.name === 'AbortError') {
            log('RagHook', 'Prefetch aborted');
            return null;
        }
        error('RagHook', 'Prefetch failed:', err);
        return null;
    });
}

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
        _timing = { tSend: null, tInterceptor: tInterceptor, tRagDone: null, tFirstToken: null, prefetchHit: false };
    }

    log('RagHook', `interceptor enter chatLen=${messages.length} prefetchLen=${_prefetchChatLen} source=${settings.ragEmbeddingSource ?? '(unset)'} model=${settings.ragEmbeddingModel ?? '(unset)'}`);

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
            const signal = _newController();
            result = await doRagFetch(ctx, settings, chain, signal);
        } catch (err) {
            if (err.name !== 'AbortError')
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

    eventSource.once(event_types.STREAM_TOKEN_RECEIVED, () => {
        if (_timing && !_timing.tFirstToken) _timing.tFirstToken = performance.now();
    });
    eventSource.once(event_types.GENERATION_ENDED, () => _printTimingSummary(performance.now()));
}
