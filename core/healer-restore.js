/**
 * @file data/default-user/extensions/canonize/core/healer-restore.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Moves lorebook, hooks, and RAG attachment state in and out of external
 * storage during a heal operation. Receives fully-resolved node file objects
 * from callers — no anchor resolution, no sequencing, no decisions about what
 * to restore. One function = one write.
 *
 * @api-declaration
 * restoreLorebookToNode(char, node, nodeFile)
 * restoreHooksToNode(char, node, nodeFile)
 * restoreRagToNode(char, nodeFile)
 * cnzDeleteFile(path)
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [/api/worldinfo/*, /api/files/delete, /db-purge, /db-ingest,
 *                   extension_settings.character_attachments, saveSettingsDebounced]
 */

import { extension_settings } from '../../../../extensions.js';
import { saveSettingsDebounced } from '../../../../../script.js';
import { state } from '../state.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { cnzAvatarKey } from '../rag/api.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';

/**
 * Restores the lorebook to the full snapshot stored in `nodeFile.state.lorebook`.
 * Writes to disk and updates in-memory state.
 * @param {object} _char    Character object (unused; kept for call-site symmetry).
 * @param {object} node     Chain entry — used only for error messages.
 * @param {object} nodeFile Full node file object with state.lorebook and state.uuid.
 */
export async function restoreLorebookToNode(_char, node, nodeFile = null) {
    if (!nodeFile?.state?.lorebook) throw new Error(`[CNZ] No lorebook state in node ${node.nodeId}`);
    const lbData = structuredClone(nodeFile.state.lorebook);
    const lbName = lbData.name || state._lorebookName;
    lbData.extensions = { ...(lbData.extensions ?? {}), cnz_anchor_uuid: nodeFile.state?.uuid ?? null };
    await lbSaveLorebook(lbName, lbData);
    state._lorebookName  = lbName;
    state._lorebookData  = structuredClone(lbData);
    state._draftLorebook = structuredClone(lbData);
}

/**
 * Restores the CNZ Summary prompt to the hooks state stored in `nodeFile.state.hooks`.
 * @param {object} char     Character object from ST context.
 * @param {object} _node    Chain entry (unused; kept for call-site symmetry).
 * @param {object} nodeFile Full node file object with state.hooks and state.uuid.
 */
export function restoreHooksToNode(char, _node, nodeFile = null) {
    const hooksText  = nodeFile?.state?.hooks ?? '';
    const anchorUuid = nodeFile?.state?.uuid  ?? null;
    writeCnzSummaryPrompt(char.avatar, hooksText, anchorUuid);
}

/**
 * Reconciles RAG character attachments to the state recorded in `nodeFile`.
 * Removes attachments belonging to orphaned nodes, deletes their files from
 * the Data Bank, then triggers a full vector purge and re-ingest.
 * @param {object} char      Character object from ST context.
 * @param {object} nodeFile  Full node file object with state.ragFiles.
 */
export async function restoreRagToNode(char, nodeFile) {
    const survivingFiles = nodeFile.state?.ragFiles ?? [];

    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;

    const toRemove = allAttachments.filter(
        a => a.name?.startsWith(cnzRagPrefix) && !survivingFiles.includes(a.name)
    );
    const toKeep = allAttachments.filter(a => !toRemove.includes(a));

    extension_settings.character_attachments[char.avatar] = toKeep;
    saveSettingsDebounced();

    for (const attachment of toRemove) {
        await cnzDeleteFile(attachment.url);
    }

    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    await executeSlashCommandsWithOptions('/db-purge');
    await executeSlashCommandsWithOptions('/db-ingest');
}

/**
 * Lazy-loaded delegation to rag/api.cnzDeleteFile.
 * Deferred to avoid a circular dependency at module load time.
 * @param {string} path
 */
export async function cnzDeleteFile(path) {
    const { cnzDeleteFile: _del } = await import('../rag/api.js');
    return _del(path);
}
