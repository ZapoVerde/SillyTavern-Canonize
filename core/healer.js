/**
 * @file data/default-user/extensions/canonize/core/healer.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Stateful Owner
 * @description
 * Owns branch detection and state restoration orchestration. Walks the DNA 
 * chain to find the deepest still-valid anchor and restores world state. 
 * Provides the "Purge & Rebuild" hard-reset utility.
 *
 * @api-declaration
 * runHealer, maybePromptLorebookCleanup, purgeAndRebuild
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook,
 *                       state._dnaChain, state._stagedProsePairs, state._stagedPairOffset,
 *                       state._splitPairIdx, state._ragChunks]
 *     external_io: [/api/chats/saveChat, /api/db-purge, /api/db-ingest]
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain, findLkgAnchorByPosition, buildNodeFileFromAnchor } from './dna-chain.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { buildRagChunks, waitForRagChunks, buildRagDocument } from '../rag/pipeline.js';
import { setDnaChain } from '../scheduler.js';
import { lbGetLorebook } from '../lorebook/api.js';
import { cnzAvatarKey, cnzFileName, uploadRagFile, registerCharacterAttachment } from '../rag/api.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { error } from '../log.js';

// Refactored logic imports
import { 
    restoreLorebookToNode, 
    restoreHooksToNode, 
    restoreRagToNode 
} from './reconciliation.js';
import { 
    runNewChatCleanup 
} from './cleanup-logic.js';

// ─── Healer Core ──────────────────────────────────────────────────────────────

/**
 * Checks whether the lorebook on disk and character attachments match the head 
 * anchor. Restores silently from the head anchor if they are stale.
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
        } catch (_) { /* unreachable lorebook */ }
    }

    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzAttachments = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
    const expectedRag    = headAnchor.ragUrl ? headAnchor.ragUrl.split('/').pop() : null;
    
    const ragStale       = expectedRag
        ? cnzAttachments.length !== 1 || cnzAttachments[0].name !== expectedRag
        : cnzAttachments.length > 0;

    if (!lorebookStale && !ragStale) return;

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
        toastr.info('CNZ: World state corrected to match current chat.');
    } catch (err) {
        error('Healer', 'reconcileWorldState failed:', err);
        toastr.warning('CNZ: World state may not match current chat.');
    }
}

/**
 * Detects if a legacy or stale lorebook is attached to a chat with no DNA chain.
 * @param {object} char  Current character object.
 */
export async function maybePromptLorebookCleanup(char) {
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (!lorebookName) return;
    let lbData;
    try { lbData = await lbGetLorebook(lorebookName); }
    catch (_) { return; }
    if (!lbData?.extensions?.cnz_anchor_uuid) return;
    state._lorebookName = lorebookName;
    await runNewChatCleanup(char);
}

/**
 * Main healer entry point. Checks for timeline branches and restores state.
 * @param {object} char         Current character object.
 * @param {string} _chatFileName Unused.
 */
export async function runHealer(char, _chatFileName) {
    const messages = SillyTavern.getContext().chat ?? [];
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
        <p>The current chat diverges from the sync point at <strong>message ${restorePoint}</strong>.</p>
        <p>CNZ will restore world state to that point.</p>`,
        'confirm',
    );
    if (!confirmed) return;

    try {
        const nodeFile   = buildNodeFileFromAnchor(lkgRef.anchor);
        const nodeDummy  = { nodeId: lkgRef.anchor.uuid };

        await restoreLorebookToNode(char, nodeDummy, nodeFile);
        await restoreHooksToNode(char, nodeDummy, nodeFile);
        await restoreRagToNode(char, nodeFile);

        state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(state._dnaChain);
        toastr.warning(`CNZ: Branch healed — restored to message ${restorePoint}.`);
    } catch (err) {
        error('Healer', 'runHealer: restoration failed:', err);
    }
}

/**
 * Hard-resets the external world to match the LKG anchor.
 */
export async function purgeAndRebuild() {
    const { isSyncInProgress } = await import('../scheduler.js');
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync in progress.');
        return;
    }
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) return;

    const messages = ctx.chat ?? [];
    const chain    = readDnaChain(messages);
    if (!chain.lkg) {
        toastr.warning('CNZ: No anchor found.');
        return;
    }

    const confirmed = await callPopup(`
<h3>Purge &amp; Rebuild</h3>
<p>This will delete all CNZ RAG files and restore world state from the last anchor.</p>`, 'confirm');
    if (!confirmed) return;

    try {
        const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
        const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
        const cnzFiles       = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
        
        const { cnzDeleteFile } = await import('../rag/api.js');
        for (const f of cnzFiles) {
            await cnzDeleteFile(f.url);
        }
        extension_settings.character_attachments[char.avatar] = allAttachments.filter(a => !cnzFiles.includes(a));
        saveSettingsDebounced();

        const fakeNodeFile = { 
            state: { 
                uuid: chain.lkg.uuid ?? null, 
                lorebook: chain.lkg.lorebook, 
                hooks: chain.lkg.hooks 
            } 
        };
        await restoreLorebookToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);
        await restoreHooksToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);

        const allPairs    = buildProsePairs(messages);
        const ragSettings = getSettings();
        let combined      = [];
        let prevEnd       = 0;
        
        for (let i = 0; i < allPairs.length; i++) {
            const lastMsg = allPairs[i]?.messages?.[allPairs[i].messages.length - 1];
            if (!lastMsg?.extra?.cnz_chunk_header) continue;
            const start = prevEnd;
            const end   = i + 1;
            combined.push({
                chunkIndex: combined.length,
                header:     lastMsg.extra.cnz_chunk_header,
                turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${start + 1}–${end}`,
                content:    formatPairsAsTranscript(allPairs.slice(start, end)),
                status:     'complete',
            });
            prevEnd = end;
        }

        if (combined.length > 0) {
            const ragText     = buildRagDocument(combined, ragSettings, char.name);
            const anchorHash  = chain.lkg.uuid?.slice(0, 8) ?? '';
            const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name, anchorHash);
            const ragUrl      = await uploadRagFile(ragText, ragFileName);
            registerCharacterAttachment(char.avatar, ragUrl, ragFileName, new TextEncoder().encode(ragText).length);
            for (const { msgIdx } of chain.anchors) {
                if (messages[msgIdx]?.extra?.cnz) messages[msgIdx].extra.cnz.ragUrl = ragUrl;
            }
            await ctx.saveChat();
        }

        await ctx.executeSlashCommandsWithOptions('/db-purge');
        await ctx.executeSlashCommandsWithOptions('/db-ingest');
        toastr.success(`CNZ: Rebuild complete.`);
    } catch (err) {
        error('Healer', 'purgeAndRebuild:', err);
    }
}