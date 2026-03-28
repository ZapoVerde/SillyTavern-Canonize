/**
 * @file data/default-user/extensions/canonize/core/healer.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role Stateful Owner
 * @description
 * Owns branch detection and state restoration. Walks the DNA chain embedded
 * in the chat to find the deepest still-valid anchor, then restores lorebook,
 * hooks, and RAG from that anchor's payload. Also owns the three restore helpers
 * (restoreLorebookToNode, restoreHooksToNode, restoreRagToNode) and the
 * purgeAndRebuild utility callable from the settings panel.
 *
 * @api-declaration
 * runHealer, restoreLorebookToNode, restoreHooksToNode, restoreRagToNode,
 * purgeAndRebuild
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook,
 *                       state._dnaChain, state._stagedProsePairs, state._stagedPairOffset,
 *                       state._splitPairIdx, state._ragChunks]
 *     external_io: [/api/worldinfo/*, /api/files/delete, /api/chats/saveChat,
 *                   promptManager.saveServiceSettings]
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain, findLkgAnchorByPosition, buildNodeFileFromAnchor } from './dna-chain.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { buildRagChunks } from '../rag/pipeline.js';
import { setDnaChain } from '../scheduler.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { cnzAvatarKey, cnzFileName, uploadRagFile, registerCharacterAttachment } from '../rag/api.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { waitForRagChunks } from '../rag/pipeline.js';
import { buildRagDocument } from '../rag/pipeline.js';

// ─── Healer Utilities ─────────────────────────────────────────────────────────

/**
 * Restores the lorebook to the full snapshot stored in `node.state.lorebook`.
 * Fetches the node file, writes `state.lorebook` to disk, and updates in-memory state.
 * @param {object} char  Character object (avatar key used for node file lookup).
 * @param {object} node  Dummy chain entry (used only for error messages).
 */
export async function restoreLorebookToNode(_char, node, nodeFile = null) {
    const nodeFile_ = nodeFile;
    if (!nodeFile_?.state?.lorebook) throw new Error(`[CNZ] No lorebook state in node ${node.nodeId}`);
    const lbData = nodeFile_.state.lorebook;
    const lbName = lbData.name || state._lorebookName;
    await lbSaveLorebook(lbName, lbData);
    state._lorebookName  = lbName;
    state._lorebookData  = structuredClone(lbData);
    state._draftLorebook = structuredClone(lbData);
}

/**
 * IO Executor. Restores the CNZ Summary prompt to the hooks state stored in
 * `node.state.hooks` and stamps the anchor UUID from `node.state.uuid`.
 * @param {object} char  Character object from ST context.
 * @param {object} _node Dummy chain entry (used only for error messages).
 * @param {object|null} nodeFile  nodeFile-shaped object with state.hooks and state.uuid.
 */
export function restoreHooksToNode(char, _node, nodeFile = null) {
    const hooksText  = nodeFile?.state?.hooks ?? '';
    const anchorUuid = nodeFile?.state?.uuid  ?? null;
    writeCnzSummaryPrompt(char.avatar, hooksText, anchorUuid);
}

/**
 * Reconciles RAG character attachments to the state recorded in `nodeFile`.
 * Removes attachments belonging to orphaned nodes, deletes their files from
 * the Data Bank, then triggers a full vector purge and revectorize so the
 * vector index reflects only the restored timeline.
 * @param {object} char      Character object from ST context.
 * @param {object} nodeFile  Full node file object (already fetched by caller).
 */
export async function restoreRagToNode(char, nodeFile) {
    const survivingFiles = nodeFile.state?.ragFiles ?? [];

    // ── 1. Scrub attachment registry ─────────────────────────────────────────
    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;

    const toRemove = allAttachments.filter(
        a => a.name?.startsWith(cnzRagPrefix) && !survivingFiles.includes(a.name)
    );
    const toKeep   = allAttachments.filter(a => !toRemove.includes(a));

    extension_settings.character_attachments[char.avatar] = toKeep;
    saveSettingsDebounced();

    // ── 2. Delete orphaned files from Data Bank ───────────────────────────────
    for (const attachment of toRemove) {
        await cnzDeleteFile(attachment.url);
    }

    // ── 3. Purge vector index and revectorize ─────────────────────────────────
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    await executeSlashCommandsWithOptions('/db-purge');
    await executeSlashCommandsWithOptions('/db-ingest');
}

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the DNA chain against the current chat history to detect branches.
 * If a branch is found, restores the lorebook and hooks block to the last valid
 * anchor and rolls the DNA chain head back.
 *
 * Outcomes:
 *   - Same timeline (head hash matches) → silent return.
 *   - No matching node (pre-CNZ or unrelated chat) → silent return.
 *   - Branch detected → restore + toastr.warning.
 *   - Restoration failure → toastr.error.
 *
 * @param {object} char         Current character object from context.
 * @param {string} chatFileName Current chat filename (unused directly; kept for signature parity).
 */
export async function runHealer(char, _chatFileName) {
    const context  = SillyTavern.getContext();
    const messages = context.chat ?? [];
    if (!messages.length) return;

    state._dnaChain = readDnaChain(messages);
    setDnaChain(state._dnaChain);
    if (state._dnaChain.anchors.length === 0) return;

    // ── Head check — same timeline? ───────────────────────────────────────────
    const headRef = state._dnaChain.anchors[state._dnaChain.anchors.length - 1];
    if (messages[headRef.msgIdx]?.extra?.cnz?.uuid === headRef.anchor.uuid) return;

    // ── Find deepest still-valid anchor ──────────────────────────────────────
    const lkgRef = findLkgAnchorByPosition(state._dnaChain.anchors, messages);
    if (!lkgRef) return; // chat predates CNZ or is unrelated

    // ── Branch detected ───────────────────────────────────────────────────────
    const restorePoint = lkgRef.msgIdx + 1;

    const confirmed = await callPopup(
        `<h3>CNZ: Timeline Branch Detected</h3>
        <p>The current chat diverges from the last committed sync point at
        <strong>message ${restorePoint}</strong>.</p>
        <p>CNZ will restore world state to that point:</p>
        <ul>
            <li>Lorebook entries rolled back</li>
            <li>Narrative hooks rolled back</li>
            <li>RAG files for orphaned turns removed</li>
            <li>Vector index purged and rebuilt</li>
        </ul>
        <p>This cannot be undone.</p>`,
        'confirm',
    );

    if (!confirmed) {
        toastr.warning(
            'CNZ: Timeline branch detected but restoration was cancelled — ' +
            'world state may not match the current chat.',
            '',
            { timeOut: 0, extendedTimeOut: 0, closeButton: true },
        );
        return;
    }

    try {
        const nodeFile   = buildNodeFileFromAnchor(lkgRef.anchor);
        const nodeDummy  = { nodeId: lkgRef.anchor.uuid }; // safe dummy for error messages in restore fns

        await restoreLorebookToNode(char, nodeDummy, nodeFile);
        await restoreHooksToNode(char, nodeDummy, nodeFile);

        try {
            await restoreRagToNode(char, nodeFile);
        } catch (err) {
            console.error('[CNZ] Healer: RAG reconciliation failed:', err);
            toastr.warning('CNZ: Branch healed but RAG reconciliation failed — vector index may be inconsistent.');
        }

        state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(state._dnaChain);

        toastr.warning(`CNZ: Branch detected — restored to message ${restorePoint}. Vector index rebuilt.`);
    } catch (err) {
        console.error('[CNZ] Healer: restoration failed:', err);
        toastr.error('CNZ: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}

// ─── Purge and Rebuild ────────────────────────────────────────────────────────

/**
 * Hard-resets the external world to match the LKG anchor, then rebuilds a single
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
 *
 * Stateful owner: reads module state (isSyncInProgress), writes nothing directly —
 * delegates all state mutation to the existing restore/register helpers.
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
        const allPairs   = buildProsePairs(messages);
        const ragSettings = getSettings();

        // Fast path: hydrate from cnz_chunk_header stamps already on messages.
        // Deep path: reclassify every chunk fresh via the AI classifier fan-out,
        //   using the same dispatch + bus pattern as runRagPipeline.
        let combinedChunks;
        if (deepReclassify) {
            // Set module state so the fan-out and bus subscriber operate correctly.
            state._stagedProsePairs = allPairs;
            state._stagedPairOffset = 0;
            state._splitPairIdx     = allPairs.length;
            state._ragChunks        = buildRagChunks(allPairs, 0, ragSettings); // all status: 'pending'

            setCurrentSettings(ragSettings);
            dispatchContract('rag_classifier', {
                ragChunks:        state._ragChunks,
                fullPairs:        allPairs,
                stagedPairs:      allPairs,
                stagedPairOffset: 0,
                splitPairIdx:     allPairs.length,
                scenario_hooks:   chain.lkg.hooks ?? '',
            }, ragSettings);
            // Longer timeout — full chat history, not just one sync window.
            await waitForRagChunks(300_000);
            combinedChunks = state._ragChunks.filter(c => c.status === 'complete');
        } else {
            // Fast path: walk messages and collect cnz_chunk_header stamps directly.
            // Do NOT re-chunk — new chunk boundaries won't align with original stamps
            // if the chat has grown since the original sync.
            combinedChunks = [];
            let prevPairEnd = 0;
            for (let i = 0; i < allPairs.length; i++) {
                const pair    = allPairs[i];
                const lastMsg = pair?.messages?.[pair.messages.length - 1];
                if (!lastMsg?.extra?.cnz_chunk_header) continue;
                const pairStart = prevPairEnd;
                const pairEnd   = i + 1;
                const window    = allPairs.slice(pairStart, pairEnd);
                const content   = formatPairsAsTranscript(window);
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

        // ── 5. Upload, register, patch LKG anchor, save ───────────────────────────
        const charName    = char.name ?? '';
        const ragText     = buildRagDocument(combinedChunks, ragSettings, charName);
        const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name);
        const ragUrl      = await uploadRagFile(ragText, ragFileName);
        const byteSize    = new TextEncoder().encode(ragText).length;
        registerCharacterAttachment(char.avatar, ragUrl, ragFileName, byteSize);

        for (const { msgIdx } of chain.anchors) {
            const msg = messages[msgIdx];
            if (msg?.extra?.cnz) {
                msg.extra.cnz = Object.assign({}, msg.extra.cnz, { ragUrl });
            }
        }
        await ctx.saveChat();

        // ── 6. Re-vectorize ───────────────────────────────────────────────────────
        const { executeSlashCommandsWithOptions } = ctx;
        await executeSlashCommandsWithOptions('/db-purge');
        await executeSlashCommandsWithOptions('/db-ingest');

        toastr.success(`CNZ: Rebuild complete — ${combinedChunks.length} chunks re-indexed.`);
    } catch (err) {
        console.error('[CNZ] purgeAndRebuild:', err);
        toastr.error(`CNZ: Rebuild failed: ${err.message}`);
    }
}

// ─── Internal helpers (also used by restoreRagToNode) ─────────────────────────

async function cnzDeleteFile(path) {
    const { cnzDeleteFile: _del } = await import('../rag/api.js');
    return _del(path);
}
