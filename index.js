/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.4.0
 * @architectural-role Orchestrator
 * @description
 * SillyTavern Narrative Engine (CNZ) — extension entry point.
 * Initialises all subsystems and delegates dynamic asset lifecycle (event
 * listeners, UI, prompt stack) to lifecycle.js. Contains no business logic.
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

import { on, BUS_EVENTS } from './bus.js';
import { log, error } from './log.js';
import { initScheduler, isSyncInProgress } from './scheduler.js';
import { Triggers } from './recipes.js';
import './executor.js';
import './logger.js';
import { state } from './state.js';
import { getSettings, getMetaSettings, initSettings } from './core/settings.js';
import { initSceneTracker } from './core/scene-tracker.js';
import { readDnaChain } from './core/dna-chain.js';
import { runCnzSync } from './core/sync.js';
import { writeChunkHeaderToChat, renderChunkChatLabel } from './rag/chat-labels.js';
import { onGenerationStarted } from './rag/generation-hook.js';
import { injectModal } from './modal/modal-setup.js';
import { renderRagCard } from './modal/rag-workshop.js';
import { injectSettingsPanel } from './settings/panel.js';
import { initLifecycle } from './lifecycle.js';

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
        initLifecycle();
        log('Init', 'Lifecycle initialized.');

        // ── Bus subscribers ───────────────────────────────────────────────────
        // Permanently registered; setBusEnabled(false) silences them on unmount.

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
            if (!getMetaSettings().enableCnz) return;
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

        log('Init', 'Full sequence complete.');
    } catch (err) {
        error('Init', 'CRITICAL FAILURE during init:', err);
    }
}

await init().catch(err => error('Init', 'init() top-level rejection:', err));
