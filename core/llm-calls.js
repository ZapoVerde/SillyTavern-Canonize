/**
 * @file data/default-user/extensions/canonize/core/llm-calls.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.17
 * @architectural-role Orchestrator
 * @description
 * Owns the three sync AI calls and the bus dispatch that backs them.
 * No parsing, no state mutation — just prompt assembly and raw text generation
 * routed through the bus/executor pipeline. Each call receives pre-assembled
 * context from the caller and returns raw model output for downstream parsing.
 *
 * Strips the protected block (below -\*-\*-) before sending entries to the LLM.
 *
 * @api-declaration
 * runLorebookSyncCall, runPeopleSyncCall, runHookseekerCall, runTargetedLbCall
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [generateRaw via bus/executor, state._lorebookData (read-only default)]
 */

import { state } from '../state.js';
import { on, off, BUS_EVENTS } from '../bus.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { getSettings } from './settings.js';
import { formatLorebookEntries, stripProtectedBlock } from '../lorebook/utils.js';

// ─── Bus Dispatch ─────────────────────────────────────────────────────────────

/**
 * Dispatches a recipe through the bus and returns a Promise that resolves with
 * the raw text result when the job completes, or rejects on failure.
 * Sets _cnzGenerating = true for the duration so the CHAT_COMPLETION_PROMPT_READY
 * handler skips the context mask during CNZ's own AI calls.
 *
 * @param {string} recipeId
 * @param {Record<string,*>} extraInputs  Resolved inputs to pass alongside cycle store values.
 * @returns {Promise<string>}
 */
function _waitForRecipe(recipeId, extraInputs = {}) {
    return new Promise((resolve, reject) => {
        const settings = getSettings();
        setCurrentSettings(settings);

        const jobId = dispatchContract(recipeId, extraInputs, settings);

        function onCompleted({ jobId: j, recipeId: r, result }) {
            if (j !== jobId || r !== recipeId) return;
            cleanup();
            resolve(result);
        }

        function onFailed({ jobId: j, recipeId: r, error }) {
            if (j !== jobId || r !== recipeId) return;
            cleanup();
            reject(new Error(error?.message ?? `Recipe ${recipeId} failed`));
        }

        function cleanup() {
            off(BUS_EVENTS.JOB_COMPLETED, onCompleted);
            off(BUS_EVENTS.JOB_FAILED,    onFailed);
        }

        on(BUS_EVENTS.JOB_COMPLETED, onCompleted);
        on(BUS_EVENTS.JOB_FAILED,    onFailed);
    });
}

// ─── AI Call Wrappers ─────────────────────────────────────────────────────────

/**
 * Fires the Lorebook Sync AI call via the bus (places, things, concepts).
 * Accepts either a pre-formatted string (sync pipeline, where caller filters by lane)
 * or a lorebook object (modal regen path, where no filtering is needed).
 * @param {string}        transcript         Prose transcript to analyse.
 * @param {string|object|null} lorebookOrText Pre-formatted entries string, a lorebook object,
 *                                            or null to fall back to state._lorebookData.
 * @returns {Promise<string>}
 */
export function runLorebookSyncCall(transcript, lorebookOrText = null) {
    const entries = typeof lorebookOrText === 'string'
        ? lorebookOrText
        : formatLorebookEntries(lorebookOrText ?? state._lorebookData);
    return _waitForRecipe('lorebook', {
        transcript,
        lorebook_entries: entries,
    });
}

/**
 * Fires the People Sync AI call via the bus.
 * Receives a pre-filtered lorebook string (person entries only) from the caller.
 * @param {string} transcript
 * @param {string} lorebookEntriesText  Pre-formatted person entries string.
 * @returns {Promise<string>}
 */
export function runPeopleSyncCall(transcript, lorebookEntriesText) {
    const ctx = SillyTavern.getContext();
    return _waitForRecipe('lorebook_people', {
        transcript,
        lorebook_entries: lorebookEntriesText,
        user: ctx.name1 ?? 'the user',
    });
}

/**
 * Fires the Hookseeker AI call via the bus.
 * @param {string} transcript
 * @param {string} prevSummary
 * @returns {Promise<string>}
 */
export function runHookseekerCall(transcript, prevSummary = '') {
    return _waitForRecipe('hookseeker', {
        transcript,
        prev_summary: prevSummary,
    });
}

/**
 * Fires a targeted lorebook AI call for a single entry (update or new) via the bus.
 * Strips the protected block from existing content before sending to the AI.
 *
 * @param {'update'|'new'} mode
 * @param {string} entryName     Entry name or freeform keyword.
 * @param {string} entryKeys     Comma-separated existing keys (empty string for new).
 * @param {string} entryContent  Existing entry content (empty string for new).
 * @param {string} transcript    Sync-window transcript.
 * @returns {Promise<string>}    Raw AI output block.
 */
export function runTargetedLbCall(mode, entryName, entryKeys, entryContent, transcript) {
    const recipeId = mode === 'update' ? 'targeted_update' : 'targeted_new';
    const ctx = SillyTavern.getContext();
    return _waitForRecipe(recipeId, {
        entry_name:    entryName,
        entry_keys:    entryKeys,
        entry_content: stripProtectedBlock(entryContent),
        transcript,
        user: ctx.name1 ?? 'the user',
    });
}