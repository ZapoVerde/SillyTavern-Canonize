/**
 * @file data/default-user/extensions/canonize/core/sync-processors.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @architectural-role Stateful Owner / IO Wrapper
 * @description
 * Processes raw AI text results from sync lanes into structured state updates.
 * Handles lorebook suggestion staging, hooks prompt updates, and the 
 * coordination of DNA anchor commits to the chat history.
 *
 * @api-declaration
 * processLorebookUpdate, processHooksUpdate, commitDnaAnchor
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookName, state._lorebookData, state._draftLorebook, state._lorebookSuggestions, state._priorSituation, state._dnaChain]
 *     external_io: [/api/worldinfo/edit, /api/chats/saveChat]
 */

import { state } from '../state.js';
import { log, warn } from '../log.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { 
    parseLbSuggestions, enrichLbSuggestions, nextLorebookUid, 
    makeLbDraftEntry, stitchProtectedBlock, stripProtectedBlock 
} from '../lorebook/utils.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { 
    getLkgAnchor, buildAnchorPayload, writeDnaAnchor, 
    writeDnaLinks, readDnaChain 
} from './dna-chain.js';
import { setDnaChain } from '../scheduler.js';

/**
 * Parses raw lorebook AI output and applies all suggestions to _draftLorebook.
 * Stores narrative-only content; protected blocks are re-attached at commit time.
 * @param {string} rawText  Raw AI output from the lorebook sync call.
 * @param {string|null} anchorUuid UUID of the anchor being processed.
 * @returns {Promise<void>}
 */
export async function processLorebookUpdate(rawText, anchorUuid = null) {
    // 1. Parse and update AI suggestions if they exist
    if (rawText.trim() && rawText.trim() !== 'NO CHANGES NEEDED') {
        const suggestions = parseLbSuggestions(rawText);
        state._lorebookSuggestions = enrichLbSuggestions(suggestions);

        for (const s of state._lorebookSuggestions) {
            const narrative = s._aiSnapshot.content.trim();

            if (s.linkedUid !== null) {
                const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
                if (entry) {
                    entry.comment = s.name;
                    entry.key     = s._aiSnapshot.keys;
                    entry.content = narrative;
                }
            } else {
                const uid = nextLorebookUid();
                state._draftLorebook.entries[String(uid)] = makeLbDraftEntry(
                    uid, s.name, s._aiSnapshot.keys, narrative,
                );
                s.linkedUid = uid;
            }
            s.status = 'pending';
        }
    }

    // 2. Save the result — blindly re-attach any protected block from the prior saved state.
    const preLorebook = state._lorebookData ?? { entries: {} };
    const stitchedLorebook = structuredClone(state._draftLorebook);
    for (const entry of Object.values(stitchedLorebook.entries ?? {})) {
        const origEntry = preLorebook.entries?.[String(entry.uid)];
        entry.content = stitchProtectedBlock(
            stripProtectedBlock(entry.content),
            origEntry?.content ?? '',
        );
    }
    stitchedLorebook.extensions = { ...(stitchedLorebook.extensions ?? {}), cnz_anchor_uuid: anchorUuid };
    await lbSaveLorebook(state._lorebookName, stitchedLorebook);
    state._lorebookData = structuredClone(state._draftLorebook);
}

/**
 * Updates the CNZ Summary prompt with the latest AI-generated hooks text.
 * @param {string} hooksText Raw hookseeker output.
 */
export function processHooksUpdate(hooksText) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');
    writeCnzSummaryPrompt(char.avatar, hooksText.trim(), null);
}

/**
 * Commits the current sync cycle results to the DNA chain by writing a CnzAnchor
 * onto the last AI message of the sync window.
 * @param {object[]} messages Full chat message array.
 * @param {string} anchorUuid The UUID for this sync cycle.
 * @returns {Promise<void>}
 */
export async function commitDnaAnchor(messages, anchorUuid) {
    if (state._stagedProsePairs.length === 0) {
        warn('DnaChain', 'commitDnaAnchor: no staged pairs — skipping anchor write');
        return;
    }

    const anchorPairIdx = state._stagedProsePairs.length - 1;
    const anchorPair    = state._stagedProsePairs[anchorPairIdx];

    const lkg        = getLkgAnchor(messages);
    const parentUuid = lkg?.anchor?.uuid ?? null;

    const ragHeaders = state._ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({ 
            chunkIndex: c.chunkIndex, 
            header: c.header, 
            turnRange: c.turnRange, 
            pairStart: state._stagedPairOffset + c.pairStart, 
            pairEnd: state._stagedPairOffset + c.pairEnd 
        }));

    const anchor = buildAnchorPayload({
        uuid:        anchorUuid,
        committedAt: new Date().toISOString(),
        hooks:       state._priorSituation,
        lorebook:    Object.assign({ name: state._lorebookName }, structuredClone(state._draftLorebook ?? { entries: {} })),
        ragUrl:      state._lastRagUrl || null,
        ragHeaders,
        parentUuid,
    });

    await writeDnaAnchor(anchorPair, anchor);
    await writeDnaLinks(state._stagedProsePairs, anchorPairIdx, anchor.uuid, state._stagedPairOffset);

    // Refresh DNA chain in memory
    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    
    log('DnaChain', 'commitDnaAnchor: anchor written uuid=' + anchor.uuid);
}