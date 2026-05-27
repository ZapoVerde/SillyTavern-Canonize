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
 *     external_io: [rag-fetch.js, writeCnzRagPrompt, clearCnzRagPrompt, WORLDINFO_FORCE_ACTIVATE]
 */

import { state }             from '../state.js';
import { getSettings }       from '../core/settings.js';
import { isPluginReachable } from './plugin-health.js';
import { doRagFetch }        from './rag-fetch.js';
import { insertLorebookEntries } from './vec-store.js';
import { cnzAvatarKey }      from './api.js';
import { getStringHash }     from '../../../../utils.js';
import { stripProtectedBlock } from '../lorebook/utils.js';
import { log, error }        from '../log.js';
import { eventSource, event_types } from '../../../../../script.js';
import { writeCnzRagPrompt, clearCnzRagPrompt } from '../core/summary-prompt.js';

let _prefetchPromise  = null;
let _prefetchChatLen  = -1;
let _abortController  = null;
let _swipeCache       = null; // { key, result } — reused across swipes at same position

// Hash the recent message window — detects both count changes and content edits.
function _swipeCacheKey(messages, horizonPairs) {
    const recent = messages.slice(-(horizonPairs * 2 + 2));
    return `${messages.length}:${getStringHash(recent.map(m => m.mes ?? '').join('\n'))}`;
}

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

function _abortCurrent(reason = 'unknown') {
    if (_abortController) {
        log('RagHook', `abort: controller fired (reason=${reason})`);
        _abortController.abort();
        _abortController = null;
    } else {
        log('RagHook', `abort: no controller active (reason=${reason}) — no-op`);
    }
}

// Abort in-flight embed requests the moment the user hits stop.
// cnzMaskMessages is awaiting _prefetchPromise at that point; aborting the
// fetch makes it reject with AbortError, which we catch and treat as a clean
// cancellation so the mask function returns immediately.
eventSource.on(event_types.GENERATION_STOPPED, () => {
    log('RagHook', `GENERATION_STOPPED — prefetchInFlight=${_prefetchPromise !== null} controller=${_abortController !== null} prefetchChatLen=${_prefetchChatLen}`);
    _abortCurrent('generation_stopped');
});

// ── Public API ────────────────────────────────────────────────────────────────

export function resetRagState() {
    log('RagHook', `resetRagState — prefetchInFlight=${_prefetchPromise !== null} controller=${_abortController !== null}`);
    _abortCurrent('chat_changed');
    _prefetchPromise = null;
    _prefetchChatLen = -1;
    _swipeCache      = null;
    _timing          = null;
    clearCnzRagPrompt();
}

export function prefetchRag() {
    const settings = getSettings();
    if (!settings.enableRag || !isPluginReachable()) return;
    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) return;
    const ctx      = SillyTavern.getContext();
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    // New message invalidates any cached swipe result — context has changed.
    _swipeCache = null;
    log('RagHook', `MESSAGE_SENT → prefetch start (chatLen=${messages.length}) t=${Date.now()}`);
    _timing          = { tSend: performance.now(), tInterceptor: null, tRagDone: null, tFirstToken: null, prefetchHit: false };
    _prefetchChatLen = messages.length;
    const signal     = _newController();
    window.loggeryze?.time('CNZ prefetch [non-blocking]');
    _prefetchPromise = doRagFetch(ctx, settings, chain, signal)
        .then(result => {
            window.loggeryze?.timeEnd('CNZ prefetch [non-blocking]');
            return result;
        })
        .catch(err => {
            window.loggeryze?.timeEnd('CNZ prefetch [non-blocking]');
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
    if (!settings.enableRag || !isPluginReachable()) {
        clearCnzRagPrompt();
        return;
    }
    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) {
        clearCnzRagPrompt();
        return;
    }
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    // JIT hash guard: re-vector if lorebook changed since last index
    if (state._draftLorebook && state._lorebookName) {
        const hashStr = Object.values(state._draftLorebook.entries ?? {})
            .sort((a, b) => a.uid - b.uid)
            .map(e => `${e.uid}|${e.comment ?? ''}|${(e.key ?? []).join(',')}|${stripProtectedBlock(e.content ?? '')}`)
            .join('\n');
        const currentHash = String(getStringHash(hashStr));
        if (currentHash !== state._lastIndexedLorebookHash) {
            if (state._lastIndexedLorebookHash === null) {
                // Session start: sync maintains the index between sessions, just seed the hash.
                log('RagHook', 'JIT: session start — seeding hash, skipping re-index');
                state._lastIndexedLorebookHash = currentHash;
            } else {
                // Lorebook changed mid-session: re-index now.
                _prefetchPromise = null;
                const lkgUuid = state._dnaChain?.lkg?.uuid;
                if (lkgUuid) {
                    const char    = ctx.characters[ctx.characterId];
                    const entries = Object.values(state._draftLorebook.entries ?? {})
                        .filter(e => !e.disable && e.content?.trim())
                        .map(e => ({ uid: e.uid, content: e.content, keys: e.key ?? [], comment: e.comment ?? '' }));
                    try {
                        window.loggeryze?.time('CNZ JIT re-index [blocking]');
                        await insertLorebookEntries(cnzAvatarKey(char?.avatar ?? ''), lkgUuid, state._lorebookName, entries);
                        window.loggeryze?.timeEnd('CNZ JIT re-index [blocking]');
                        state._lastIndexedLorebookHash = currentHash;
                    } catch (err) {
                        window.loggeryze?.timeEnd('CNZ JIT re-index [blocking]');
                        error('RagHook', 'JIT lorebook re-vector failed:', err);
                    }
                }
            }
        }
    }

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

    // Swipe cache: same position and same content — result is identical, skip embed entirely.
    const cacheKey = _swipeCacheKey(messages, settings.ragClassifierHistory ?? 3);
    if (_swipeCache && _swipeCache.key === cacheKey) {
        log('RagHook', `swipe cache HIT (chatLen=${messages.length}) — skipping embed`);
        const cached = _swipeCache.result;
        if (cached.injection) writeCnzRagPrompt(cached.injection);
        else clearCnzRagPrompt();
        return;
    }

    let result = null;
    const wasColdFetch = !prefetchValid;
    window.loggeryze?.time('CNZ embed+query [blocking]');
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
            window.loggeryze?.timeEnd('CNZ embed+query [blocking]');
            if (err.name === 'AbortError') {
                log('RagHook', `fresh-fetch aborted — mask function returning early, send button unblocked`);
            } else {
                error('RagHook', 'Failed to query CNZ vector store:', err);
            }
            _timing = null;
            return;
        }
    }
    window.loggeryze?.timeEnd('CNZ embed+query [blocking]');

    // Cache result keyed by content hash so edits correctly invalidate it.
    _swipeCache = { key: cacheKey, result };

    // Warm-ahead: after a cold fetch (swipe/regen with no prefetch), immediately
    // kick off the next embed so it runs during streaming and the following swipe
    // finds a prefetch already in flight instead of starting cold.
    if (wasColdFetch && result) {
        const wCtx      = SillyTavern.getContext();
        const wMessages = wCtx.chat ?? [];
        if (wMessages.length) {
            log('RagHook', `warm-ahead prefetch started (chatLen=${wMessages.length})`);
            _prefetchChatLen = wMessages.length;
            const wSignal    = _newController();
            window.loggeryze?.time('CNZ prefetch [non-blocking]');
            _prefetchPromise = doRagFetch(wCtx, settings, chain, wSignal)
                .then(r  => { window.loggeryze?.timeEnd('CNZ prefetch [non-blocking]'); return r; })
                .catch(err => {
                    window.loggeryze?.timeEnd('CNZ prefetch [non-blocking]');
                    if (err.name === 'AbortError') { log('RagHook', 'Warm-ahead aborted'); return null; }
                    error('RagHook', 'Warm-ahead failed:', err);
                    return null;
                });
        }
    }

    const tRagDone = performance.now();
    if (_timing) _timing.tRagDone = tRagDone;
    log('RagHook', `${result.chunks} chunks injected | rag=${Math.round(tRagDone - tInterceptor)}ms`);
    if (result.injection) {
        writeCnzRagPrompt(result.injection);
    } else {
        clearCnzRagPrompt();
    }

    if (result.toActivate.length) {
        log('RagHook', `Semantic LB activation: ${result.toActivate.length} entries`);
        try {
            window.loggeryze?.time('CNZ LB activate [blocking]');
            await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, result.toActivate);
            window.loggeryze?.timeEnd('CNZ LB activate [blocking]');
        } catch (err) {
            window.loggeryze?.timeEnd('CNZ LB activate [blocking]');
            error('RagHook', 'Lorebook semantic activation failed:', err);
        }
    }

    eventSource.once(event_types.STREAM_TOKEN_RECEIVED, () => {
        if (_timing && !_timing.tFirstToken) _timing.tFirstToken = performance.now();
    });
    eventSource.once(event_types.GENERATION_ENDED, () => _printTimingSummary(performance.now()));
}
