/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern Narrative Engine (CNZ) entry point. Orchestrates the startup 
 * sequence, registers SillyTavern event listeners, and routes event bus 
 * triggers to the specialized core logic modules. 
 *
 * @api-declaration
 * cnzMaskMessages
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [eventSource, SillyTavern.getContext]
 */

import { eventSource, event_types } from '../../../../script.js';
import { on, BUS_EVENTS } from './bus.js';
import { log, error } from './log.js';
import { state } from './state.js';

// Module Imports
import { initMobileDebug } from './utils/mobile-debug.js';
import { initSettings, getSettings } from './core/settings.js';
import { initScheduler, snooze, isSyncInProgress } from './scheduler.js';
import { Triggers } from './recipes.js';
import { injectModal, openReviewModal, openOrphanModal } from './modal/orchestrator.js';
import { injectSettingsPanel } from './settings/panel.js';
import { injectWandButton } from './ui/wand.js';
import { runCnzSync } from './core/sync-pipeline.js';
import { onChatChanged, resetSessionState } from './core/session.js';
import { readDnaChain } from './core/dna-chain.js';
import { renderChunkChatLabel, writeChunkHeaderToChat } from './rag/pipeline.js';
import { renderRagCard } from './modal/rag-workshop.js';

// ─── Initialisation ───────────────────────────────────────────────────────────

async function init() {
    log('Init', 'Starting extension bootstrap...');
    try {
        // 1. Core Services
        initSettings();
        initScheduler(Triggers, getSettings);
        
        // 2. UI Injection
        injectModal();
        injectSettingsPanel();
        injectWandButton();

        // 3. Optional Debugging
        const MDP = false; // Set true for on-screen console on mobile
        if (MDP) initMobileDebug();

        // 4. SillyTavern Event Bindings
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // 5. Global Delegated Click Handlers
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
            if (!ctx?.characterId) return;
            runCnzSync(ctx.characters[ctx.characterId], ctx.chat ?? [], { coverAll: true });
        });
        $(document).on('click', '.cnz-gap-snooze', (e) => {
            e.preventDefault();
            toastr.clear();
            const messages = SillyTavern.getContext()?.chat ?? [];
            const pairCount = messages.filter(m => !m.is_system && m.is_user).length;
            snooze(getSettings().gapSnoozeTurns ?? 5, pairCount);
        });

        log('Init', 'Bootstrap complete.');
    } catch (err) {
        error('Init', 'Critical failure during bootstrap:', err);
    }
}

// ─── Bus Subscribers ──────────────────────────────────────────────────────────

on(BUS_EVENTS.CONTRACT_DISPATCHED, ({ recipeId, inputs }) => {
    if (recipeId !== 'rag_classifier') return;
    const chunk = state._ragChunks[inputs?.chunkIndex];
    if (chunk) {
        chunk.status = 'in-flight';
        renderRagCard(inputs.chunkIndex);
    }
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
            writeChunkHeaderToChat(chunkIndex).catch(e => error('Rag', 'Header write failed:', e));
        }
        renderRagCard(chunkIndex);
        renderChunkChatLabel(chunkIndex);
    }
});

on(BUS_EVENTS.SYNC_TRIGGERED, ({ char, messages, gap, every, trailingBoundary, largeGap }) => {
    if (!largeGap) {
        runCnzSync(char, messages);
    } else if (!isSyncInProgress()) {
        runCnzSync(char, messages).then(() => {
            const freshChain = readDnaChain(messages);
            const lkgIdx = freshChain.lkgMsgIdx;
            const prior = lkgIdx >= 0 ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system && m.is_user).length : 0;
            const remaining = trailingBoundary - prior;
            if (remaining >= every) {
                const snoozeTurns = getSettings().gapSnoozeTurns ?? 5;
                toastr.warning(
                    `CNZ: ${remaining} uncaptured pair(s). ` +
                    `<a href="#" class="cnz-gap-sync-all">Sync all</a> &nbsp; ` +
                    `<a href="#" class="cnz-gap-snooze">Snooze ${snoozeTurns} pairs</a>`,
                    '', { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false }
                );
            }
        });
    }
});

// ─── Context Mask Interceptor ──────────────────────────────────────────────────

globalThis.cnzMaskMessages = function(chat) {
    if (!getSettings().autoAdvanceMask) return;
    const IGNORE = SillyTavern.getContext().symbols.ignore;
    let anchorIdx = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i]?.extra?.cnz?.type === 'anchor') { anchorIdx = i; break; }
    }
    if (anchorIdx < 0) return;
    for (let i = 0; i <= anchorIdx; i++) {
        chat[i] = structuredClone(chat[i]);
        chat[i].extra ??= {};
        chat[i].extra[IGNORE] = true;
    }
};

// Start
init();