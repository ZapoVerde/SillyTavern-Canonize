/**
 * @file data/default-user/extensions/canonize/core/maintenance-cleanup.js
 * @stamp {"utc":"2026-06-04T15:33:00.000Z"}
 * @version 2.1.0
 * @architectural-role Orchestrator
 * @description
 * User-initiated cleanup: new-chat session reset and vector store purge. Split
 * from maintenance.js to keep both files under 300 lines.
 *
 * @api-declaration
 * runNewChatCleanup(char)
 * purgeCnzFiles()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookData, state._draftLorebook]
 *     external_io: [callPopup, toastr, chat-store.js]
 */

import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { cnzGetActiveChatKey, cnzPlotLbName } from '../rag/api.js';
import { purgeChatStore } from '../rag/chat-store.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { error } from '../log.js';

// ─── New Chat Cleanup ─────────────────────────────────────────────────────────

export async function runNewChatCleanup(char) {
    try {
        const confirmed = await callPopup(
            `<h3>CNZ: New Chat — Clear Previous Session?</h3>
            <p>The lorebook and vector store still contain entries from the previous session.</p>
            <p>The following will be cleared:</p>
            <ul>
                <li>Lorebook entries wiped</li>
                <li>RAG chunks and vectors purged</li>
            </ul>
            <p><em>Skip to manage manually via Settings → Purge RAG / Rebuild RAG.</em></p>`,
            'confirm',
        );

        if (confirmed) {
            if (state._lorebookName) {
                await lbSaveLorebook(state._lorebookName, { entries: {} }, { silent: true });
                state._lorebookData  = { name: state._lorebookName, entries: {} };
                state._draftLorebook = structuredClone(state._lorebookData);
            }

            const chatKey  = cnzGetActiveChatKey();
            if (chatKey) await purgeChatStore(chatKey);
            writeCnzSummaryPrompt(char.avatar, '', null);

            toastr.success('CNZ: Lorebook, hooks, and RAG store cleared for new chat.');
        } else {
            toastr.info('CNZ: Previous session data retained — adjust manually via Settings if needed.');
        }
    } catch (err) {
        error('Maintenance', 'runNewChatCleanup:', err);
        toastr.error(`CNZ: New-chat cleanup failed: ${err.message}`);
    }
}

// ─── Purge Only ───────────────────────────────────────────────────────────────

export async function purgeCnzFiles() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const { escapeHtml } = await import('../state.js');
    const confirmed = await callPopup(
        `<h3>Purge RAG</h3>
        <p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
        <ul>
            <li>Purge all CNZ chunks and lorebook vectors</li>
            <li>Clear the plot lorebook file (entries can be restored via Rebuild RAG)</li>
        </ul>
        <p>The narrative lorebook and hooks will not be changed.</p>
        <p>Chunks and vectors can be rebuilt at any time via Rebuild RAG.</p>`,
        'confirm',
    );
    if (!confirmed) return;

    try {
        const chatKey  = cnzGetActiveChatKey();
        if (chatKey) await purgeChatStore(chatKey);

        const plotLbName = state._plotLorebookName ?? cnzPlotLbName(char.avatar);
        await lbSaveLorebook(plotLbName, { entries: {} }, { silent: true });

        toastr.success('CNZ: RAG store and plot lorebook cleared.');
    } catch (err) {
        error('Maintenance', 'purgeCnzFiles:', err);
        toastr.error(`CNZ: Purge failed: ${err.message}`);
    }
}