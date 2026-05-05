/**
 * @file data/default-user/extensions/canonize/core/cleanup-logic.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Stateful Owner
 * @description
 * Owns the interactive data-clearing processes. Handles new-chat cleanup 
 * prompts and manual RAG/Lorebook purging.
 *
 * @api-declaration
 * runNewChatCleanup(char), purgeCnzFiles()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [/api/worldinfo/edit, /api/files/delete, /api/db-purge, callPopup]
 */

import { state, escapeHtml } from '../state.js';
import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { cnzAvatarKey, cnzDeleteFile } from '../rag/api.js';
import { error } from '../log.js';

/**
 * Shown when a new chat is detected for a character that has prior CNZ session
 * data. Offers to clear lorebook, RAG files, and the vector index.
 * @param {object} char  Character object from ST context.
 */
export async function runNewChatCleanup(char) {
    try {
        const confirmed = await callPopup(
            `<h3>CNZ: New Chat — Clear Previous Session?</h3>
            <p>The lorebook and vector index still contain entries from the previous session.</p>
            <p>The following will be cleared:</p>
            <ul>
                <li>Lorebook entries wiped</li>
                <li>CNZ RAG files removed</li>
                <li>Vector index purged</li>
            </ul>
            <p><em>Skip to manage manually via Settings → Purge &amp; Rebuild.</em></p>`,
            'confirm',
        );

        if (confirmed) {
            if (state._lorebookName) {
                await lbSaveLorebook(state._lorebookName, { entries: {} });
                state._lorebookData  = { name: state._lorebookName, entries: {} };
                state._draftLorebook = structuredClone(state._lorebookData);
            }

            const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
            const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
            const cnzFiles       = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
            for (const f of cnzFiles) {
                await cnzDeleteFile(f.url);
            }
            extension_settings.character_attachments[char.avatar] =
                allAttachments.filter(a => !cnzFiles.includes(a));

            saveSettingsDebounced();

            await SillyTavern.getContext().executeSlashCommandsWithOptions('/db-purge');

            toastr.success('CNZ: Lorebook and vector index cleared for new chat.');
        } else {
            toastr.info(
                'CNZ: Previous session data retained — adjust manually via Settings if needed.',
            );
        }
    } catch (err) {
        error('Cleanup', 'runNewChatCleanup:', err);
        toastr.error(`CNZ: New-chat cleanup failed: ${err.message}`);
    }
}

/**
 * Deletes all CNZ RAG files for the current character from the Data Bank and
 * purges the vector index. Does not touch the lorebook or hooks.
 * Callable from the settings panel "Purge" button.
 */
export async function purgeCnzFiles() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const confirmed = await callPopup(
        `<h3>Purge CNZ Files</h3>
        <p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
        <ul>
            <li>Delete all CNZ RAG files from the Data Bank</li>
            <li>Purge the vector index</li>
        </ul>
        <p>The lorebook and hooks will not be changed.</p>
        <p>RAG files can be rebuilt at any time by switching back to the original chat and using Purge &amp; Rebuild.</p>`,
        'confirm',
    );
    if (!confirmed) return;

    try {
        const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
        const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
        const cnzFiles       = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
        for (const f of cnzFiles) {
            await cnzDeleteFile(f.url);
        }
        extension_settings.character_attachments[char.avatar] =
            allAttachments.filter(a => !cnzFiles.includes(a));
        saveSettingsDebounced();

        await ctx.executeSlashCommandsWithOptions('/db-purge');

        toastr.success(`CNZ: Purged ${cnzFiles.length} RAG file(s) and cleared vector index.`);
    } catch (err) {
        error('Cleanup', 'purgeCnzFiles:', err);
        toastr.error(`CNZ: Purge failed: ${err.message}`);
    }
}