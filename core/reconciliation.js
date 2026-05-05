/**
 * @file data/default-user/extensions/canonize/core/reconciliation.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Executor
 * @description
 * Worker module for restoring world state (Lorebook, Hooks, RAG) from DNA 
 * anchor snapshots. Used by the Healer for timeline branches and by the 
 * Session manager for extension re-enabling.
 *
 * @api-declaration
 * restoreLorebookToNode, restoreHooksToNode, restoreRagToNode
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [/api/worldinfo/*, /api/files/delete, /api/chats/saveChat, /api/db-*]
 */

import { state } from '../state.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { cnzAvatarKey, registerCharacterAttachment } from '../rag/api.js';
import { error } from '../log.js';

/**
 * Restores the lorebook to the full snapshot stored in `nodeFile`.
 * @param {object} _char    Character object (unused, kept for signature parity).
 * @param {object} node     Dummy chain entry (used for error messages).
 * @param {object} nodeFile Full node file object.
 */
export async function restoreLorebookToNode(_char, node, nodeFile = null) {
    if (!nodeFile?.state?.lorebook) {
        throw new Error(`[CNZ] No lorebook state in node ${node.nodeId}`);
    }
    const lbData = structuredClone(nodeFile.state.lorebook);
    const lbName = lbData.name || state._lorebookName;
    
    // Stamp anchor UUID into extensions for tracking
    lbData.extensions = { 
        ...(lbData.extensions ?? {}), 
        cnz_anchor_uuid: nodeFile?.state?.uuid ?? null 
    };

    await lbSaveLorebook(lbName, lbData);
    
    state._lorebookName  = lbName;
    state._lorebookData  = structuredClone(lbData);
    state._draftLorebook = structuredClone(lbData);
}

/**
 * Restores the CNZ Summary prompt to the hooks state stored in `nodeFile`.
 * @param {object} char      Character object from ST context.
 * @param {object} _node     Dummy chain entry (unused).
 * @param {object} nodeFile  nodeFile-shaped object with state.hooks and state.uuid.
 */
export function restoreHooksToNode(char, _node, nodeFile = null) {
    const hooksText  = nodeFile?.state?.hooks ?? '';
    const anchorUuid = nodeFile?.state?.uuid  ?? null;
    writeCnzSummaryPrompt(char.avatar, hooksText, anchorUuid);
}

/**
 * Reconciles RAG character attachments to the state recorded in `nodeFile`.
 * 1. Removes attachments belonging to orphaned nodes (and deletes them).
 * 2. Re-attaches the current RAG file if missing from the registry (Soft Detach recovery).
 * 3. Triggers a full vector purge and revectorize.
 * 
 * @param {object} char      Character object from ST context.
 * @param {object} nodeFile  Full node file object.
 */
export async function restoreRagToNode(char, nodeFile) {
    const survivingFiles = nodeFile.state?.ragFiles ?? [];
    const expectedUrl    = nodeFile.state?.ragUrl   ?? null;

    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;

    // ── 1. Identify Orphans vs Survivors ────────────────────────────────────
    const toRemove = allAttachments.filter(
        a => a.name?.startsWith(cnzRagPrefix) && !survivingFiles.includes(a.name)
    );
    const toKeep = allAttachments.filter(a => !toRemove.includes(a));

    extension_settings.character_attachments[char.avatar] = toKeep;

    // ── 2. Handle Soft Detach Recovery (Re-linking) ──────────────────────────
    // If the node has an active RAG file but it's not in the registry, put it back.
    if (expectedUrl && survivingFiles.length > 0) {
        const fileName = survivingFiles[0];
        const isAttached = toKeep.some(a => a.name === fileName);
        
        if (!isAttached) {
            // Re-link existing file. Size is set to 0 as it's primarily for display; 
            // ST will re-index the actual file from disk.
            registerCharacterAttachment(char.avatar, expectedUrl, fileName, 0);
        }
    }

    saveSettingsDebounced();

    // ── 3. Delete orphaned files from Data Bank ──────────────────────────────
    const { cnzDeleteFile } = await import('../rag/api.js');
    for (const attachment of toRemove) {
        await cnzDeleteFile(attachment.url);
    }

    // ── 4. Purge vector index and revectorize ─────────────────────────────────
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    await executeSlashCommandsWithOptions('/db-purge');
    await executeSlashCommandsWithOptions('/db-ingest');
}