/**
 * @file data/default-user/extensions/canonize/core/sync-helpers.js
 * @stamp {"utc":"2026-06-04T16:20:00.000Z"}
 * @version 1.1.1
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
 * reconcileLorebookLanes(mainSuggestions, peopleSuggestions, lbTranscript)
 *   — detects general-lane #person promotions, scraps and reruns the people lane if needed
 * processSceneUpdate(sceneText) — writes SCENE prose to ST summary prompt
 * appendAndIndexPlotEntries(entries, anchorUuid, avatarFilename, plotLbName) — appends + RAG-indexes plot entries
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
import { insertLorebookEntries } from '../rag/file-store-lb.js';
import { cnzGetActiveChatKey } from '../rag/api.js';
import { setDnaChain } from '../scheduler.js';
import { readDnaChain, getLkgAnchor, buildAnchorPayload } from './dna-chain.js';
import { writeDnaAnchor, writeDnaLinks } from './dna-writer.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { parseLbSuggestions, enrichLbSuggestions,
         nextLorebookUid, makeLbDraftEntry,
         stripProtectedBlock, stitchProtectedBlock } from '../lorebook/utils.js';
import { stitchMeceTag, extractMeceTag, formatFilteredLorebookEntries } from '../lorebook/tags.js';
import { appendPlotEntries, ensurePlotLorebook } from '../lorebook/plot-lorebook.js';
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
                const _chatKey = cnzGetActiveChatKey();
                if (_chatKey) await insertLorebookEntries(_chatKey, anchorUuid, state._lorebookName, changed);
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

/**
 * Post-parallel reconciliation for the two lorebook lanes.
 * If the general lane newly tagged any entries as #person this cycle, the people
 * lane (which ran from the pre-sync snapshot) may have created duplicate NEW entries
 * for those same people. This function detects that case, undoes the people lane's
 * draft changes, and reruns the people call against the now-correctly-tagged draft.
 *
 * Returns the final peopleSuggestions array (unchanged if no reconciliation needed).
 *
 * @param {object[]} mainSuggestions    Suggestions from the general lorebook lane.
 * @param {object[]} peopleSuggestions  Suggestions from the people lane.
 * @param {string}   lbTranscript       Transcript used for this sync cycle.
 * @returns {Promise<object[]>}         Final people suggestions.
 */
export async function reconcileLorebookLanes(mainSuggestions, peopleSuggestions, lbTranscript) {
    const newlyPersonTagged = mainSuggestions.filter(s => {
        if (s.linkedUid === null) return false;
        const draftEntry = state._draftLorebook?.entries?.[String(s.linkedUid)];
        const origEntry  = state._lorebookData?.entries?.[String(s.linkedUid)];
        return extractMeceTag(draftEntry?.content ?? '') === '#person'
            && extractMeceTag(origEntry?.content  ?? '') !== '#person';
    });

    if (newlyPersonTagged.length === 0) return peopleSuggestions;

    log('Lorebook', `Reconciliation: ${newlyPersonTagged.length} entry/entries newly tagged #person — scrapping people lane, rerunning`);

    for (const s of peopleSuggestions) {
        if (s.linkedUid === null) continue;
        const uidStr    = String(s.linkedUid);
        const origEntry = state._lorebookData?.entries?.[uidStr];
        if (origEntry) {
            state._draftLorebook.entries[uidStr] = structuredClone(origEntry);
        } else {
            delete state._draftLorebook.entries[uidStr];
        }
    }

    const freshPeopleText = formatFilteredLorebookEntries(state._draftLorebook, '#person', false);
    try {
        const { runPeopleSyncCall } = await import('./llm-calls.js');
        const text = await runPeopleSyncCall(lbTranscript, freshPeopleText);
        const result = applyLorebookToDraft(text, '#person');
        log('Lorebook', 'Reconciliation people rerun: ✓ ok');
        return result;
    } catch (e) {
        error('Lorebook', 'Reconciliation people rerun failed:', e.message ?? e);
        return [];
    }
}

/**
 * Writes the SCENE prose to the CNZ Summary prompt.
 * @param {string} sceneText  Parsed SCENE block from hookseeker output.
 */
export function processSceneUpdate(sceneText) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');
    writeCnzSummaryPrompt(char.avatar, sceneText.trim(), null);
}

/**
 * Appends plot entries to the plot lorebook and indexes them in the RAG store.
 * Sets state._plotLorebookName on first use.
 * No-op if entries is empty.
 * @param {{ name: string, keys: string[], content: string }[]} entries
 * @param {string}      anchorUuid
 * @param {string}      avatarFilename
 * @param {string|null} plotLbName  Current plot lorebook name (may be null on first sync).
 */
/**
 * @returns {Promise<{ uid: number, content: string, keys: string[], comment: string }[]>}
 *   The written entries with UIDs assigned — store these in the anchor payload.
 */
export async function appendAndIndexPlotEntries(entries, anchorUuid, _avatarFilename, plotLbName) {
    if (!entries.length) return [];
    await ensurePlotLorebook(plotLbName);
    const written = await appendPlotEntries(plotLbName, entries);
    if (!written.length) return [];
    try {
        const _chatKey = cnzGetActiveChatKey();
        if (_chatKey) await insertLorebookEntries(_chatKey, anchorUuid, plotLbName, written);
    } catch (err) {
        warn('PlotLb', 'RAG indexing of plot entries failed:', err);
    }
    return written;
}

export async function commitDnaAnchor(messages, anchorUuid, plotEntries = []) {
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
        uuid:             anchorUuid,
        committedAt:      new Date().toISOString(),
        scene:            state._priorSituation,
        plotLorebookName: state._plotLorebookName,
        plotEntries,
        lorebook:         Object.assign({ name: state._lorebookName }, structuredClone(state._draftLorebook ?? { entries: {} })),
        ragHeaders,
        parentUuid,
    });

    await writeDnaAnchor(anchorPair, anchor);
    await writeDnaLinks(state._stagedProsePairs, anchorPairIdx, anchor.uuid, state._stagedPairOffset);

    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    log('DnaChain', 'commitDnaAnchor: anchor written uuid=' + anchor.uuid + ' pairs=' + state._stagedProsePairs.length);
}