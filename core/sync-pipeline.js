/**
 * @file data/default-user/extensions/canonize/core/sync-pipeline.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Feature Orchestrator
 * @description
 * Primary orchestrator for the Canonize sync cycle. Coordinates the compute 
 * window logic, AI lane execution (Lorebook, Hooks, RAG), and final commit 
 * processing. Emits UI events to track sync progress.
 *
 * @api-declaration
 * runCnzSync, logSyncStart
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._stagedProsePairs, state._stagedPairOffset, state._priorSituation, state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [/api/worldinfo/*, /api/chats/saveChat]
 */

import { state } from '../state.js';
import { log, warn, error } from '../log.js';
import { setSyncInProgress } from '../scheduler.js';
import { getSettings } from './settings.js';
import { buildTranscript, buildProsePairs } from './transcript.js';
import { computeSyncWindow } from './window.js';
import { runLorebookSyncCall, runHookseekerCall } from './llm-calls.js';
import { lbEnsureLorebook } from '../lorebook/api.js';
import { patchCharacterWorld } from '../modal/commit.js';
import { runRagPipeline } from '../rag/pipeline.js';
import { writeCnzSummaryPrompt } from './summary-prompt.js';
import { 
    processLorebookUpdate, processHooksUpdate, commitDnaAnchor 
} from './sync-processors.js';

/**
 * Logs the calculated boundaries of a sync operation.
 */
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
 * Orchestrates a full sync cycle.
 * 1. Computes window.
 * 2. Lazily loads lorebook and links character.
 * 3. Dispatches AI lanes (Lorebook, Hooks, RAG) in parallel.
 * 4. Commits results and DNA anchor.
 * 
 * @param {object} char     Character object from ST context.
 * @param {Array}  messages Full chat message array.
 * @param {boolean} coverAll true = full gap, false = standard window.
 */
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

    // Stage pairs for processors
    state._stagedProsePairs = syncPairs;
    state._stagedPairOffset = syncPairOffset;

    // Build Hookseeker transcript with continuity lookback
    const horizon       = settings.hookseekerHorizon ?? 40;
    const lookbackStart = Math.max(0, syncPairOffset - (horizon - syncPairs.length));
    const hookPairs     = allPairs.slice(lookbackStart, syncPairOffset + syncPairs.length);
    const hookTranscript = buildTranscript(hookPairs.flatMap(p => [p.user, ...p.messages]));

    // Build Lorebook transcript
    let lbPairsForLog = syncPairs;
    let lbTranscript;
    if ((settings.lorebookSyncStart ?? 'syncPoint') === 'latestTurn') {
        lbPairsForLog = hookPairs;
        lbTranscript  = hookTranscript;
    } else {
        lbTranscript  = buildTranscript(syncPairs.flatMap(p => [p.user, ...p.messages]));
    }

    logSyncStart(hookPairs, lbPairsForLog, syncPairs, coverAll, settings.chunkEveryN ?? 20);

    // Ensure lorebook is ready
    if (!state._draftLorebook) {
        state._lorebookName = settings.lorebookName || char.name;
        state._lorebookData = await lbEnsureLorebook(state._lorebookName);
        state._draftLorebook = structuredClone(state._lorebookData);
    }
    
    if (char?.data?.extensions?.world !== state._lorebookName) {
        try { await patchCharacterWorld(char, state._lorebookName); }
        catch (e) { error('Lorebook', 'Lorebook link failed:', e); }
    }

    const anchorUuid = (typeof crypto?.randomUUID === 'function')
        ? crypto.randomUUID()
        : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
            const r = Math.random() * 16 | 0;
            return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });

    // LANE 1: Lorebook
    const lbPromise = (async () => {
        try {
            const text = await runLorebookSyncCall(lbTranscript, state._lorebookData);
            await processLorebookUpdate(text, anchorUuid);
            return true;
        } catch (e) {
            error('Lorebook', 'Lane 1 failed:', e);
            if (state._draftLorebook) await processLorebookUpdate('', anchorUuid); 
            return false;
        }
    })();

    // LANE 2: Hooks
    const hooksPromise = (async () => {
        try {
            const text = await runHookseekerCall(hookTranscript, state._priorSituation);
            await processHooksUpdate(text);
            state._priorSituation = text;
            return true;
        } catch (e) {
            error('Hooks', 'Lane 2 failed:', e);
            return false;
        }
    })();

    // LANE 3: RAG
    const ragPromise = (async () => {
        if (!settings.enableRag) return true;
        try {
            await runRagPipeline(anchorUuid);
            return true;
        } catch (e) {
            error('Rag', 'Lane 3 failed:', e);
            return false;
        }
    })();

    const [lbOk, hooksOk, ragOk] = await Promise.all([lbPromise, hooksPromise, ragPromise]);

    // Commit Anchor
    let anchorOk = false;
    try {
        await commitDnaAnchor(messages, anchorUuid);
        anchorOk = true;
        const newUuid = state._dnaChain.lkg?.uuid ?? null;
        if (newUuid) writeCnzSummaryPrompt(char.avatar, state._priorSituation, newUuid);
    } catch (e) { error('DnaChain', 'Anchor commit failed:', e); }

    setSyncInProgress(false);
    document.dispatchEvent(new CustomEvent('cnz:sync-completed', {
        detail: { lorebookName: state._lorebookName, charName: char?.name ?? null },
    }));

    if (lbOk && hooksOk && ragOk && anchorOk) {
        toastr.success('Sync processed');
    } else {
        toastr.warning('Sync processed with errors');
    }
}