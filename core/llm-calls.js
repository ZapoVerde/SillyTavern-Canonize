/**
 * @file data/default-user/extensions/canonize/core/llm-calls.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role Prompt Assembly and Generation
 * @description
 * Owns the three sync AI calls and the bus dispatch that backs them.
 * No parsing, no state mutation — just prompt assembly and raw text generation
 * routed through the bus/executor pipeline. Each call receives pre-assembled
 * context from the caller and returns raw model output for downstream parsing.
 *
 * Strips the protected block (below -\*-\*-) before sending entries to the LLM.
 *
 * @api-declaration
 * runLorebookSyncCall, runHookseekerCall, runTargetedLbCall
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: [none]
 *     external_io: [generateRaw via bus/executor]
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
 * Fires the Lorebook Sync AI call via the bus.
 * formatLorebookEntries internally strips protected blocks.
 * @param {string}      transcript  Prose transcript to analyse.
 * @param {object|null} lorebook    Lorebook state to use as context. Defaults to `state._lorebookData` if null.
 * @returns {Promise<string>}
 */
export function runLorebookSyncCall(transcript, lorebook = null) {
    return _waitForRecipe('lorebook', {
        transcript,
        lorebook_entries: formatLorebookEntries(lorebook ?? state._lorebookData),
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
    return _waitForRecipe(recipeId, {
        entry_name:    entryName,
        entry_keys:    entryKeys,
        entry_content: stripProtectedBlock(entryContent),
        transcript,
    });
}