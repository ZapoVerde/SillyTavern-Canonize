/**
 * @file data/default-user/extensions/canonize/core/sync-helpers.js
 * @stamp {"utc":"2026-05-27T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Orchestrator
 * @description
 * Private helpers for the sync pipeline. Handles lorebook update processing,
 * hookseeker output application, DNA anchor commit, and sync start logging.
 * All exports are consumed exclusively by core/sync.js.
 *
 * Lorebook update is split into two phases to support parallel lane execution:
 *   applyLorebookToDraft  — parses AI text, stitches MECE tags, writes to draft in memory.
 *                           Returns the local suggestions array. No disk write.
 *   saveLorebookToDisk    — single coordinated disk write after all lanes complete.
 *                           Stitches protected blocks, saves, vectors changed entries.
 *
 * @api-declaration
 * logSyncStart(hookPairs, lbPairs, ragPairs, coverAll, chunkEveryN)
 * applyLorebookToDraft(rawText, defaultMeceTag) — returns suggestions[], mutates draft
 * saveLorebookToDisk(anchorUuid, allSuggestions) — disk write + vectoring
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
import { getStringHash } from '../../../../utils.js';
import { insertLorebookEntries } from '../rag/vec-store.js';
import { cnzAvatarKey } from '../rag/api.js';
import { setDnaChain } from '../scheduler.js';
import { readDnaChain, getLkgAnchor, buildAnchorPayload } from './dna-chain.js';
import { writeDnaAnchor, writeDnaLinks } from './dna-writer.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { parseLbSuggestions, enrichLbSuggestions,
         nextLorebookUid, makeLbDraftEntry,
         stripProtectedBlock, stitchProtectedBlock } from '../lorebook/utils.js';
import { stitchMeceTag } from '../lorebook/tags.js';
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

/**
 * Phase 1: parse AI output, stitch MECE tags, apply to draft in memory.
 * Safe to call from parallel lanes — reads state._lorebookSuggestions (prior cycle,
 * read-only) and writes to state._draftLorebook (disjoint entry sets per lane).
 * Does NOT write to state._lorebookSuggestions or touch disk.
 *
 * @param {string} rawText        Raw AI output for this lane.
 * @param {string} defaultMeceTag Fallback MECE tag for new entries that arrive untagged.
 * @returns {object[]}            Local suggestions array for this lane.
 */
export function applyLorebookToDraft(rawText, defaultMeceTag) {
    const localSuggestions = [];
    if (!rawText.trim() || rawText.trim() === 'NO CHANGES NEEDED') return localSuggestions;

    const suggestions = parseLbSuggestions(rawText);
    const enriched    = enrichLbSuggestions(suggestions);

    for (const s of enriched) {
        const origEntry    = state._draftLorebook?.entries?.[String(s.linkedUid)] ?? null;
        const origNarrative = origEntry ? stripProtectedBlock(origEntry.content ?? '') : '';
        const narrative     = stitchMeceTag(s._aiSnapshot.content.trim(), origNarrative, defaultMeceTag);

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
        localSuggestions.push(s);
    }

    return localSuggestions;
}

/**
 * Phase 2: single coordinated disk write after all parallel lanes complete.
 * Stitches protected blocks on all entries, saves to disk, updates lorebookData,
 * and runs write-through vectoring for all changed entries across both lanes.
 *
 * @param {string|null} anchorUuid
 * @param {object[]}    allSuggestions  Merged suggestions from all LB lanes.
 */
export async function saveLorebookToDisk(anchorUuid, allSuggestions) {
    const preLorebook      = state._lorebookData ?? { entries: {} };
    const stitchedLorebook = structuredClone(state._draftLorebook);
    for (const entry of Object.values(stitchedLorebook.entries ?? {})) {
        const origEntry = preLorebook.entries?.[String(entry.uid)];
        entry.content = stitchProtectedBlock(
            stripProtectedBlock(entry.content),
            origEntry?.content ?? '',
        );
    }
    stitchedLorebook.extensions = { ...(stitchedLorebook.extensions ?? {}), cnz_anchor_uuid: anchorUuid };
    await lbSaveLorebook(state._lorebookName, stitchedLorebook, { silent: true });
    state._lorebookData = structuredClone(state._draftLorebook);

    const changed = allSuggestions
        .filter(s => s.linkedUid != null)
        .map(s => {
            const e = state._draftLorebook?.entries?.[String(s.linkedUid)];
            return e ? { uid: e.uid, content: e.content, keys: e.key ?? [], comment: e.comment ?? '' } : null;
        })
        .filter(Boolean);

    if (changed.length && anchorUuid) {
        const ctx  = SillyTavern.getContext();
        const char = ctx.characters[ctx.characterId];
        if (char) {
            try {
                await insertLorebookEntries(cnzAvatarKey(char.avatar), anchorUuid, state._lorebookName, changed);
                const hashStr = Object.values(state._draftLorebook.entries ?? {})
                    .sort((a, b) => a.uid - b.uid)
                    .map(e => `${e.uid}|${e.comment ?? ''}|${(e.key ?? []).join(',')}|${stripProtectedBlock(e.content ?? '')}`)
                    .join('\n');
                state._lastIndexedLorebookHash = String(getStringHash(hashStr));
            } catch (err) {
                warn('VecStore', 'write-through vectoring failed:', err);
            }
        }
    }
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
        ragHeaders,
        parentUuid,
    });

    await writeDnaAnchor(anchorPair, anchor);
    await writeDnaLinks(state._stagedProsePairs, anchorPairIdx, anchor.uuid, state._stagedPairOffset);

    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    log('DnaChain', 'commitDnaAnchor: anchor written uuid=' + anchor.uuid + ' pairs=' + state._stagedProsePairs.length);
}
