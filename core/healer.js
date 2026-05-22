/**
 * @file data/default-user/extensions/canonize/core/healer.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 2.0.0
 * @architectural-role Orchestrator
 * @description
 * Branch detection and state restoration. Walks the DNA chain to find the
 * deepest still-valid anchor, then sequences the restore calls to bring
 * lorebook, hooks, and RAG back into coherence with the current chat position.
 * Also reconciles world state silently when the timeline is intact but external
 * storage has drifted (e.g. left behind by a different chat).
 *
 * Restore IO lives in healer-restore.js. User-initiated maintenance operations
 * (purgeAndRebuild, runNewChatCleanup, purgeCnzFiles) live in maintenance.js.
 *
 * @api-declaration
 * runHealer(char, chatFileName)
 *
 * Re-exports (from healer-restore.js, for backward compat):
 * restoreLorebookToNode, restoreHooksToNode, restoreRagToNode
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._dnaChain, state._lorebookName]
 *     external_io: [callPopup, toastr, lorebook via healer-restore.js,
 *                   healer-restore.js, scheduler.setDnaChain]
 */

import { callPopup } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { state } from '../state.js';
import { readDnaChain, findLkgAnchorByPosition, buildNodeFileFromAnchor } from './dna-chain.js';
import { setDnaChain } from '../scheduler.js';
import { lbGetLorebook } from '../lorebook/api.js';
import { cnzAvatarKey } from '../rag/api.js';
import { error } from '../log.js';
import { restoreLorebookToNode, restoreHooksToNode, restoreRagToNode } from './healer-restore.js';

// Re-export restore ops — callers that import from healer.js keep working.
export { restoreLorebookToNode, restoreHooksToNode, restoreRagToNode } from './healer-restore.js';

// ─── Silent Reconciliation ────────────────────────────────────────────────────

/**
 * Called when the timeline is intact (head hash matches). Checks whether the
 * lorebook on disk and RAG attachments match the head anchor. Restores silently
 * from the head anchor if either has drifted — no confirmation needed since the
 * timeline is known-good.
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

    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzAttachments = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));

    let ragStale = false;
    const expectedRag = headAnchor.ragUrl ? headAnchor.ragUrl.split('/').pop() : null;
    // Guard: if the anchor expects a RAG file but the character has no registry
    // key at all, skip — the attachments registry likely hasn't loaded yet
    // (cold-boot race). An absent key differs from []: [] means registered-but-empty.
    const charKeyExists = Object.prototype.hasOwnProperty.call(
        extension_settings.character_attachments ?? {}, char.avatar
    );
    if (!expectedRag || charKeyExists) {
        ragStale = expectedRag
            ? cnzAttachments.length !== 1 || cnzAttachments[0].name !== expectedRag
            : cnzAttachments.length > 0;
    }

    if (!lorebookStale && !ragStale && !legacyRagCleared) return;

    try {
        const nodeFile  = buildNodeFileFromAnchor(headAnchor);
        const nodeDummy = { nodeId: headAnchor.uuid };

        if (lorebookStale) {
            await restoreLorebookToNode(char, nodeDummy, nodeFile);
            restoreHooksToNode(char, nodeDummy, nodeFile);
        }
        if (ragStale) {
            try {
                await restoreRagToNode(char, nodeFile);
            } catch (err) {
                error('Healer', 'reconcileWorldState: RAG reconciliation failed:', err);
                toastr.warning('CNZ: World state partially corrected — RAG index may be inconsistent.');
                return;
            }
        }
        if (lorebookStale || ragStale || legacyRagCleared) {
            toastr.info('CNZ: World state corrected to match current chat.');
        }
    } catch (err) {
        error('Healer', 'reconcileWorldState failed:', err);
        toastr.warning('CNZ: World state may not match current chat — use Purge & Rebuild if needed.');
    }
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
    const { runNewChatCleanup } = await import('./maintenance.js');
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
            <li>RAG file reconciled</li>
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
        await restoreHooksToNode(char, nodeDummy, nodeFile);

        try {
            await restoreRagToNode(char, nodeFile);
        } catch (err) {
            error('Healer', 'RAG reconciliation failed:', err);
            toastr.warning('CNZ: Branch healed but RAG reconciliation failed — vector index may be inconsistent.');
        }

        state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(state._dnaChain);

        toastr.warning(`CNZ: Branch detected — restored to message ${restorePoint}.`);
    } catch (err) {
        error('Healer', 'Healer: restoration failed:', err);
        toastr.error('CNZ: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}
