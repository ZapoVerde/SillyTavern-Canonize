/**
 * @file data/default-user/extensions/canonize/core/sync.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * Public sync pipeline surface. Owns runCnzSync (the full background sync
 * cycle) and the two pure window-computation helpers used by the wand and
 * modal. Implementation helpers live in core/sync-helpers.js.
 *
 * @api-declaration
 * runCnzSync(char, messages, { coverAll }) — full sync cycle
 *
 * Pure helpers (re-exported from transcript.js for callers who import from here):
 * computeSyncWindow, deriveLastCommittedPairs
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [lorebook API, DNA chain, RAG pipeline, LLM calls, ST summary prompt]
 */

import { log, warn, error } from '../log.js';
import { setSyncInProgress } from '../scheduler.js';
import { getSettings } from './settings.js';
import { buildProsePairs, buildTranscript, computeSyncWindow } from './transcript.js';
import { runLorebookSyncCall, runHookseekerCall } from './llm-calls.js';
import { readDnaChain } from './dna-chain.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { lbEnsureLorebook } from '../lorebook/api.js';
import { stripProtectedBlock } from '../lorebook/utils.js';
import { runRagPipeline } from '../rag/pipeline.js';
import { patchCharacterWorld } from '../modal/commit.js';
import { state } from '../state.js';
import { logSyncStart, processLorebookUpdate,
         processHooksUpdate, commitDnaAnchor } from './sync-helpers.js';

// Re-export pure helpers so existing callers importing from sync.js don't break.
export { computeSyncWindow, deriveLastCommittedPairs } from './transcript.js';

// ─── Sync pipeline ────────────────────────────────────────────────────────────

export async function runCnzSync(char, messages, { coverAll = false } = {}) {
    log('Sync', `══ SYNC START ══ char="${char?.name}" coverAll=${coverAll} msgs=${messages.length}`);
    setSyncInProgress(true);
    document.dispatchEvent(new CustomEvent('cnz:sync-started', {
        detail: { lorebookName: state._lorebookName, charName: char?.name ?? null },
    }));
    const settings  = getSettings();
    const allPairs  = buildProsePairs(messages);
    const { syncPairs, syncPairOffset } = computeSyncWindow(allPairs, messages, settings, coverAll, state._dnaChain);

    if (syncPairs.length === 0) {
        warn('Sync', 'runCnzSync: no uncommitted pairs in window — aborting');
        setSyncInProgress(false);
        return;
    }

    state._stagedProsePairs = syncPairs;
    state._stagedPairOffset = syncPairOffset;

    const horizon        = settings.hookseekerHorizon ?? 40;
    const lookbackStart  = Math.max(0, syncPairOffset - (horizon - syncPairs.length));
    const hookPairs      = allPairs.slice(lookbackStart, syncPairOffset + syncPairs.length);
    const hookMsgs       = hookPairs.flatMap(p => [p.user, ...p.messages]);
    const hookTranscript = buildTranscript(hookMsgs);

    const lbSyncStart = settings.lorebookSyncStart ?? 'syncPoint';
    let lbPairsForLog;
    let lbTranscript;
    if (lbSyncStart === 'latestTurn') {
        lbPairsForLog = hookPairs;
        lbTranscript  = hookTranscript;
    } else {
        lbPairsForLog = syncPairs;
        const lbMsgs  = syncPairs.flatMap(p => [p.user, ...p.messages]);
        lbTranscript  = buildTranscript(lbMsgs);
    }

    logSyncStart(hookPairs, lbPairsForLog, syncPairs, coverAll, settings.chunkEveryN ?? 20);

    const lbName = state._lorebookName || settings.lorebookName || char.name;
    state._lorebookName = lbName;
    const freshLorebook = await lbEnsureLorebook(lbName);

    let externalDeletions = [];
    if (!state._draftLorebook) {
        state._lorebookData  = freshLorebook;
        state._draftLorebook = structuredClone(freshLorebook);
        log('Lorebook', `Lorebook lazy-loaded: "${lbName}" (${Object.keys(freshLorebook.entries ?? {}).length} entries)`);
    } else {
        const knownEntries = state._lorebookData?.entries ?? {};
        const freshEntries = freshLorebook.entries ?? {};
        externalDeletions = Object.entries(knownEntries)
            .filter(([uid]) => !(uid in freshEntries))
            .map(([uid, entry]) => ({ uid: parseInt(uid, 10), name: entry.comment || String(uid) }));

        if (externalDeletions.length > 0) {
            log('Lorebook', `External deletions detected (${externalDeletions.length}): ${externalDeletions.map(e => `"${e.name}"`).join(', ')}`);
            for (const { uid } of externalDeletions) {
                delete state._draftLorebook.entries[String(uid)];
            }
        }

        // Additions: UIDs on disk missing from the in-memory draft
        for (const [uid, entry] of Object.entries(freshEntries)) {
            if (!(uid in state._draftLorebook.entries)) {
                state._draftLorebook.entries[uid] = structuredClone(entry);
                log('Lorebook', `External addition merged: "${entry.comment || uid}"`);
            }
        }

        // Edits: overwrite draft fields when disk content differs
        for (const [uid, diskEntry] of Object.entries(freshEntries)) {
            const draftEntry = state._draftLorebook.entries[uid];
            if (!draftEntry) continue;
            if (
                stripProtectedBlock(diskEntry.content ?? '') !== stripProtectedBlock(draftEntry.content ?? '') ||
                JSON.stringify(diskEntry.key) !== JSON.stringify(draftEntry.key) ||
                (diskEntry.comment ?? '') !== (draftEntry.comment ?? '')
            ) {
                draftEntry.content = diskEntry.content;
                draftEntry.key     = diskEntry.key;
                draftEntry.comment = diskEntry.comment;
                log('Lorebook', `External edit merged: "${diskEntry.comment || uid}"`);
            }
        }

        state._lorebookData = structuredClone(freshLorebook);
    }

    if (char?.data?.extensions?.world !== state._lorebookName) {
        try {
            await patchCharacterWorld(char, state._lorebookName);
            log('Lorebook', `Lorebook linked to character: "${char.name}" → "${state._lorebookName}"`);
        } catch (e) {
            error('Lorebook', 'Lorebook link failed:', e.message ?? e);
        }
    }

    const anchorUuid = (typeof crypto?.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });

    const lbPromise = (async () => {
        log('Lorebook', 'Lane 1: starting');
        try {
            const text = await runLorebookSyncCall(lbTranscript, state._lorebookData);
            await processLorebookUpdate(text, anchorUuid);
            log('Lorebook', 'Lane 1: ✓ ok');
        } catch (e) {
            error('Lorebook', 'Lane 1 failed:', e.message ?? e);
            if (state._draftLorebook) await processLorebookUpdate('', anchorUuid);
            return false;
        }
        return true;
    })();

    const hooksPromise = (async () => {
        log('Hooks', 'Lane 2: starting');
        try {
            const text = await runHookseekerCall(hookTranscript, state._priorSituation);
            await processHooksUpdate(text);
            state._priorSituation = text;
            log('Hooks', 'Lane 2: ✓ ok');
            return true;
        } catch (e) {
            error('Hooks', 'Lane 2: ✗ failed —', e.message ?? e, e);
            return false;
        }
    })();

    const ragPromise = (async () => {
        if (!settings.enableRag) { log('Rag', 'Lane 3: skipped (disabled)'); return true; }
        log('Rag', 'Lane 3: starting');
        try {
            await runRagPipeline(anchorUuid);
            log('Rag', 'Lane 3: ✓ ok');
            return true;
        } catch (e) {
            error('Rag', 'Lane 3: ✗ failed —', e.message ?? e, e);
            return false;
        }
    })();

    const [lbOk, hooksOk, ragOk] = await Promise.all([lbPromise, hooksPromise, ragPromise]);

    if (externalDeletions.length > 0) {
        const tombstones = externalDeletions.map(({ uid, name }) => ({
            type:        'UPDATE',
            name,
            linkedUid:   uid,
            status:      'deleted',
            _aiSnapshot: { name, keys: [], content: '' },
        }));
        state._lorebookSuggestions = [...tombstones, ...state._lorebookSuggestions];
    }

    log('DnaChain', 'committing anchor');
    let anchorOk = false;
    try {
        await commitDnaAnchor(messages, anchorUuid);
        anchorOk = true;
        log('DnaChain', '✓ ok');
        const newUuid = state._dnaChain.lkg?.uuid ?? null;
        if (newUuid) writeCnzSummaryPrompt(char.avatar, state._priorSituation, newUuid);
    } catch (e) {
        error('DnaChain', '✗ failed —', e.message ?? e, e);
    }

    setSyncInProgress(false);
    document.dispatchEvent(new CustomEvent('cnz:sync-completed', {
        detail: { lorebookName: state._lorebookName, charName: char?.name ?? null },
    }));

    const failures = [
        !lbOk     && 'lorebook',
        !hooksOk  && 'hooks',
        !ragOk    && 'RAG',
        !anchorOk && 'anchor commit',
    ].filter(Boolean);

    if (failures.length === 0) {
        log('Sync', '══ SYNC COMPLETE ══ all lanes ok');
        toastr.success('Sync processed');
    } else {
        warn('Sync', `══ SYNC COMPLETE ══ failed: ${failures.join(', ')}`);
        toastr.warning(`Sync processed — failed: ${failures.join(', ')}`);
    }
}
