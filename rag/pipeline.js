/**
 * @file data/default-user/extensions/canonize/rag/pipeline.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 2.0.0
 * @architectural-role Orchestrator
 * @description
 * RAG classifier dispatch and the full sync-time pipeline. Sequences chunk
 * building, header hydration, AI classification fan-out, and DB insertion.
 * No DOM, no chat-message IO — that lives in rag/chat-labels.js.
 *
 * `waitForRagChunks` bridges the bus fan-out back to the pipeline caller.
 * `ragRegenCard` dispatches a single-chunk reclassification from the workshop.
 * `resolveClassifierHistory` is a pure reference kept here for the fan-out recipe.
 *
 * @api-declaration
 * waitForRagChunks(timeoutMs)
 * ragRegenCard(chunkIndex)
 * resolveClassifierHistory(pairStart, historyN, fullPairs, stagedPairOffset)
 * runRagPipeline(anchorUuid)
 *
 * Re-exports (from rag/chunks.js): buildRagDocument, buildRagChunks
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._ragChunks, state._stagedProsePairs,
 *                       state._stagedPairOffset, state._splitPairIdx]
 *     external_io: [generateRaw via cycleStore, /api/plugins/cnz/insert-chunks, bus]
 */

import { state } from '../state.js';
import { on, off, BUS_EVENTS } from '../bus.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { buildProsePairs, formatPairsAsTranscript } from '../core/transcript.js';
import { getSettings } from '../core/settings.js';
import { cnzAvatarKey } from './api.js';
import { insertSyncChunks } from './vec-store.js';
import { warn, error } from '../log.js';
import { buildRagChunks } from './chunks.js';
import { hydrateChunkHeadersFromChat } from './chat-labels.js';

// Re-export pure functions so existing callers importing from pipeline.js keep working.
export { buildRagChunks, buildRagDocument } from './chunks.js';

// ─── Bus Listener ─────────────────────────────────────────────────────────────

/**
 * Returns a Promise that resolves when the RAG fan-out emits CYCLE_STORE_UPDATED
 * for 'rag_chunk_results', or when timeoutMs elapses.
 * Timed-out in-flight chunks are marked 'pending' for retry.
 * @param {number} timeoutMs
 */
export function waitForRagChunks(timeoutMs = 120_000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            off(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
            for (const c of state._ragChunks) {
                if (c.status === 'in-flight') c.status = 'pending';
            }
            warn('Rag', `RAG chunk wait timed out after ${timeoutMs}ms — some chunks may be incomplete`);
            resolve();
        }, timeoutMs);

        function handler({ key }) {
            if (key !== 'rag_chunk_results') return;
            clearTimeout(timer);
            off(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
            resolve();
        }
        on(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
    });
}

// ─── Single-Chunk Regen ───────────────────────────────────────────────────────

/**
 * Dispatches a single RAG classifier call for the chunk at chunkIndex.
 * Called from the RAG workshop regen button.
 * @param {number} chunkIndex
 */
export function ragRegenCard(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk) return;

    chunk.status = 'pending';

    import('../modal/rag-workshop.js').then(({ renderRagCard }) => renderRagCard(chunkIndex));

    const messages  = SillyTavern.getContext().chat ?? [];
    const fullPairs = buildProsePairs(messages);
    const settings  = getSettings();
    setCurrentSettings(settings);
    dispatchContract('rag_classifier', {
        ragChunks:        [chunk],
        fullPairs,
        stagedPairs:      state._stagedProsePairs,
        stagedPairOffset: state._stagedPairOffset,
        splitPairIdx:     state._splitPairIdx,
        scenario_hooks:   '',
    }, settings);
}

// ─── Classifier History ───────────────────────────────────────────────────────

/**
 * Pure reference — logic is inlined in rag_classifier.fanOut.
 * Returns a formatted transcript of the history window preceding pairStart.
 */
export function resolveClassifierHistory(pairStart, historyN, fullPairs, stagedPairOffset = 0) {
    if (historyN <= 0) return '';
    const absoluteStart    = stagedPairOffset + pairStart;
    const historySliceStart = Math.max(0, absoluteStart - historyN);
    const historyPairs      = fullPairs.slice(historySliceStart, absoluteStart);
    if (!historyPairs.length) return '';
    return formatPairsAsTranscript(historyPairs);
}

// ─── Full Sync Pipeline ───────────────────────────────────────────────────────

/**
 * Builds RAG chunks for the current sync window, classifies them, and inserts
 * completed chunks into the CNZ vector DB.
 * Expects state._stagedProsePairs and state._stagedPairOffset to be set by the caller.
 * @param {string|null} anchorUuid
 */
export async function runRagPipeline(anchorUuid = null) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');

    const messages = ctx.chat ?? [];
    const allPairs = buildProsePairs(messages);

    if (state._stagedProsePairs.length === 0 && allPairs.length > 0) {
        state._stagedProsePairs = [allPairs[allPairs.length - 1]];
        const firstValidIdx   = state._stagedProsePairs[0].validIdx;
        const foundIdx        = allPairs.findIndex(p => p.validIdx >= firstValidIdx);
        state._stagedPairOffset = foundIdx === -1 ? 0 : foundIdx;
    }

    state._splitPairIdx = state._stagedProsePairs.length;
    const ragSettings   = getSettings();

    state._ragChunks = buildRagChunks(state._stagedProsePairs, state._stagedPairOffset, ragSettings);

    hydrateChunkHeadersFromChat();
    setCurrentSettings(ragSettings);
    dispatchContract('rag_classifier', {
        ragChunks:        state._ragChunks,
        fullPairs:        allPairs,
        stagedPairs:      state._stagedProsePairs,
        stagedPairOffset: state._stagedPairOffset,
        splitPairIdx:     state._splitPairIdx,
        scenario_hooks:   '',
    }, ragSettings);
    await waitForRagChunks(120_000);

    const settled = state._ragChunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length || !anchorUuid) return;

    const chatFile = SillyTavern.getContext().getCurrentChatFile?.() ?? null;
    await insertSyncChunks(cnzAvatarKey(char.avatar), anchorUuid, chatFile, state._ragChunks, state._stagedPairOffset);
}
