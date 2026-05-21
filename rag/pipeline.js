/**
 * @file data/default-user/extensions/canonize/rag/pipeline.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role Orchestrator
 * @description
 * AI classification dispatch, chat-header hydration, document upload, and
 * chat-label rendering. Pure chunk derivation lives in rag/chunks.js.
 * `runRagPipeline` manages the full sync-time RAG flow:
 * build → hydrate → classify → wait → upload → register.
 * The `waitForRagChunks` bus listener resolves when the fan-out settles.
 *
 * @api-declaration
 * hydrateChunkHeadersFromChat, waitForRagChunks, ragRegenCard, runRagPipeline,
 * resolveClassifierHistory, renderSeparator,
 * renderChunkChatLabel, renderAllChunkChatLabels, clearChunkChatLabels,
 * writeChunkHeaderToChat
 *
 * Re-exports (from rag/chunks.js): buildRagDocument, buildRagChunks
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._ragChunks, state._stagedProsePairs,
 *                       state._stagedPairOffset, state._splitPairIdx, state._lastRagUrl]
 *     external_io: [generateRaw, /api/chats/saveChat, /api/files/upload]
 */

import { state } from '../state.js';
import { on, off, BUS_EVENTS } from '../bus.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { buildProsePairs, formatPairsAsTranscript, buildSceneSlices } from '../core/transcript.js';
import { getSettings } from '../core/settings.js';
import { interpolate } from '../defaults.js';
import { uploadRagFile, registerCharacterAttachment, cnzAvatarKey, cnzFileName } from './api.js';
import { pushScenesToVectFox } from './vectfox-bridge.js';
import { warn, error } from '../log.js';
import { buildRagChunks, buildRagDocument } from './chunks.js';

// Re-export pure functions so existing callers importing from pipeline.js keep working.
export { buildRagChunks, buildRagDocument } from './chunks.js';

// ─── Chat Label Rendering ─────────────────────────────────────────────────────

/**
 * Injects (or refreshes) a Canonize chunk label beneath the last AI message
 * of the chunk in the chat UI.  Mirrors the Qvink pattern: find the message
 * by mesid, append a styled div after div.mes_text.
 * No-ops when the message is not currently in the DOM.
 * @param {number} chunkIndex
 */
export function renderChunkChatLabel(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk) return;

    // Resolve the last AI message in this chunk's pair window
    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair = state._stagedProsePairs[lastPairIdx];
    const lastMsg = pair?.messages?.[pair.messages.length - 1];
    if (!lastMsg) return;

    const chat  = SillyTavern.getContext().chat ?? [];
    const mesId = chat.indexOf(lastMsg);
    if (mesId === -1) return;

    const $msgDiv = $(`div[mesid="${mesId}"]`);
    if (!$msgDiv.length) return;

    // Replace any existing label on this message
    $msgDiv.find('.cnz-chunk-label').remove();

    // For pending/in-flight chunks don't inject yet — label appears on completion
    if (chunk.status === 'pending' || chunk.status === 'in-flight') return;

    const bodyText = (chunk.status === 'complete' || chunk.status === 'manual')
        ? `${chunk.turnRange}: ${chunk.header}`
        : chunk.turnRange;   // stale/error — show turn range only

    const $label = $('<div class="cnz-chunk-label"></div>');
    $label.append($('<span class="cnz-chunk-label-prefix">◆ CANONIZE </span>'));
    $label.append($('<span>').text(bodyText));
    $msgDiv.find('div.mes_text').after($label);
}

/**
 * Renders chunk labels for every chunk in state._ragChunks.
 * Called on workshop open and after full sync so all turns get annotated.
 */
export function renderAllChunkChatLabels() {
    for (let i = 0; i < state._ragChunks.length; i++) {
        renderChunkChatLabel(i);
    }
}

/**
 * Removes all Canonize chunk labels from the chat UI.
 * Called on chat/character switch so stale labels don't bleed across chats.
 */
export function clearChunkChatLabels() {
    $('#chat').find('.cnz-chunk-label').remove();
}

// ─── Separator ────────────────────────────────────────────────────────────────

/**
 * Renders the separator template for a given chunk.
 * @param {object} chunk
 * @returns {string}
 */
export function renderSeparator(chunk) {
    const settings    = getSettings();
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;
    const ctx         = SillyTavern.getContext();
    const charName    = ctx?.characters?.[ctx?.characterId]?.name ?? '';
    return interpolate(sepTemplate, {
        chunk_number: String(chunk.chunkIndex + 1),
        turn_number:  String(chunk.chunkIndex + 1),
        turn_range:   chunk.turnRange,
        char_name:    charName,
    });
}

// ─── Chat Header Persistence ──────────────────────────────────────────────────

/**
 * Writes a completed chunk's header into the last AI message of its pair window
 * as message.extra.cnz_chunk_header / cnz_turn_label, then saves the chat.
 * The chat file is the source of truth — this makes headers survive page reloads.
 * @param {number} chunkIndex
 */
export async function writeChunkHeaderToChat(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk || (chunk.status !== 'complete' && chunk.status !== 'manual')) return;
    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair = state._stagedProsePairs[lastPairIdx];
    const lastMsg = pair?.messages?.[pair.messages.length - 1];
    if (!lastMsg) return;
    if (!lastMsg.extra) lastMsg.extra = {};
    lastMsg.extra.cnz_chunk_header = chunk.header;
    lastMsg.extra.cnz_turn_label   = renderSeparator(chunk);
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        error('Rag', 'writeChunkHeaderToChat: saveChat failed:', err);
    }
}

/**
 * Reads cnz_chunk_header / cnz_turn_label from each chunk's last AI message.
 * If the stored turn label matches the current rendered separator (same chunk
 * boundaries and same separator template), the chunk is pre-populated as complete
 * and skips AI classification.  Mismatches are left as 'pending'.
 * Uses state._stagedProsePairs as the pair source.
 */
export function hydrateChunkHeadersFromChat() {
    for (const chunk of state._ragChunks) {
        if (chunk.status === 'complete') continue;   // qvink or already hydrated
        const lastPairIdx = (chunk.pairEnd ?? chunk.chunkIndex + 1) - 1;
        const pair = state._stagedProsePairs[lastPairIdx];
        const lastMsg = pair?.messages?.[pair.messages.length - 1];
        if (!lastMsg?.extra?.cnz_chunk_header) continue;
        if (lastMsg.extra.cnz_turn_label !== renderSeparator(chunk)) continue;
        chunk.header = lastMsg.extra.cnz_chunk_header;
        chunk.status = 'complete';
    }
}

// ─── Chunk Regen ─────────────────────────────────────────────────────────────

/**
 * Fires a single RAG classifier call for the chunk at chunkIndex.
 * @param {number} chunkIndex
 */
export function ragRegenCard(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk) return;

    chunk.status = 'pending';

    // renderRagCard is in modal/rag-workshop.js — deferred import to avoid circular dep
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

// ─── Classifier History ───────────────────────────────────────────────────────

/**
 * Pure utility — kept as reference for the logic inlined in rag_classifier.fanOut.
 * @param {number} pairStart
 * @param {number} historyN
 * @param {Array}  fullPairs
 * @param {number} stagedPairOffset
 */
export function resolveClassifierHistory(pairStart, historyN, fullPairs, stagedPairOffset = 0) {
    if (historyN <= 0) return '';

    // Absolute index of chunk.pairStart in the full pair array
    const absoluteStart = stagedPairOffset + pairStart;

    // Slice the history window — may reach into committed turns
    const historySliceStart = Math.max(0, absoluteStart - historyN);
    const historyPairs      = fullPairs.slice(historySliceStart, absoluteStart);

    if (!historyPairs.length) return '';

    return formatPairsAsTranscript(historyPairs);
}

// ─── Full Sync Pipeline ───────────────────────────────────────────────────────

/**
 * Builds RAG chunks for the current sync window, classifies them, uploads the
 * RAG document, and registers it as a character attachment.
 *
 * Expects state._stagedProsePairs and state._stagedPairOffset to have been set by the caller
 * (runCnzSync) before this function is invoked.
 *
 * @returns {Promise<void>}
 */
export async function runRagPipeline(anchorUuid = null) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');

    const messages = ctx.chat ?? [];
    const allPairs = buildProsePairs(messages);

    // Surgical unlock: guard against direct calls where staged pairs were not set.
    if (state._stagedProsePairs.length === 0 && allPairs.length > 0) {
        state._stagedProsePairs = [allPairs[allPairs.length - 1]];
        const firstValidIdx = state._stagedProsePairs[0].validIdx;
        const foundIdx      = allPairs.findIndex(p => p.validIdx >= firstValidIdx);
        state._stagedPairOffset   = foundIdx === -1 ? 0 : foundIdx;
    }

    state._splitPairIdx = state._stagedProsePairs.length;
    const ragSettings   = getSettings();

    // VectFox path: skip classifier entirely — slice raw transcript by scene
    // boundaries (Vistalyze stamps) or max-pairs cap, then push directly.
    if (ragSettings.useVectFox) {
        const maxPairs = ragSettings.vectfoxMaxPairsPerChunk ?? 15;
        const scenes   = buildSceneSlices(state._stagedProsePairs, maxPairs);
        if (scenes.length > 0) {
            try {
                await pushScenesToVectFox(scenes, cnzAvatarKey(char.avatar));
            } catch (err) {
                error('Pipeline', 'VectFox scene push failed:', err);
                toastr.warning('CNZ: VectFox sync failed — scenes not indexed.');
            }
        }
        return;
    }

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

    const settings2 = getSettings();

    const ctx2      = SillyTavern.getContext();
    const charName2 = ctx2?.characters?.[ctx2?.characterId]?.name ?? '';
    const ragText   = buildRagDocument(state._ragChunks, settings2, charName2);
    if (!ragText.trim()) return;

    const charName    = char.name;
    const anchorHash  = anchorUuid ? anchorUuid.slice(0, 8) : '';
    const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), charName, anchorHash);
    state._lastRagUrl      = await uploadRagFile(ragText, ragFileName);

    const byteSize = new TextEncoder().encode(ragText).length;
    registerCharacterAttachment(char.avatar, state._lastRagUrl, ragFileName, byteSize);
}
