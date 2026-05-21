/**
 * @file data/default-user/extensions/canonize/core/sync-helpers.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * Private helpers for the sync pipeline. Handles lorebook update processing,
 * hookseeker output application, DNA anchor commit, and sync start logging.
 * All exports are consumed exclusively by core/sync.js.
 *
 * @api-declaration
 * logSyncStart(hookPairs, lbPairs, ragPairs, coverAll, chunkEveryN)
 * processLorebookUpdate(rawText, anchorUuid) — parses AI output, saves lorebook
 * processHooksUpdate(hooksText) — writes hookseeker output to ST summary prompt
 * commitDnaAnchor(messages, anchorUuid) — writes DNA anchor and link chain
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [lorebook API, DNA chain, ST summary prompt]
 */

import { log, warn } from '../log.js';
import { setDnaChain } from '../scheduler.js';
import { readDnaChain, getLkgAnchor, buildAnchorPayload,
         writeDnaAnchor, writeDnaLinks } from './dna-chain.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { parseLbSuggestions, enrichLbSuggestions,
         nextLorebookUid, makeLbDraftEntry,
         stripProtectedBlock, stitchProtectedBlock } from '../lorebook/utils.js';
import { state } from '../state.js';

export function logSyncStart(hookPairs, lbPairs, ragPairs, coverAll, chunkEveryN) {
    const fmt = pairs => pairs.length > 0
        ? `turns ${pairs[0].validIdx + 1}–${pairs[pairs.length - 1].validIdx + 1} (${pairs.length} pairs)`
        : '(none)';
    const lbLabel = lbPairs === hookPairs ? `${fmt(lbPairs)} [same as hookseeker]` : fmt(lbPairs);
    log('Sync',
        `── SYNC START ── coverAll=${coverAll} window=${chunkEveryN}\n` +
        `  hookseeker: ${fmt(hookPairs)}\n` +
        `  lorebook:   ${lbLabel}\n` +
        `  rag:        ${fmt(ragPairs)}`
    );
}

export async function processLorebookUpdate(rawText, anchorUuid = null) {
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

export function processHooksUpdate(hooksText) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');
    writeCnzSummaryPrompt(char.avatar, hooksText.trim(), null);
}

export async function commitDnaAnchor(messages, anchorUuid) {
    if (state._stagedProsePairs.length === 0) {
        warn('DnaChain', 'commitDnaAnchor: no staged pairs — skipping anchor write');
        return;
    }

    const anchorPairIdx = state._stagedProsePairs.length - 1;
    const anchorPair   = state._stagedProsePairs[anchorPairIdx];

    const lkg        = getLkgAnchor(messages);
    const parentUuid = lkg?.anchor?.uuid ?? null;

    const ragHeaders = state._ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({
            chunkIndex: c.chunkIndex,
            header:     c.header,
            turnRange:  c.turnRange,
            pairStart:  state._stagedPairOffset + c.pairStart,
            pairEnd:    state._stagedPairOffset + c.pairEnd,
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

    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    log('DnaChain', 'commitDnaAnchor: anchor written uuid=' + anchor.uuid + ' pairs=' + state._stagedProsePairs.length);
}
