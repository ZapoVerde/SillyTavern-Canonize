/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.2.0
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
import { writeChunkHeaderToChat, renderChunkChatLabel } from './rag/chat-labels.js';
import { onGenerationStarted } from './rag/generation-hook.js';
import { injectModal } from './modal/modal-setup.js';
import { openReviewModal } from './modal/orchestrator.js';
import { openOrphanModal } from './modal/orphan-modal.js';
import { renderRagCard } from './modal/rag-workshop.js';
import { injectWandButton, onWandButtonClick } from './wand.js';
import { injectSettingsPanel } from './settings/panel.js';

log('Module', 'index.js: Module loaded (all imports resolved).');

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
        eventSource.on(event_types.GENERATION_STARTED, () => onGenerationStarted().catch(err => error('RagHook', err)));

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

        globalThis.cnzMaskMessages = function(chat) {
            if (!getSettings().autoAdvanceMask) return;
            const IGNORE = SillyTavern.getContext().symbols.ignore;
            let anchorIdx = -1;
            for (let i = chat.length - 2; i >= 0; i--) {
                if (chat[i]?.extra?.cnz?.type === 'anchor') { anchorIdx = i; break; }
            }
            if (anchorIdx < 0) return;
            for (let i = 0; i <= anchorIdx; i++) {
                chat[i] = structuredClone(chat[i]);
                chat[i].extra ??= {};
                chat[i].extra[IGNORE] = true;
            }
        };

        log('Init', 'Full sequence complete.');
    } catch (err) {
        error('Init', 'CRITICAL FAILURE during init:', err);
    }
}

await init().catch(err => error('Init', 'init() top-level rejection:', err));
