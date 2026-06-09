/**
 * @file data/default-user/extensions/canonize/core/healer-restore.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Moves lorebook and hook state in and out of external storage during a heal
 * operation. Receives fully-resolved node file objects from callers — no
 * anchor resolution, no sequencing, no decisions about what to restore.
 * One function = one write.
 *
 * @api-declaration
 * restoreLorebookToNode(char, node, nodeFile)
 * restoreHooksToNode(char, node, nodeFile)
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [/api/worldinfo/*]
 */

import { state } from '../state.js';
import { lbSaveLorebook } from '../lorebook/api.js';
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
    await lbSaveLorebook(lbName, lbData, { silent: true });
    state._lorebookName  = lbName;
    state._lorebookData  = structuredClone(lbData);
    state._draftLorebook = structuredClone(lbData);
}

/**
 * Restores the CNZ Summary prompt and plot lorebook name from a node file.
 * Reads `state.scene` (new) with fallback to `state.hooks` (legacy anchors).
 * Also seeds state._plotLorebookName from the anchor so the next sync writes
 * to the correct plot lorebook file.
 * @param {object} char     Character object from ST context.
 * @param {object} _node    Chain entry (unused; kept for call-site symmetry).
 * @param {object} nodeFile Full node file object.
 */
export function restoreHooksToNode(char, _node, nodeFile = null) {
    const sceneText  = nodeFile?.state?.scene ?? nodeFile?.state?.hooks ?? '';
    const anchorUuid = nodeFile?.state?.uuid  ?? null;
    writeCnzSummaryPrompt(char.avatar, sceneText, anchorUuid);
    state._priorSituation   = sceneText;
    state._plotLorebookName = nodeFile?.state?.plotLorebookName ?? null;
}

