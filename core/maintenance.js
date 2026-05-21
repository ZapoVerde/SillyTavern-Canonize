/**
 * @file data/default-user/extensions/canonize/core/maintenance.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * User-initiated maintenance operations: hard reset (purgeAndRebuild), new-chat
 * cleanup (runNewChatCleanup), and RAG-only purge (purgeCnzFiles). All three are
 * triggered explicitly by the user — either from the settings panel or from the
 * healer's new-chat guard — and are distinct from the automatic healing flow in
 * healer.js. Each operation sequences restore and IO calls; it owns no data.
 *
 * @api-declaration
 * purgeAndRebuild()
 * runNewChatCleanup(char)
 * purgeCnzFiles()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._stagedProsePairs, state._stagedPairOffset,
 *                       state._splitPairIdx, state._ragChunks,
 *                       state._lorebookData, state._draftLorebook]
 *     external_io: [callPopup, toastr, /api/files/delete, /api/chats/saveChat,
 *                   /db-purge, /db-ingest, extension_settings.character_attachments,
 *                   saveSettingsDebounced, rag/vectfox-bridge.js (dynamic)]
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain } from './dna-chain.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { buildRagChunks, buildRagDocument } from '../rag/chunks.js';
import { waitForRagChunks } from '../rag/pipeline.js';
import { cnzAvatarKey, cnzFileName, uploadRagFile, registerCharacterAttachment } from '../rag/api.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { error } from '../log.js';
import { restoreLorebookToNode, restoreHooksToNode, cnzDeleteFile } from './healer-restore.js';

// ─── Purge and Rebuild ────────────────────────────────────────────────────────

/**
 * Hard-resets the external world to match the LKG anchor, then rebuilds a
 * combined RAG file from all chunk data stored in the chain.
 *
 * Order of operations:
 *   1. Delete all CNZ RAG files for this character from the Data Bank.
 *   2. Restore the lorebook from the LKG anchor.
 *   3. Restore the hooks summary from the LKG anchor.
 *   4. Reconstruct one combined RAG document from every anchor's ragHeaders
 *      (using stored pairStart/pairEnd for content slicing, stored header text).
 *   5. Upload, register, update LKG anchor ragUrl, save chat.
 *   6. Purge and re-ingest the vector index.
 */
export async function purgeAndRebuild() {
    const { isSyncInProgress } = await import('../scheduler.js');
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync in progress — wait for it to complete.');
        return;
    }
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const messages = ctx.chat ?? [];
    const chain    = readDnaChain(messages);
    if (!chain.lkg) {
        toastr.warning('CNZ: No anchor found in this chat — nothing to restore from.');
        return;
    }

    const { escapeHtml } = await import('../state.js');
    const confirmed = await callPopup(`
<h3>Purge &amp; Rebuild</h3>
<p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
<ul>
  <li>Delete all CNZ RAG files from the Data Bank</li>
  <li>Clear and restore the lorebook from the last anchor</li>
  <li>Restore the hooks summary from the last anchor</li>
  <li>Rebuild a single RAG file from the full chain history</li>
</ul>
<label style="display:flex;align-items:center;gap:0.5em;margin-top:0.75em;">
  <input type="checkbox" id="cnz-purge-deep">
  Reclassify all chunks with AI (slow)
</label>
<p style="margin-top:0.5em">This cannot be undone.</p>`, 'confirm');
    if (!confirmed) return;

    const deepReclassify = document.getElementById('cnz-purge-deep')?.checked ?? false;

    try {
        // ── 1. Delete all CNZ RAG files ──────────────────────────────────────────
        const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
        const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
        const cnzFiles       = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
        for (const f of cnzFiles) {
            await cnzDeleteFile(f.url);
        }
        extension_settings.character_attachments[char.avatar] = allAttachments.filter(a => !cnzFiles.includes(a));
        saveSettingsDebounced();

        // ── 2 & 3. Restore lorebook and hooks from LKG ───────────────────────────
        const fakeNodeFile = { state: { uuid: chain.lkg.uuid ?? null, lorebook: chain.lkg.lorebook, hooks: chain.lkg.hooks } };
        await restoreLorebookToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);
        await restoreHooksToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);

        // ── 4. Reconstruct combined RAG document ──────────────────────────────────
        const allPairs    = buildProsePairs(messages);
        const ragSettings = getSettings();

        let combinedChunks;
        if (deepReclassify) {
            state._stagedProsePairs = allPairs;
            state._stagedPairOffset = 0;
            state._splitPairIdx     = allPairs.length;
            state._ragChunks        = buildRagChunks(allPairs, 0, ragSettings);

            setCurrentSettings(ragSettings);
            dispatchContract('rag_classifier', {
                ragChunks:        state._ragChunks,
                fullPairs:        allPairs,
                stagedPairs:      allPairs,
                stagedPairOffset: 0,
                splitPairIdx:     allPairs.length,
                scenario_hooks:   chain.lkg.hooks ?? '',
            }, ragSettings);
            await waitForRagChunks(300_000);
            combinedChunks = state._ragChunks.filter(c => c.status === 'complete');
        } else {
            // Fast path: walk messages and collect cnz_chunk_header stamps directly.
            combinedChunks = [];
            let prevPairEnd = 0;
            for (let i = 0; i < allPairs.length; i++) {
                const pair    = allPairs[i];
                const lastMsg = pair?.messages?.[pair.messages.length - 1];
                if (!lastMsg?.extra?.cnz_chunk_header) continue;
                const pairStart = prevPairEnd;
                const pairEnd   = i + 1;
                const content   = formatPairsAsTranscript(allPairs.slice(pairStart, pairEnd));
                combinedChunks.push({
                    chunkIndex: combinedChunks.length,
                    header:     lastMsg.extra.cnz_chunk_header,
                    turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${pairStart + 1}–${pairEnd}`,
                    content,
                    status:     'complete',
                });
                prevPairEnd = pairEnd;
            }
        }

        if (combinedChunks.length === 0) {
            toastr.warning('CNZ: No classified chunks found in chain — RAG file not rebuilt. Run a sync first.');
            return;
        }

        // ── 5. Upload/push chunks to retrieval backend ────────────────────────────
        if (getSettings().useVectFox) {
            const lorebookName = char?.data?.extensions?.world || null;
            const { purgeVectFoxCollection, pushScenesToVectFox, scopeVectFoxToChar } =
                await import('../rag/vectfox-bridge.js');
            const { buildSceneSlices } = await import('./transcript.js');
            const restoreScope = await scopeVectFoxToChar(cnzAvatarKey(char.avatar), lorebookName);
            try {
                await purgeVectFoxCollection(cnzAvatarKey(char.avatar));
                const scenes = buildSceneSlices(buildProsePairs(messages), getSettings().vectfoxMaxPairsPerChunk ?? 15);
                if (scenes.length > 0) await pushScenesToVectFox(scenes, cnzAvatarKey(char.avatar));
            } finally {
                await restoreScope();
            }
        } else {
            const ragText    = buildRagDocument(combinedChunks, ragSettings, char.name ?? '');
            const anchorHash = chain.lkg.uuid?.slice(0, 8) ?? '';
            const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name, anchorHash);
            const ragUrl      = await uploadRagFile(ragText, ragFileName);
            const byteSize    = new TextEncoder().encode(ragText).length;
            registerCharacterAttachment(char.avatar, ragUrl, ragFileName, byteSize);

            for (const { msgIdx } of chain.anchors) {
                const msg = messages[msgIdx];
                if (msg?.extra?.cnz) {
                    msg.extra.cnz = Object.assign({}, msg.extra.cnz, { ragUrl });
                }
            }
        }

        await ctx.saveChat();

        // ── 6. Re-vectorize (Data Bank mode only) ─────────────────────────────────
        if (!getSettings().useVectFox) {
            const { executeSlashCommandsWithOptions } = ctx;
            await executeSlashCommandsWithOptions('/db-purge');
            await executeSlashCommandsWithOptions('/db-ingest');
        }

        toastr.success(`CNZ: Rebuild complete — ${combinedChunks.length} chunks re-indexed.`);
    } catch (err) {
        error('Maintenance', 'purgeAndRebuild:', err);
        toastr.error(`CNZ: Rebuild failed: ${err.message}`);
    }
}

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
            toastr.info('CNZ: Previous session data retained — adjust manually via Settings if needed.');
        }
    } catch (err) {
        error('Maintenance', 'runNewChatCleanup:', err);
        toastr.error(`CNZ: New-chat cleanup failed: ${err.message}`);
    }
}

// ─── Purge Only ───────────────────────────────────────────────────────────────

/**
 * Deletes all CNZ RAG files for the current character from the Data Bank and
 * purges the vector index. Does not touch the lorebook or hooks.
 */
export async function purgeCnzFiles() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const { escapeHtml } = await import('../state.js');
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
        error('Maintenance', 'purgeCnzFiles:', err);
        toastr.error(`CNZ: Purge failed: ${err.message}`);
    }
}
