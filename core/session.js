/**
 * @file data/default-user/extensions/canonize/core/session.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role Stateful Owner / Event Delegate
 * @description
 * Manages the lifecycle of a Canonize session. Handles character and chat 
 * switch events, session state resets, and "Soft Detach" logic.
 *
 * @api-declaration
 * checkOrphans, resetStagedState, resetSessionState, onChatChanged, detachCanonize, toggleExtension
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lastKnownAvatar, state._dnaChain, state._lorebookData, state._draftLorebook, state._lorebookName, state._lorebookSuggestions, state._parentNodeLorebook, state._priorSituation, state._beforeSituation, state._lastRagUrl, state._pendingOrphans, state._stagedProsePairs, state._stagedPairOffset, state._splitPairIdx, state._ragChunks]
 *     external_io: [saveSettingsDebounced, getRequestHeaders, /api/files/verify, callPopup]
 */

import { state } from '../state.js';
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, getRequestHeaders, callPopup } from '../../../../../script.js';
import { invalidateAllJobs } from '../cycleStore.js';
import { resetScheduler, setDnaChain } from '../scheduler.js';
import { readDnaChain } from './dna-chain.js';
import { syncCnzSummaryOnCharacterSwitch, setCnzPromptEnabled } from './summary-prompt.js';
import { runHealer } from './healer.js';
import { clearChunkChatLabels } from '../rag/pipeline.js';
import { warn, error } from '../log.js';
import { isExtensionEnabled } from './settings.js';
import { cnzAvatarKey } from '../rag/api.js';
import { setWandVisibility } from '../ui/wand.js';
import { unlinkCharacterWorld } from './character-api.js';

/**
 * Detaches Canonize's influence from a character's active state.
 * Mutes the summary prompt and unlinks RAG attachments. 
 * Optionally prompts to unlink the Lorebook.
 * @param {object} char 
 */
export async function detachCanonize(char) {
    if (!char) return;
    
    // 1. Mute the summary prompt
    setCnzPromptEnabled(false);

    // 2. Remove cnz_ prefix files from character attachments
    if (extension_settings.character_attachments?.[char.avatar]) {
        const cnzRagPrefix = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
        const initialCount = extension_settings.character_attachments[char.avatar].length;
        
        extension_settings.character_attachments[char.avatar] = 
            extension_settings.character_attachments[char.avatar].filter(a => !a.name?.startsWith(cnzRagPrefix));
            
        if (extension_settings.character_attachments[char.avatar].length !== initialCount) {
            saveSettingsDebounced();
        }
    }

    // 3. Clear any UI labels
    clearChunkChatLabels();

    // 4. Optional Lorebook Detach
    const currentWorld = char.data?.extensions?.world;
    if (currentWorld) {
        const confirmed = await callPopup(
            `<h3>Disconnect Lorebook?</h3>
            <p>Canonize is now disabled. Would you like to disconnect the Lorebook <strong>"${currentWorld}"</strong> from this character card?</p>
            <p><em>Note: Keeping it connected allows the AI to retain static long-term memory while Canonize is paused.</em></p>`,
            'confirm'
        );
        if (confirmed) {
            await unlinkCharacterWorld(char);
            toastr.info('CNZ: Lorebook disconnected from character card.');
        }
    }
}

/**
 * Orchestrates the global enable/disable toggle logic.
 */
export async function toggleExtension(isEnabled) {
    const context = SillyTavern.getContext();
    const char = context?.characters?.[context?.characterId];

    if (!isEnabled) {
        if (char) await detachCanonize(char);
        invalidateAllJobs();
        resetScheduler();
        setWandVisibility(false);
    } else {
        setCnzPromptEnabled(true);
        setWandVisibility(true);
        if (char) {
            runHealer(char, char.chat).catch(err => 
                error('Session', 'toggleExtension: healer failed:', err)
            );
        }
    }
}

/**
 * Scans the character attachment registry for files belonging to characters
 * that no longer exist in ST.
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
        `CNZ: ${n} orphaned file${n !== 1 ? 's' : ''} review needed. ` +
        `<a href="#" class="cnz-orphan-review">Review</a> &nbsp; <a href="#" class="cnz-orphan-dismiss">Dismiss</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

export function resetStagedState() {
    state._stagedProsePairs       = [];
    state._stagedPairOffset       = 0;
    state._splitPairIdx           = 0;
    state._ragChunks              = [];
    clearChunkChatLabels();
}

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
 * Event listener logic for CHAT_CHANGED.
 */
export async function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        state._lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    if (!isExtensionEnabled()) {
        // Silent Sweeper does not pop a modal on character switch (too intrusive).
        // It strictly mutes prompts and RAG. 
        setCnzPromptEnabled(false);
        state._lastKnownAvatar = char?.avatar ?? null;
        resetSessionState();
        return;
    }

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