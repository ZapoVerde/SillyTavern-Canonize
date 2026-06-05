/**
 * @file data/default-user/extensions/canonize/lifecycle.js
 * @stamp {"utc":"2026-06-04T16:10:00.000Z"}
 * @version 1.2.1
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
 *     state_ownership: [_lorebookEditTimer, _plotEditTimer, _embedToast]
 *     external_io: [ST eventSource, DOM, bus, scheduler, promptManager]
 */

import { eventSource, event_types } from '../../../../script.js';
import { setBusEnabled, on, off, BUS_EVENTS } from './bus.js';
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
import { getStringHash } from '../../../utils.js';
import { cnzGetActiveChatKey } from './rag/api.js';
import { insertLorebookEntries } from './rag/file-store-lb.js';

// ── Module state ──────────────────────────────────────────────────────────────

let _lorebookEditTimer = null;
let _plotEditTimer     = null;

// ── Named ST event handlers (required for eventSource.off) ───────────────────

function _onMessageSent() {
    prefetchRag();
}

function _onWorldInfoUpdated(name) {
    log('LbWatch', `WORLDINFO_UPDATED: "${name}" (tracking lb="${state._lorebookName ?? '—'}" plot="${state._plotLorebookName ?? '—'}")`);

    if (name === state._lorebookName) {
        log('LbWatch', `Lorebook match — debouncing 7s`);
        clearTimeout(_lorebookEditTimer);
        _lorebookEditTimer = setTimeout(async () => {
            if (state._lorebookName !== name) { log('LbWatch', `Lorebook debounce: name changed, aborting`); return; }
            log('LbWatch', `Lorebook debounce fired — fetching fresh copy`);
            try {
                const fresh = await lbGetLorebook(name);
                const entryCount = Object.keys(fresh.entries ?? {}).length;
                log('LbWatch', `Lorebook fetched: ${entryCount} entries`);
                state._draftLorebook           = structuredClone(fresh);
                state._lorebookData            = structuredClone(fresh);
                state._lastIndexedLorebookHash = '';
                if (!state._dnaChain?.lkg) { log('LbWatch', `No LKG anchor — skipping chain patch`); return; }
                const chatMsgs  = SillyTavern.getContext().chat ?? [];
                const anchorMsg = chatMsgs[state._dnaChain.lkgMsgIdx];
                if (!anchorMsg?.extra?.cnz) { log('LbWatch', `Anchor message missing CNZ data — skipping`); return; }
                anchorMsg.extra.cnz = Object.assign({}, anchorMsg.extra.cnz, {
                    lorebook: Object.assign({ name }, structuredClone(state._draftLorebook)),
                });
                await SillyTavern.getContext().saveChat();
                log('LbWatch', `Lorebook patched into anchor ${state._dnaChain.lkg.uuid?.slice(0, 8)} and chat saved`);
            } catch (err) {
                error('Lorebook', 'WORLDINFO_UPDATED handler failed:', err);
            }
        }, 7000);
    }

    if (name === state._plotLorebookName) {
        log('LbWatch', `Plot lorebook match — debouncing 7s`);
        clearTimeout(_plotEditTimer);
        _plotEditTimer = setTimeout(() => _applyPlotLorebookEdits(name), 7000);
    }

    if (name !== state._lorebookName && name !== state._plotLorebookName) {
        log('LbWatch', `No match — ignored`);
    }
}

async function _applyPlotLorebookEdits(name) {
    if (state._plotLorebookName !== name) return;
    log('LbWatch', `Plot debounce fired — fetching "${name}"`);
    try {
        const fresh   = await lbGetLorebook(name);
        const anchors = state._dnaChain?.anchors ?? [];
        const incomingCount = Object.keys(fresh.entries ?? {}).length;
        log('LbWatch', `Plot lorebook fetched: ${incomingCount} entries — scanning ${anchors.length} anchors`);
        if (!anchors.length) { log('LbWatch', `No anchors in chain — aborting`); return; }

        const idx = new Map();
        for (const ref of anchors) {
            (ref.anchor.plotEntries ?? []).forEach((e, i) =>
                idx.set(e.uid, { ref, i, hash: getStringHash(`${e.comment ?? ''}|${e.content ?? ''}`) })
            );
        }
        log('LbWatch', `Chain index built: ${idx.size} plot entries across ${anchors.length} anchors`);

        const changed = [];
        for (const [k, de] of Object.entries(fresh.entries ?? {})) {
            const uid  = parseInt(k, 10);
            const slot = idx.get(uid);
            if (!slot) { log('LbWatch', `UID ${uid} not in chain index — skipping`); continue; }
            if (getStringHash(`${de.comment ?? ''}|${de.content ?? ''}`) === slot.hash) continue;
            log('LbWatch', `UID ${uid} "${de.comment}" — hash mismatch, queuing patch`);
            changed.push({ uid, de, ref: slot.ref, i: slot.i });
        }
        log('LbWatch', `Diff complete: ${changed.length} changed, ${idx.size - changed.length} unchanged`);
        if (!changed.length) { log('LbWatch', `Nothing to patch`); return; }

        const msgs = SillyTavern.getContext().chat ?? [];
        for (const { uid, de, ref, i } of changed) {
            const m = msgs[ref.msgIdx];
            if (m?.extra?.cnz?.plotEntries) {
                m.extra.cnz.plotEntries[i] = { uid, content: de.content ?? '', comment: de.comment ?? '' };
                log('LbWatch', `Patched UID ${uid} into anchor ${ref.anchor.uuid?.slice(0, 8)} entry[${i}]`);
            }
        }
        await SillyTavern.getContext().saveChat();
        log('LbWatch', `Chat saved — ${changed.length} plot entry/entries locked into DNA chain`);

        {
            const ctx  = SillyTavern.getContext();
            const char = ctx.characters[ctx.characterId];
            if (!char) { log('LbWatch', `No character selected — skipping re-vector`); return; }
            const ck       = cnzGetActiveChatKey();
            const byAnchor = new Map();
            for (const { uid, de, ref } of changed) {
                if (!byAnchor.has(ref.anchor.uuid)) byAnchor.set(ref.anchor.uuid, []);
                byAnchor.get(ref.anchor.uuid).push({ uid, content: de.content ?? '', comment: de.comment ?? '' });
            }
            log('LbWatch', `Re-vectoring across ${byAnchor.size} anchor(s)`);
            for (const [uuid, entries] of byAnchor) {
                try {
                    if (ck) await insertLorebookEntries(ck, uuid, name, entries);
                    log('LbWatch', `Re-vectored ${entries.length} entries for anchor ${uuid.slice(0, 8)}`);
                } catch (err) { error('PlotLb', `Re-vector failed (${uuid}):`, err); }
            }
            log('LbWatch', `Re-vector complete`);
        }
    } catch (err) {
        error('PlotLb', 'Plot lorebook edit handler failed:', err);
    }
}

// ─── Embed progress monitor ────────────────────────────────────────────────────

const EMBED_THRESHOLD = 20;
let _embedToast = null;

function _onEmbedProgress({ total, done }) {
    if (total > EMBED_THRESHOLD && done < total) {
        const msg = `CNZ: Embedding ${done}/${total}...`;
        if (_embedToast?.is(':visible')) {
            _embedToast.find('.toast-message').text(msg);
        } else {
            _embedToast = toastr.info(msg, '', { timeOut: 0, extendedTimeOut: 0 });
        }
    } else if (_embedToast) {
        toastr.clear(_embedToast);
        _embedToast = null;
    }
}

// ─── Mount / Unmount ───────────────────────────────────────────────────────────

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
        snooze(1, pairCount);
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

    on(BUS_EVENTS.EMBED_PROGRESS, _onEmbedProgress);
    log('Lifecycle', 'Embed monitor started.');

    // Run onChatChanged immediately to catch up if a chat is already loaded on boot
    onChatChanged();

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
    clearTimeout(_plotEditTimer);
    _plotEditTimer     = null;
    log('Lifecycle', 'Lorebook and plot edit timers cleared.');

    off(BUS_EVENTS.EMBED_PROGRESS, _onEmbedProgress);
    if (_embedToast) { toastr.clear(_embedToast); _embedToast = null; }
    log('Lifecycle', 'Embed monitor detached.');

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