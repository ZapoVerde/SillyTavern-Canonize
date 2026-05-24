/**
 * @file data/default-user/extensions/canonize/lifecycle.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * Mount/unmount lifecycle for the CNZ extension. Binds and unbinds all dynamic
 * assets (ST event listeners, DOM, scheduler, bus, prompt stack, embed monitor)
 * as a coordinated unit. No business logic — delegates entirely to module-specific
 * primitives.
 *
 * @api-declaration
 * initLifecycle()  — call once at boot; activates CNZ if enableCnz is true.
 * mountCnz()       — activate: bind listeners, inject UI, start scheduler, provision prompts.
 * unmountCnz()     — deactivate: unbind listeners, remove UI, stop scheduler, purge prompts.
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [_lorebookEditTimer, _embedAbortCtrl]
 *     external_io: [ST eventSource, DOM, bus, scheduler, promptManager, embed SSE stream]
 */

import { eventSource, event_types } from '../../../../script.js';
import { setBusEnabled } from './bus.js';
import { startScheduler, stopScheduler, snooze } from './scheduler.js';
import { state, CNZ_SUMMARY_ID, CNZ_RAG_ID } from './state.js';
import { getSettings, getMetaSettings } from './core/settings.js';
import { onChatChanged } from './core/session.js';
import { prefetchRag } from './rag/generation-hook.js';
import { lbGetLorebook } from './lorebook/api.js';
import {
    getCnzPromptManager, ensureCnzSummaryPrompt, syncCnzSummaryOnCharacterSwitch,
    ensureCnzRagPrompt, removeCnzPromptFromStack,
} from './core/summary-prompt.js';
import { injectWandButton } from './wand.js';
import { openReviewModal } from './modal/orchestrator.js';
import { openOrphanModal } from './modal/orphan-modal.js';
import { runCnzSync } from './core/sync.js';
import { invalidateAllJobs } from './cycleStore.js';
import { log, error } from './log.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _lorebookEditTimer = null;
let _embedAbortCtrl    = null;

// ── Named ST event handlers (required for eventSource.off) ───────────────────

function _onMessageSent() {
    prefetchRag();
}

function _onWorldInfoUpdated(name) {
    if (name !== state._lorebookName) return;
    clearTimeout(_lorebookEditTimer);
    _lorebookEditTimer = setTimeout(async () => {
        if (state._lorebookName !== name) return;
        try {
            const fresh = await lbGetLorebook(name);
            state._draftLorebook           = structuredClone(fresh);
            state._lorebookData            = structuredClone(fresh);
            state._lastIndexedLorebookHash = '';
            if (!state._dnaChain?.lkg) return;
            const chatMsgs  = SillyTavern.getContext().chat ?? [];
            const anchorMsg = chatMsgs[state._dnaChain.lkgMsgIdx];
            if (!anchorMsg?.extra?.cnz) return;
            anchorMsg.extra.cnz = Object.assign({}, anchorMsg.extra.cnz, {
                lorebook: Object.assign({ name }, structuredClone(state._draftLorebook)),
            });
            await SillyTavern.getContext().saveChat();
        } catch (err) {
            error('Lorebook', 'WORLDINFO_UPDATED handler failed:', err);
        }
    }, 7000);
}

// ── Embed monitor ─────────────────────────────────────────────────────────────

const EMBED_THRESHOLD = 20;

async function _startEmbedMonitor(signal) {
    let _toast = null;

    function _update({ total, done }) {
        if (total > EMBED_THRESHOLD) {
            const msg = `CNZ: Embedding ${done}/${total}...`;
            if (_toast?.is(':visible')) {
                _toast.find('.toast-message').text(msg);
            } else {
                _toast = toastr.info(msg, '', { timeOut: 0, extendedTimeOut: 0 });
            }
        } else if (_toast) {
            toastr.clear(_toast);
            _toast = null;
        }
    }

    try {
        const { getRequestHeaders } = await import('../../../../script.js');
        const res = await fetch('/api/plugins/cnz/embed-stream', {
            headers: getRequestHeaders(),
            signal,
        });
        if (!res.ok) return;

        const reader  = res.body.getReader();
        const decoder = new TextDecoder();
        let   buf     = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const parts = buf.split('\n\n');
            buf = parts.pop();
            for (const part of parts) {
                if (part.startsWith('data: ')) {
                    try { _update(JSON.parse(part.slice(6))); } catch { /* malformed */ }
                }
            }
        }
    } catch { /* plugin not installed, stream closed, or aborted — exit silently */ }
}

// ── Mount / Unmount ───────────────────────────────────────────────────────────

export function mountCnz() {
    log('Lifecycle', 'mountCnz: starting...');

    setBusEnabled(true);
    startScheduler();

    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);
    eventSource.on(event_types.MESSAGE_SENT,      _onMessageSent);
    eventSource.on(event_types.WORLDINFO_UPDATED, _onWorldInfoUpdated);
    log('Lifecycle', 'Bound ST: CHAT_CHANGED, MESSAGE_SENT, WORLDINFO_UPDATED.');

    $(document).on('click', '.cnz-review-link',   (e) => { e.preventDefault(); openReviewModal(); });
    $(document).on('click', '.cnz-orphan-review',  (e) => { e.preventDefault(); toastr.clear(); openOrphanModal(state._pendingOrphans); });
    $(document).on('click', '.cnz-orphan-dismiss', (e) => { e.preventDefault(); toastr.clear(); });
    $(document).on('click', '.cnz-gap-sync-all',   (e) => {
        e.preventDefault(); toastr.clear();
        const ctx = SillyTavern.getContext();
        if (!ctx || ctx.characterId == null) return;
        runCnzSync(ctx.characters[ctx.characterId], ctx.chat ?? [], { coverAll: true })
            .catch(err => error('Sync', 'Gap sync-all failed:', err));
    });
    $(document).on('click', '.cnz-gap-snooze', (e) => {
        e.preventDefault(); toastr.clear();
        invalidateAllJobs();
        const ctx       = SillyTavern.getContext();
        const messages  = ctx?.chat ?? [];
        const pairCount = messages.filter(m => !m.is_system && m.is_user).length;
        snooze(getSettings().gapSnoozeTurns ?? 5, pairCount);
    });
    log('Lifecycle', 'Bound DOM: .cnz-review-link, .cnz-orphan-review, .cnz-orphan-dismiss, .cnz-gap-sync-all, .cnz-gap-snooze.');

    injectWandButton();
    log('Lifecycle', 'Wand button injected.');

    const pm = getCnzPromptManager();
    if (pm) {
        ensureCnzSummaryPrompt(pm);
        ensureCnzRagPrompt(pm);
        const ctx  = SillyTavern.getContext();
        const char = ctx?.characterId != null ? ctx.characters[ctx.characterId] : null;
        syncCnzSummaryOnCharacterSwitch(char, state._dnaChain);
        log('Lifecycle', `Prompt stack: ensured ${CNZ_SUMMARY_ID}, ${CNZ_RAG_ID}${char ? ` — synced to "${char.name}"` : ' (no character)'}.`);
    } else {
        log('Lifecycle', 'Prompt stack: PromptManager unavailable — skipping provisioning.');
    }

    _embedAbortCtrl = new AbortController();
    _startEmbedMonitor(_embedAbortCtrl.signal);
    log('Lifecycle', 'Embed monitor started.');

    log('Lifecycle', 'mountCnz: complete.');
}

export function unmountCnz() {
    log('Lifecycle', 'unmountCnz: starting...');

    setBusEnabled(false);
    stopScheduler();

    eventSource.off(event_types.CHAT_CHANGED,     onChatChanged);
    eventSource.off(event_types.MESSAGE_SENT,      _onMessageSent);
    eventSource.off(event_types.WORLDINFO_UPDATED, _onWorldInfoUpdated);
    log('Lifecycle', 'Unbound ST: CHAT_CHANGED, MESSAGE_SENT, WORLDINFO_UPDATED.');

    $(document).off('click', '.cnz-review-link');
    $(document).off('click', '.cnz-orphan-review');
    $(document).off('click', '.cnz-orphan-dismiss');
    $(document).off('click', '.cnz-gap-sync-all');
    $(document).off('click', '.cnz-gap-snooze');
    log('Lifecycle', 'Unbound DOM: .cnz-review-link, .cnz-orphan-review, .cnz-orphan-dismiss, .cnz-gap-sync-all, .cnz-gap-snooze.');

    $('#cnz-wand-btn').remove();
    log('Lifecycle', 'Wand button removed.');

    clearTimeout(_lorebookEditTimer);
    _lorebookEditTimer = null;
    log('Lifecycle', 'Lorebook debounce timer cleared.');

    if (_embedAbortCtrl) {
        _embedAbortCtrl.abort();
        _embedAbortCtrl = null;
        log('Lifecycle', 'Embed monitor aborted.');
    } else {
        log('Lifecycle', 'Embed monitor was not running.');
    }

    const pm = getCnzPromptManager();
    if (pm) {
        removeCnzPromptFromStack(pm, CNZ_SUMMARY_ID);
        removeCnzPromptFromStack(pm, CNZ_RAG_ID);
        log('Lifecycle', `Prompt stack: removed ${CNZ_SUMMARY_ID}, ${CNZ_RAG_ID}.`);
    } else {
        log('Lifecycle', 'Prompt stack: PromptManager unavailable — stack not purged.');
    }

    log('Lifecycle', 'unmountCnz: complete.');
    toastr.success('Canonize disabled and prompt stack cleared.');
}

export function initLifecycle() {
    if (getMetaSettings().enableCnz !== false) {
        log('Lifecycle', 'initLifecycle: CNZ enabled — mounting.');
        mountCnz();
    } else {
        log('Lifecycle', 'initLifecycle: CNZ disabled — skipping mount.');
    }
}
