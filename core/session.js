/**
 * @file data/default-user/extensions/canonize/core/session.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Stateful Owner / Event Delegate
 * @description
 * Manages the lifecycle of a Canonize session. Handles character and chat 
 * switch events, session state resets, and sweeps for orphaned Data Bank files 
 * belonging to deleted characters.
 *
 * @api-declaration
 * checkOrphans, resetStagedState, resetSessionState, onChatChanged
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lastKnownAvatar, state._dnaChain, state._lorebookData, state._draftLorebook, state._lorebookName, state._lorebookSuggestions, state._parentNodeLorebook, state._priorSituation, state._beforeSituation, state._lastRagUrl, state._pendingOrphans, state._stagedProsePairs, state._stagedPairOffset, state._splitPairIdx, state._ragChunks]
 *     external_io: [saveSettingsDebounced, getRequestHeaders, /api/files/verify]
 */

import { state } from '../state.js';
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { invalidateAllJobs } from '../cycleStore.js';
import { resetScheduler, setDnaChain } from '../scheduler.js';
import { readDnaChain } from './dna-chain.js';
import { syncCnzSummaryOnCharacterSwitch } from './summary-prompt.js';
import { runHealer } from './healer.js';
import { clearChunkChatLabels } from '../rag/pipeline.js';
import { warn, error } from '../log.js';

/**
 * Scans the character attachment registry for files belonging to characters
 * that no longer exist in ST. Wipes dead registry keys and verifies survivors.
 */
export async function checkOrphans() {
    const ctx            = SillyTavern.getContext();
    const liveAvatars    = new Set((ctx.characters ?? []).map(c => c.avatar));
    const allAttachments = extension_settings.character_attachments ?? {};

    const orphanUrls = [];
    for (const [avatarKey, files] of Object.entries(allAttachments)) {
        if (!liveAvatars.has(avatarKey)) {
            orphanUrls.push(...(files ?? []).map(f => f.url).filter(Boolean));
            delete extension_settings.character_attachments[avatarKey];
        }
    }

    if (orphanUrls.length === 0) return;
    saveSettingsDebounced();

    let existing = orphanUrls;
    try {
        const res = await fetch('/api/files/verify', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({ urls: orphanUrls }),
        });
        if (res.ok) {
            const verified = await res.json();
            existing = orphanUrls.filter(url => verified[url] === true);
        }
    } catch (err) {
        warn('Session', 'checkOrphans: verify request failed:', err);
    }

    if (existing.length === 0) return;

    state._pendingOrphans = existing;
    const n = existing.length;
    toastr.warning(
        `CNZ: ${n} orphaned file${n !== 1 ? 's' : ''} from deleted character${n !== 1 ? 's' : ''}. ` +
        `<a href="#" class="cnz-orphan-review">Review</a> &nbsp; <a href="#" class="cnz-orphan-dismiss">Dismiss</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

/**
 * Resets staged pair and chunk state without clearing session-level fields.
 */
export function resetStagedState() {
    state._stagedProsePairs       = [];
    state._stagedPairOffset       = 0;
    state._splitPairIdx           = 0;
    state._ragChunks              = [];
    clearChunkChatLabels();
}

/**
 * Resets all session-level state. Called on character switch.
 */
export function resetSessionState() {
    invalidateAllJobs();
    resetScheduler();
    state._dnaChain               = null;
    setDnaChain(null);
    state._lorebookData           = null;
    state._draftLorebook          = null;
    state._lorebookName           = '';
    state._lorebookSuggestions    = [];
    state._parentNodeLorebook     = null;
    state._priorSituation         = '';
    state._beforeSituation        = '';
    state._lastRagUrl             = '';
    resetStagedState();
}

/**
 * Event listener logic for CHAT_CHANGED. Detects character or chat swaps.
 */
export function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        state._lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    if (!char || char.avatar !== state._lastKnownAvatar) {
        state._lastKnownAvatar = char?.avatar ?? null;
        resetSessionState();
        const chatMessages = SillyTavern.getContext().chat ?? [];
        state._dnaChain = readDnaChain(chatMessages);
        setDnaChain(state._dnaChain);
        syncCnzSummaryOnCharacterSwitch(char, state._dnaChain);
        if (char) {
            runHealer(char, char.chat).catch(err =>
                error('Session', 'onChatChanged: healer failed:', err),
            );
            checkOrphans().catch(err =>
                error('Session', 'checkOrphans failed:', err),
            );
        }
        return;
    }

    if (chatFileName) {
        runHealer(char, chatFileName).catch(err =>
            error('Session', 'runHealer failed:', err),
        );
    }
}