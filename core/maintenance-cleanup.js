/**
 * @file data/default-user/extensions/canonize/core/maintenance-cleanup.js
 * @stamp {"utc":"2026-05-28T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * User-initiated cleanup: new-chat session reset and vector DB purge. Split
 * from maintenance.js to keep both files under 300 lines. Both operations
 * purge rag_chunks and lb_entries together via the server's /purge-character
 * endpoint, with explicit named calls for each so the intent is clear at the
 * call site.
 *
 * @api-declaration
 * runNewChatCleanup(char)
 * purgeCnzFiles()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookData, state._draftLorebook]
 *     external_io: [callPopup, toastr, /api/plugins/cnz/*]
 */

import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { cnzAvatarKey } from '../rag/api.js';
import { purgeCharacterChunks, purgeCharacterLbEntries } from '../rag/vec-store.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { error } from '../log.js';

// ─── New Chat Cleanup ─────────────────────────────────────────────────────────

/**
 * Shown when a new chat is detected for a character that has prior CNZ session
 * data. Offers to clear lorebook entries, RAG files, and the vector index.
 * @param {object} char  Character object from ST context.
 */
export async function runNewChatCleanup(char) {
    try {
        const confirmed = await callPopup(
            `<h3>CNZ: New Chat — Clear Previous Session?</h3>
            <p>The lorebook and vector DB still contain entries from the previous session.</p>
            <p>The following will be cleared:</p>
            <ul>
                <li>Lorebook entries wiped</li>
                <li>Vector DB chunks and lorebook vectors purged</li>
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

            const ak = cnzAvatarKey(char.avatar);
            await purgeCharacterChunks(ak);
            await purgeCharacterLbEntries(ak);
            writeCnzSummaryPrompt(char.avatar, '', null);

            toastr.success('CNZ: Lorebook, hooks, and vector DB cleared for new chat.');
        } else {
            toastr.info('CNZ: Previous session data retained — adjust manually via Settings if needed.');
        }
    } catch (err) {
        error('Maintenance', 'runNewChatCleanup:', err);
        toastr.error(`CNZ: New-chat cleanup failed: ${err.message}`);
    }
}

// ─── Purge Only ───────────────────────────────────────────────────────────────

/**
 * Purges all CNZ vector DB chunks and lorebook vectors for the current
 * character. Does not touch the lorebook file or hooks.
 * Chunks and vectors can be rebuilt via Rebuild RAG.
 */
export async function purgeCnzFiles() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const { escapeHtml } = await import('../state.js');
    const confirmed = await callPopup(
        `<h3>Purge RAG</h3>
        <p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
        <ul>
            <li>Purge all CNZ chunks and lorebook vectors from the vector DB</li>
        </ul>
        <p>The lorebook file and hooks will not be changed.</p>
        <p>Chunks and vectors can be rebuilt at any time via Rebuild RAG.</p>`,
        'confirm',
    );
    if (!confirmed) return;

    try {
        const ak = cnzAvatarKey(char.avatar);
        await purgeCharacterChunks(ak);
        await purgeCharacterLbEntries(ak);
        toastr.success('CNZ: Vector DB chunks and lorebook vectors purged.');
    } catch (err) {
        error('Maintenance', 'purgeCnzFiles:', err);
        toastr.error(`CNZ: Purge failed: ${err.message}`);
    }
}
