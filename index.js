/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.3.0
 * @architectural-role Orchestrator
 * @description
 * SillyTavern Narrative Engine (CNZ) — extension entry point.
 * Registers ST event listeners, bus subscribers, and injects persistent UI.
 * Contains no business logic — all behaviour lives in imported modules.
 *
 * @api-declaration
 * init() — called once on extension load
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [ST eventSource, DOM]
 */

import { eventSource, event_types } from '../../../../script.js';
import { on, BUS_EVENTS } from './bus.js';
import { log, error } from './log.js';
import { invalidateAllJobs } from './cycleStore.js';
import { initScheduler, isSyncInProgress, snooze, getGap } from './scheduler.js';
import { Triggers } from './recipes.js';
import './executor.js';
import './logger.js';
import { state } from './state.js';
import { getSettings, initSettings } from './core/settings.js';
import { initSceneTracker } from './core/scene-tracker.js';
import { readDnaChain } from './core/dna-chain.js';
import { runCnzSync } from './core/sync.js';
import { onChatChanged } from './core/session.js';
import { lbGetLorebook } from './lorebook/api.js';
import { writeChunkHeaderToChat, renderChunkChatLabel } from './rag/chat-labels.js';
import { onGenerationStarted, prefetchRag } from './rag/generation-hook.js';
import { injectModal } from './modal/modal-setup.js';
import { openReviewModal } from './modal/orchestrator.js';
import { openOrphanModal } from './modal/orphan-modal.js';
import { renderRagCard } from './modal/rag-workshop.js';
import { injectWandButton, onWandButtonClick } from './wand.js';
import { injectSettingsPanel } from './settings/panel.js';

log('Module', 'index.js: Module loaded (all imports resolved).');

let _lorebookEditTimer = null;

async function init() {
    log('Init', 'Starting sequence...');
    try {
        initSettings();
        log('Init', 'Settings initialized.');
        initSceneTracker();
        log('Init', 'Scene tracker initialized.');
        initScheduler(Triggers, getSettings);
        log('Init', 'Scheduler initialized.');
        injectModal();
        log('Init', 'Modal injected.');
        injectSettingsPanel();
        log('Init', 'Settings panel injected.');
        injectWandButton();
        log('Init', 'Wand button injected.');

        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        eventSource.on(event_types.MESSAGE_SENT, () => prefetchRag());
        eventSource.on(event_types.WORLDINFO_UPDATED, (name) => {
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
        });

        $(document).on('click', '.cnz-review-link', (e) => {
            e.preventDefault();
            openReviewModal();
        });
        $(document).on('click', '.cnz-orphan-review', (e) => {
            e.preventDefault();
            toastr.clear();
            openOrphanModal(state._pendingOrphans);
        });
        $(document).on('click', '.cnz-orphan-dismiss', (e) => {
            e.preventDefault();
            toastr.clear();
        });
        $(document).on('click', '.cnz-gap-sync-all', (e) => {
            e.preventDefault();
            toastr.clear();
            const ctx = SillyTavern.getContext();
            if (!ctx || ctx.characterId == null) return;
            runCnzSync(ctx.characters[ctx.characterId], ctx.chat ?? [], { coverAll: true })
                .catch(err => error('Sync', 'Gap sync-all failed:', err));
        });
        $(document).on('click', '.cnz-gap-snooze', (e) => {
            e.preventDefault();
            toastr.clear();
            invalidateAllJobs();
            const ctx         = SillyTavern.getContext();
            const messages    = ctx?.chat ?? [];
            const pairCount   = messages.filter(m => !m.is_system && m.is_user).length;
            const snoozePairs = getSettings().gapSnoozeTurns ?? 5;
            snooze(snoozePairs, pairCount);
        });

        // ── Bus subscribers ───────────────────────────────────────────────────

        on(BUS_EVENTS.CONTRACT_DISPATCHED, ({ recipeId, inputs }) => {
            if (recipeId !== 'rag_classifier') return;
            const chunk = state._ragChunks[inputs?.chunkIndex];
            if (!chunk) return;
            chunk.status = 'in-flight';
            renderRagCard(inputs.chunkIndex);
        });

        on(BUS_EVENTS.CYCLE_STORE_UPDATED, ({ key, value }) => {
            if (key !== 'rag_chunk_results' || !value) return;
            for (const { chunkIndex, header } of value) {
                const chunk = state._ragChunks[chunkIndex];
                if (!chunk) continue;
                if (header == null) {
                    chunk.status = 'pending';
                } else {
                    chunk.header = header.trim() || chunk.turnRange;
                    chunk.status = 'complete';
                    writeChunkHeaderToChat(chunkIndex).catch(err =>
                        error('Rag', 'writeChunkHeaderToChat error:', err));
                }
                renderRagCard(chunkIndex);
                renderChunkChatLabel(chunkIndex);
            }
        });

        on(BUS_EVENTS.SYNC_TRIGGERED, ({ char, messages, gap, every, trailingBoundary, largeGap }) => {
            log('Sync', `══ SYNC TRIGGERED ══ gap=${gap}/${every} largeGap=${largeGap} char="${char?.name}"`);
            if (!largeGap) {
                if (isSyncInProgress()) return;
                runCnzSync(char, messages).catch(err =>
                    error('Sync', 'runCnzSync uncaught error:', err),
                );
                return;
            }

            if (isSyncInProgress()) return;
            (async () => {
                try {
                    await runCnzSync(char, messages);
                } catch (err) {
                    error('Sync', 'runCnzSync uncaught error:', err);
                    return;
                }

                const freshChain = readDnaChain(messages);
                const newLkgIdx  = freshChain.lkgMsgIdx;
                const newPrior   = newLkgIdx >= 0
                    ? messages.slice(0, newLkgIdx + 1).filter(m => !m.is_system && m.is_user).length
                    : 0;
                const remaining = trailingBoundary - newPrior;
                if (remaining < every) return;

                const snoozePairs = getSettings().gapSnoozeTurns ?? 5;
                toastr.warning(
                    `CNZ: ${remaining} uncaptured pair(s). ` +
                    `<a href="#" class="cnz-gap-sync-all">Sync all</a> &nbsp; ` +
                    `<a href="#" class="cnz-gap-snooze">Snooze ${snoozePairs} pairs</a>`,
                    '',
                    { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
                );
            })();
        });

        globalThis.cnzMaskMessages = async function(chat, _contextSize, _abort, type) {
            if (getSettings().autoAdvanceMask) {
                const IGNORE = SillyTavern.getContext().symbols.ignore;
                let anchorIdx = -1;
                for (let i = chat.length - 2; i >= 0; i--) {
                    if (chat[i]?.extra?.cnz?.type === 'anchor') { anchorIdx = i; break; }
                }
                if (anchorIdx >= 0) {
                    for (let i = 0; i <= anchorIdx; i++) {
                        chat[i] = structuredClone(chat[i]);
                        chat[i].extra ??= {};
                        chat[i].extra[IGNORE] = true;
                    }
                }
            }
            if (type !== 'quiet') {
                await onGenerationStarted().catch(err => error('RagHook', err));
            }
        };

        startEmbedMonitor();
        log('Init', 'Full sequence complete.');
    } catch (err) {
        error('Init', 'CRITICAL FAILURE during init:', err);
    }
}

// ── Embed progress monitor ────────────────────────────────────────────────────
// Connects to the plugin's SSE stream. The plugin pushes a stat update whenever
// the embed queue changes — no polling. If the plugin isn't installed the fetch
// rejects and the monitor exits cleanly without retrying.
async function startEmbedMonitor() {
    const THRESHOLD = 20; // matches MAX_CONCURRENT in embed.js
    let _toast = null;

    function _update({ total, done, running }) {
        if (total > THRESHOLD) {
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
        const res = await fetch('/api/plugins/cnz/embed-stream', { headers: getRequestHeaders() });
        if (!res.ok) return; // plugin not installed

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
    } catch { /* plugin not installed or stream closed — exit silently */ }
}

await init().catch(err => error('Init', 'init() top-level rejection:', err));
