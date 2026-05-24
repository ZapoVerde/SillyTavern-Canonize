/**
 * @file data/default-user/extensions/canonize/core/maintenance.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
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
 *     external_io: [callPopup, toastr, /api/plugins/cnz/*]
 */

import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain } from './dna-chain.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { buildRagChunks } from '../rag/chunks.js';
import { waitForRagChunks } from '../rag/pipeline.js';
import { cnzAvatarKey } from '../rag/api.js';
import { insertSyncChunks, purgeCharacterChunks } from '../rag/vec-store.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { error } from '../log.js';
import { restoreLorebookToNode, restoreHooksToNode } from './healer-restore.js';

// ─── Purge and Rebuild ────────────────────────────────────────────────────────

/**
 * Hard-resets the external world to match the LKG anchor, then rebuilds a
 * combined RAG file from all chunk data stored in the chain.
 *
 * Order of operations:
 *   1. Restore the lorebook from the LKG anchor.
 *   2. Restore the hooks summary from the LKG anchor.
 *   3. Reconstruct chunks from the full chain history (fast: stamp scan; deep: AI reclassify).
 *   4. Purge all existing DB chunks for this character, then re-insert rebuilt chunks.
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
  <li>Clear and restore the lorebook from the last anchor</li>
  <li>Restore the hooks summary from the last anchor</li>
  <li>Purge the vector DB and re-index all chunks from the full chain history</li>
</ul>
<label style="display:flex;align-items:center;gap:0.5em;margin-top:0.75em;">
  <input type="checkbox" id="cnz-purge-deep">
  Reclassify all chunks with AI (slow)
</label>
<p style="margin-top:0.5em">This cannot be undone.</p>`, 'confirm');
    if (!confirmed) return;

    const deepReclassify = document.getElementById('cnz-purge-deep')?.checked ?? false;

    try {
        // ── 1 & 2. Restore lorebook and hooks from LKG ───────────────────────────
        const fakeNodeFile = { state: { uuid: chain.lkg.uuid ?? null, lorebook: chain.lkg.lorebook, hooks: chain.lkg.hooks } };
        await restoreLorebookToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);
        restoreHooksToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);

        // ── 3. Reconstruct chunks ─────────────────────────────────────────────────
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
                    pairStart,
                    pairEnd,
                    status:     'complete',
                });
                prevPairEnd = pairEnd;
            }
        }

        if (combinedChunks.length === 0) {
            toastr.warning('CNZ: No classified chunks found in chain — RAG DB not rebuilt. Run a sync first.');
            return;
        }

        // ── 4. Purge DB and re-insert, preserving per-anchor identity ────────────
        const avatarKey = cnzAvatarKey(char.avatar);
        await purgeCharacterChunks(avatarKey);

        const chatFile = ctx.getCurrentChatFile?.() ?? null;
        const total    = combinedChunks.length;

        // Assign each chunk to the anchor that owns its pairStart.
        // Each anchor's boundary is the max pairEnd across its ragHeaders.
        // Works for both fast (exact boundary preservation) and deep (AI may
        // redraw boundaries — chunks pop up to the next anchor rather than
        // creating gaps). Chunks beyond all anchor boundaries fall to HEAD.
        const boundaries = chain.anchors
            .map(({ anchor }) => ({
                uuid:       anchor.uuid,
                maxPairEnd: (anchor.ragHeaders ?? []).reduce((m, rh) => Math.max(m, rh.pairEnd ?? 0), 0),
            }))
            .filter(b => b.maxPairEnd > 0)
            .sort((a, b) => a.maxPairEnd - b.maxPairEnd);

        const byAnchor = new Map();
        for (const chunk of combinedChunks) {
            let uuid = chain.lkg.uuid;
            for (const b of boundaries) {
                if (chunk.pairStart < b.maxPairEnd) { uuid = b.uuid; break; }
            }
            if (!byAnchor.has(uuid)) byAnchor.set(uuid, []);
            byAnchor.get(uuid).push(chunk);
        }
        for (const [uuid, chunks] of byAnchor) {
            await insertSyncChunks(avatarKey, uuid, chatFile, chunks, 0);
        }

        toastr.success(`CNZ: Rebuild complete — ${total} chunks re-indexed.`);
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
            <p>The lorebook and vector DB still contain entries from the previous session.</p>
            <p>The following will be cleared:</p>
            <ul>
                <li>Lorebook entries wiped</li>
                <li>Vector DB chunks purged</li>
            </ul>
            <p><em>Skip to manage manually via Settings → Purge &amp; Rebuild.</em></p>`,
            'confirm',
        );

        if (confirmed) {
            if (state._lorebookName) {
                await lbSaveLorebook(state._lorebookName, { entries: {} }, { silent: true });
                state._lorebookData  = { name: state._lorebookName, entries: {} };
                state._draftLorebook = structuredClone(state._lorebookData);
            }

            await purgeCharacterChunks(cnzAvatarKey(char.avatar));
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
 * Purges all CNZ vector DB chunks for the current character. Does not touch
 * the lorebook or hooks. Chunks can be rebuilt via Purge & Rebuild.
 */
export async function purgeCnzFiles() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const { escapeHtml } = await import('../state.js');
    const confirmed = await callPopup(
        `<h3>Purge CNZ Vector DB</h3>
        <p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
        <ul>
            <li>Purge all CNZ chunks from the vector DB</li>
        </ul>
        <p>The lorebook and hooks will not be changed.</p>
        <p>Chunks can be rebuilt at any time via Purge &amp; Rebuild.</p>`,
        'confirm',
    );
    if (!confirmed) return;

    try {
        await purgeCharacterChunks(cnzAvatarKey(char.avatar));
        toastr.success('CNZ: Vector DB chunks purged.');
    } catch (err) {
        error('Maintenance', 'purgeCnzFiles:', err);
        toastr.error(`CNZ: Purge failed: ${err.message}`);
    }
}
