/**
 * @file data/default-user/extensions/canonize/core/session.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @version 1.2.3
 * @architectural-role Orchestrator
 * @description
 * Session lifecycle management. Owns state reset on character switch and the
 * CHAT_CHANGED handler that drives healer invocation.
 *
 * @api-declaration
 * resetStagedState() — clears pair/chunk staging without touching lorebook or DNA chain
 * resetSessionState() — full session reset on character switch
 * onChatChanged() — CHAT_CHANGED event handler; resets session and fires healer
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [ST context, healer, scheduler, DNA chain]
 */

import { getCurrentChatId } from '../../../../../script.js';
import { log, error } from '../log.js';
import { invalidateAllJobs } from '../cycleStore.js';
import { resetScheduler, setDnaChain } from '../scheduler.js';
import { readDnaChain } from './dna-chain.js';
import { syncCnzSummaryOnCharacterSwitch } from './summary-prompt.js';
import { runHealer } from './healer.js';
import { clearChunkChatLabels, renderChunkLabelsFromChat } from '../rag/chat-labels.js';
import { resetRagState } from '../rag/generation-hook.js';
import { checkOrphans } from './orphans.js';
import { state } from '../state.js';

export function resetStagedState() {
    state._stagedProsePairs = [];
    state._stagedPairOffset = 0;
    state._splitPairIdx     = 0;
    state._ragChunks        = [];
    clearChunkChatLabels();
}

export function resetSessionState() {
    invalidateAllJobs();
    resetScheduler();
    state._dnaChain            = null;
    setDnaChain(null);
    state._lorebookData        = null;
    state._draftLorebook       = null;
    state._lorebookName        = '';
    state._lorebookSuggestions = [];
    state._parentNodeLorebook  = null;
    state._priorSituation      = '';
    state._beforeSituation     = '';
    resetStagedState();
}

export function onChatChanged() {
    const context = SillyTavern.getContext();
    resetRagState(); // discard stale prefetch + clear RAG prompt before healer runs
    if (!context || context.characterId == null) {
        state._lastKnownAvatar = null;
        return;
    }

    let char = context.characters?.[context.characterId];
    if (!char && context.characters && context.characterId != null) {
        char = context.characters.find(c => c.avatar === context.characterId || c.name === context.characterId);
    }

    if (!char) {
        state._lastKnownAvatar = null;
        return;
    }

    const chatFileName = context.chatId ?? getCurrentChatId() ?? char.chat ?? null;

    if (char.avatar !== state._lastKnownAvatar) {
        state._lastKnownAvatar = char.avatar;
        resetSessionState();
        const chatMessages = SillyTavern.getContext().chat ?? [];
        state._dnaChain = readDnaChain(chatMessages);
        setDnaChain(state._dnaChain);
        syncCnzSummaryOnCharacterSwitch(char, state._dnaChain);
        runHealer(char, chatFileName).catch(err =>
            error('Sync', 'onChatChanged: healer failed:', err),
        );
        checkOrphans().catch(err =>
            error('Sync', 'checkOrphans failed:', err),
        );
        renderChunkLabelsFromChat();
        return;
    }

    if (chatFileName) {
        runHealer(char, chatFileName).catch(err =>
            error('Sync', 'runHealer uncaught error:', err),
        );
    }
    renderChunkLabelsFromChat();
}