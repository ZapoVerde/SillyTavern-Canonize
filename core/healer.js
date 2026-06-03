/**
 * @file data/default-user/extensions/canonize/core/healer.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 2.1.0
 * @architectural-role Orchestrator
 * @description
 * Branch detection and state restoration. Walks the DNA chain to find the
 * deepest still-valid anchor, then sequences the restore calls to bring
 * lorebook and hooks back into coherence with the current chat position.
 * Also reconciles world state silently when the timeline is intact but external
 * storage has drifted (e.g. left behind by a different chat). Includes auto
 * RAG DB rebuild from chat stamp data when the vector DB is empty.
 *
 * Restore IO lives in healer-restore.js. User-initiated maintenance operations
 * live in maintenance.js (rebuildRag) and maintenance-cleanup.js
 * (runNewChatCleanup, purgeCnzFiles).
 *
 * @api-declaration
 * runHealer(char, chatFileName)
 *
 * Re-exports (from healer-restore.js, for backward compat):
 * restoreLorebookToNode, restoreHooksToNode
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._dnaChain, state._lorebookName]
 *     external_io: [callPopup, toastr, lorebook via healer-restore.js,
 *                   healer-restore.js, scheduler.setDnaChain,
 *                   file-store.js, file-store-lb.js]
 */

import { callPopup } from '../../../../../script.js';
import { getStringHash } from '../../../../utils.js';
import { state } from '../state.js';
import { readDnaChain, findLkgAnchorByPosition, buildNodeFileFromAnchor } from './dna-chain.js';
import { setDnaChain } from '../scheduler.js';
import { lbGetLorebook } from '../lorebook/api.js';
import { error, log } from '../log.js';
import { restoreLorebookToNode, restoreHooksToNode } from './healer-restore.js';
import { getSettings } from './settings.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { anchorChunkCount, insertSyncChunks } from '../rag/file-store.js';
import { insertLorebookEntries } from '../rag/file-store-lb.js';
import { cnzAvatarKey, cnzPlotLbName } from '../rag/api.js';
import { rebuildPlotLorebook } from '../lorebook/plot-lorebook.js';

// Re-export restore ops — callers that import from healer.js keep working.
export { restoreLorebookToNode, restoreHooksToNode } from './healer-restore.js';

// ─── Plot Lorebook Reconciliation ─────────────────────────────────────────────

/**
 * Walks the full DNA chain to rebuild the plot lorebook file and ensure all
 * plot entries are vectorized. Safe to call when the file already exists —
 * the lorebook write is idempotent and insertLorebookEntries uses upsert.
 * No-op if the chain carries no plot entries.
 */
async function _reconcilePlotLorebook(char, chain) {
    const anchors = chain?.anchors ?? [];
    const anchorChunks = anchors
        .map(ref => ({ uuid: ref.anchor.uuid, entries: ref.anchor.plotEntries ?? [] }))
        .filter(c => c.entries.length > 0);
    if (!anchorChunks.length) return;

    const plotLbName = chain.lkg?.plotLorebookName ?? cnzPlotLbName(char.avatar);
    state._plotLorebookName = plotLbName;

    try {
        await rebuildPlotLorebook(plotLbName, anchorChunks);
        log('Healer', `Plot lorebook rebuilt: "${plotLbName}" (${anchorChunks.reduce((n, c) => n + c.entries.length, 0)} entries)`);
    } catch (err) {
        error('Healer', 'Plot lorebook rebuild failed:', err);
        return;
    }

    const avatarKey = cnzAvatarKey(char.avatar);
    for (const { uuid, entries } of anchorChunks) {
        try {
            await insertLorebookEntries(avatarKey, uuid, plotLbName, entries);
        } catch (err) {
            error('Healer', `Plot entry vectorization failed (anchor ${uuid}):`, err);
        }
    }
    log('Healer', 'Plot entry vectorization complete');
}

// ─── RAG Auto-Reconciliation ──────────────────────────────────────────────────

/**
 * Silently rebuilds the vector DB from cnz_chunk_header stamps already written
 * to chat messages, when RAG is enabled but the DB is empty for this character.
 * No-ops if the plugin is unreachable or no stamps are found.
 */
async function _reconcileRagChunks(char, headAnchor) {

    try {
        const avatarKey = cnzAvatarKey(char.avatar);
        const counts    = await anchorChunkCount(avatarKey, headAnchor.uuid);

        // ── Chat chunks ───────────────────────────────────────────────────────
        if ((counts.chunksForCharacter ?? 0) === 0) {
            log('Healer', 'RAG DB empty — rebuilding chat chunks from stamps');

            const ctx      = SillyTavern.getContext();
            const allPairs = buildProsePairs(ctx.chat ?? []);
            const chatFile = ctx.getCurrentChatFile?.() ?? null;
            const chunks   = [];
            let prevEnd    = 0;

            for (let i = 0; i < allPairs.length; i++) {
                const pair    = allPairs[i];
                const lastMsg = pair?.messages?.[pair.messages.length - 1];
                if (!lastMsg?.extra?.cnz_chunk_header) continue;
                const content = formatPairsAsTranscript(allPairs.slice(prevEnd, i + 1));
                chunks.push({
                    chunkIndex: chunks.length,
                    header:     lastMsg.extra.cnz_chunk_header,
                    turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${prevEnd + 1}–${i + 1}`,
                    content,
                    pairStart:  prevEnd,
                    pairEnd:    i + 1,
                    status:     'complete',
                });
                prevEnd = i + 1;
            }

            if (chunks.length) {
                await insertSyncChunks(avatarKey, headAnchor.uuid, chatFile, chunks, 0);
                log('Healer', `RAG auto-reconcile: indexed ${chunks.length} chat chunks`);
                toastr.info(`CNZ: Auto-indexed ${chunks.length} chunks from chat history.`);
            }
        }

        // ── Lorebook entries ──────────────────────────────────────────────────
        const lbSnapshot = headAnchor.lorebook ?? {};
        const lbName     = lbSnapshot.name ?? char?.data?.extensions?.world ?? char?.name;
        const rawEntries = Object.values(lbSnapshot.entries ?? {});
        const entries    = rawEntries
            .filter(e => e.disable !== true && e.content?.trim())
            .map(e => ({ uid: e.uid, content: e.content, keys: e.key ?? [], comment: e.comment ?? '' }));

        if (entries.length && lbName) {
            const knownHashes = new Set(counts.lbHashesForAnchor ?? []);
            const missing     = entries.filter(e => !knownHashes.has(getStringHash(e.content)));
            if (missing.length) {
                log('Healer', `Indexing ${missing.length}/${entries.length} lorebook entries for "${lbName}"`);
                await insertLorebookEntries(avatarKey, headAnchor.uuid, lbName, missing);
                log('Healer', `Lorebook entries indexed`);
                toastr.info(`CNZ: Auto-indexed ${missing.length} lorebook entries for "${lbName}".`);
            }
        }
    } catch (err) {
        error('Healer', 'RAG auto-reconcile failed:', err);
    }
}

// ─── Silent Reconciliation ────────────────────────────────────────────────────

/**
 * Called when the timeline is intact (head hash matches). Checks whether the
 * lorebook on disk matches the head anchor, and whether the RAG vector DB has
 * chunks for this character. Restores/rebuilds silently if either has drifted.
 * @param {object} char        Current character object from context.
 * @param {object} headAnchor  The head CnzAnchor from the DNA chain.
 */
async function reconcileWorldState(char, headAnchor) {
    let lorebookStale = false;
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (lorebookName) {
        try {
            const lbData  = await lbGetLorebook(lorebookName);
            lorebookStale = lbData?.extensions?.cnz_anchor_uuid !== headAnchor.uuid;
        } catch (_) { /* unreachable lorebook — skip */ }
    }

    if (lorebookStale) {
        try {
            const nodeFile  = buildNodeFileFromAnchor(headAnchor);
            const nodeDummy = { nodeId: headAnchor.uuid };

            await restoreLorebookToNode(char, nodeDummy, nodeFile);
            restoreHooksToNode(char, nodeDummy, nodeFile);
            toastr.info('CNZ: World state corrected to match current chat.');
        } catch (err) {
            error('Healer', 'reconcileWorldState failed:', err);
            toastr.warning('CNZ: World state may not match current chat — use Purge & Rebuild if needed.');
        }
    }

    await _reconcileRagChunks(char, headAnchor);
    await _reconcilePlotLorebook(char, state._dnaChain);
}

// ─── New Chat Guard ───────────────────────────────────────────────────────────

/**
 * Checks whether the lorebook on disk carries a CNZ anchor UUID that does not
 * match the current (anchor-free) chat, then delegates to runNewChatCleanup.
 * @param {object} char  Current character object from context.
 */
async function maybePromptLorebookCleanup(char) {
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (!lorebookName) return;
    let lbData;
    try { lbData = await lbGetLorebook(lorebookName); }
    catch (_) { return; }
    if (!lbData?.extensions?.cnz_anchor_uuid) return;
    state._lorebookName = lorebookName;
    const { runNewChatCleanup } = await import('./maintenance-cleanup.js');
    await runNewChatCleanup(char);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the DNA chain against the current chat history to detect branches.
 * Outcomes:
 *   - Same timeline (head hash matches) → reconcile silently.
 *   - No matching node (pre-CNZ or unrelated chat) → silent return.
 *   - Branch detected → confirm → restore + toastr.warning.
 *   - Restoration failure → toastr.error.
 *
 * @param {object} char           Current character object from context.
 * @param {string} _chatFileName  Kept for call-site signature parity; unused.
 */
export async function runHealer(char, _chatFileName) {
    const context  = SillyTavern.getContext();
    const messages = context.chat ?? [];

    state._dnaChain = readDnaChain(messages);
    setDnaChain(state._dnaChain);

    if (state._dnaChain.anchors.length === 0) {
        await maybePromptLorebookCleanup(char);
        return;
    }

    if (!messages.length) return;

    const headRef = state._dnaChain.anchors[state._dnaChain.anchors.length - 1];
    if (messages[headRef.msgIdx]?.extra?.cnz?.uuid === headRef.anchor.uuid) {
        state._lorebookName     = headRef.anchor.lorebook?.name || char?.data?.extensions?.world || char?.name || '';
        state._plotLorebookName = headRef.anchor.plotLorebookName ?? cnzPlotLbName(char.avatar);
        await reconcileWorldState(char, headRef.anchor);
        return;
    }

    const lkgRef = findLkgAnchorByPosition(state._dnaChain.anchors, messages);
    if (!lkgRef) return;

    const restorePoint = lkgRef.msgIdx + 1;
    const confirmed = await callPopup(
        `<h3>CNZ: Timeline Branch Detected</h3>
        <p>The current chat diverges from the last committed sync point at
        <strong>message ${restorePoint}</strong>.</p>
        <p>CNZ will restore world state to that point:</p>
        <ul>
            <li>Lorebook entries rolled back</li>
            <li>Narrative hooks rolled back</li>
        </ul>
        <p>This cannot be undone.</p>`,
        'confirm',
    );

    if (!confirmed) {
        toastr.warning(
            'CNZ: Timeline branch detected but restoration was cancelled — ' +
            'world state may not match the current chat.',
            '', { timeOut: 0, extendedTimeOut: 0, closeButton: true },
        );
        return;
    }

    try {
        const nodeFile  = buildNodeFileFromAnchor(lkgRef.anchor);
        const nodeDummy = { nodeId: lkgRef.anchor.uuid };

        await restoreLorebookToNode(char, nodeDummy, nodeFile);
        restoreHooksToNode(char, nodeDummy, nodeFile);

        state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(state._dnaChain);

        toastr.warning(`CNZ: Branch detected — restored to message ${restorePoint}.`);
    } catch (err) {
        error('Healer', 'Healer: restoration failed:', err);
        toastr.error('CNZ: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}
