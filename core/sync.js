/**
 * @file data/default-user/extensions/canonize/core/sync.js
 * @stamp {"utc":"2026-05-31T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Orchestrator
 * @description
 * Public sync pipeline surface. Owns runCnzSync (the full background sync
 * cycle) and the two pure window-computation helpers used by the wand and
 * modal. Implementation helpers live in core/sync-helpers.js.
 *
 * Sync runs four lanes in parallel under Promise.all:
 *   Lane 1a (people)  — LLM call for #person entries; defaultMeceTag '#person'
 *   Lane 1b (lorebook) — LLM call for all non-#person entries; defaultMeceTag '#thing'
 *   Lane 2  (hooks)   — hookseeker narrative summary
 *   Lane 3  (RAG)     — vector embedding pipeline
 * After Promise.all: single saveLorebookToDisk call, then merged suggestions written
 * to state._lorebookSuggestions for the review modal.
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
import { runLorebookSyncCall, runPeopleSyncCall, runHookseekerCall } from './llm-calls.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { lbEnsureLorebook, lbGetLorebook } from '../lorebook/api.js';
import { stripProtectedBlock } from '../lorebook/utils.js';
import { formatFilteredLorebookEntries } from '../lorebook/tags.js';
import { runRagPipeline } from '../rag/pipeline.js';
import { isPluginReachable } from '../rag/plugin-health.js';
import { cnzDefaultLbName, cnzPlotLbName } from '../rag/api.js';
import { patchCharacterWorld } from '../modal/commit.js';
import { state } from '../state.js';
import { parseHookseekerOutput } from './hookseeker-output.js';
import { logSyncStart, applyLorebookToDraft, saveLorebookToDisk,
         reconcileLorebookLanes, processSceneUpdate,
         appendAndIndexPlotEntries, commitDnaAnchor } from './sync-helpers.js';

// Re-export pure helpers so existing callers importing from sync.js don't break.
export { computeSyncWindow, deriveLastCommittedPairs } from './transcript.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Reads the plot lorebook and returns a formatted "Currently running plots:"
 * block for injection into the hookseeker prompt. Each arc is wrapped in
 * <plot_arc_{tag}> tags and contains its first entry plus up to the last three,
 * deduplicated. Returns empty string if the lorebook is empty or unavailable.
 * @param {string} plotLbName
 * @returns {Promise<string>}
 */
export async function buildExistingThreads(plotLbName) {
    try {
        const lb = await lbGetLorebook(plotLbName);
        const allEntries = Object.values(lb?.entries ?? {});
        if (!allEntries.length) return '';

        // Group entries by their thread tag (last #word in content), sorted by uid.
        const arcMap = new Map();
        for (const e of allEntries) {
            const tags = e.content?.match(/#\w+/g) ?? [];
            const tag  = tags[tags.length - 1];
            if (!tag) continue;
            if (!arcMap.has(tag)) arcMap.set(tag, []);
            arcMap.get(tag).push(e);
        }
        if (!arcMap.size) return '';

        const arcBlocks = [];
        for (const [tag, entries] of arcMap) {
            entries.sort((a, b) => a.uid - b.uid);

            // First entry + last 3, deduplicated.
            const selected = entries.length <= 4
                ? entries
                : [entries[0], ...entries.slice(-3)];

            const entryLines = selected
                .map(e => `**${e.comment}**\n${e.content}`)
                .join('\n\n');

            const arcTag = tag.slice(1); // strip leading #
            arcBlocks.push(`<plot_arc_${arcTag}>\n${entryLines}\n</plot_arc_${arcTag}>`);
        }

        return arcBlocks.join('\n\n');
    } catch {
        return '';
    }
}

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

    const lbName = state._lorebookName || cnzDefaultLbName(char.avatar);
    state._lorebookName = lbName;
    const plotLbName = state._plotLorebookName || cnzPlotLbName(char.avatar);
    state._plotLorebookName = plotLbName;
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

    // Lane entry text is pre-formatted here so both LLM calls can start immediately.
    // General lane receives only non-#person entries (plus untagged entries for tag correction).
    // People lane receives only pre-sync #person entries — the reconciliation step below
    // handles any entries the general lane newly promotes to #person this cycle.
    const peopleEntriesText = formatFilteredLorebookEntries(state._lorebookData, '#person', false);
    const mainEntriesText   = formatFilteredLorebookEntries(state._lorebookData, '#person', true);

    let peopleSuggestions = [];
    let mainSuggestions   = [];

    const lbPeoplePromise = (async () => {
        if (!settings.enablePeopleSync) {
            log('Lorebook', 'Lane 1a (people): skipped (disabled)');
            return true;
        }
        log('Lorebook', 'Lane 1a (people): starting');
        try {
            const text = await runPeopleSyncCall(lbTranscript, peopleEntriesText);
            peopleSuggestions = applyLorebookToDraft(text, '#person');
            log('Lorebook', 'Lane 1a (people): ✓ ok');
        } catch (e) {
            error('Lorebook', 'Lane 1a (people) failed:', e.message ?? e);
            return false;
        }
        return true;
    })();

    const lbPromise = (async () => {
        log('Lorebook', 'Lane 1b (lorebook): starting');
        try {
            const text = await runLorebookSyncCall(lbTranscript, mainEntriesText);
            mainSuggestions = applyLorebookToDraft(text, '#thing');
            log('Lorebook', 'Lane 1b (lorebook): ✓ ok');
        } catch (e) {
            error('Lorebook', 'Lane 1b (lorebook) failed:', e.message ?? e);
            return false;
        }
        return true;
    })();

    let stagedPlotEntries = [];
    const hooksPromise = (async () => {
        log('Hooks', 'Lane 2: starting');
        try {
            const existingThreads = await buildExistingThreads(plotLbName);
            const raw = await runHookseekerCall(hookTranscript, state._priorSituation, existingThreads);
            const { scene, entries } = parseHookseekerOutput(raw);
            processSceneUpdate(scene);
            state._priorSituation = scene;
            if (entries.length) {
                stagedPlotEntries = await appendAndIndexPlotEntries(entries, anchorUuid, char.avatar, plotLbName);
                log('Hooks', `Lane 2: ${stagedPlotEntries.length} plot entry/entries written`);
            }
            log('Hooks', 'Lane 2: ✓ ok');
            return true;
        } catch (e) {
            error('Hooks', 'Lane 2: ✗ failed —', e.message ?? e, e);
            return false;
        }
    })();

    const ragPromise = (async () => {
        if (!settings.enableRag || !isPluginReachable()) { log('Rag', 'Lane 3: skipped (disabled)'); return true; }
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

    const [lbPeopleOk, lbOk, hooksOk, ragOk] = await Promise.all([lbPeoplePromise, lbPromise, hooksPromise, ragPromise]);

    if (lbOk && lbPeopleOk && settings.enablePeopleSync) {
        peopleSuggestions = await reconcileLorebookLanes(mainSuggestions, peopleSuggestions, lbTranscript);
    }

    // Single coordinated disk write after all LB work is complete.
    const allSuggestions = [...peopleSuggestions, ...mainSuggestions];
    let lbSaveOk = false;
    try {
        await saveLorebookToDisk(anchorUuid, allSuggestions);
        state._lorebookSuggestions = allSuggestions;
        lbSaveOk = true;
    } catch (e) {
        error('Lorebook', 'saveLorebookToDisk failed:', e.message ?? e);
    }

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
        await commitDnaAnchor(messages, anchorUuid, stagedPlotEntries);
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
        !lbPeopleOk && 'people lane',
        !lbOk       && 'lorebook lane',
        !lbSaveOk   && 'lorebook save',
        !hooksOk    && 'hooks',
        !ragOk      && 'RAG',
        !anchorOk   && 'anchor commit',
    ].filter(Boolean);

    if (failures.length === 0) {
        log('Sync', '══ SYNC COMPLETE ══ all lanes ok');
        toastr.success('Sync processed');
    } else {
        warn('Sync', `══ SYNC COMPLETE ══ failed: ${failures.join(', ')}`);
        toastr.warning(`Sync processed — failed: ${failures.join(', ')}`);
    }
}
