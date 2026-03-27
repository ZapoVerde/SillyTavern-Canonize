/**
 * @file data/default-user/extensions/canonize/rag/pipeline.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role Stateful Owner
 * @description
 * Owns chunk building, AI classification dispatch, chat-header hydration, and
 * document assembly. `buildRagChunks` is a pure function that partitions the
 * prose pair list into fixed-size windows. `runRagPipeline` manages the full
 * sync-time RAG flow: build → hydrate → classify → wait → upload → register.
 * The `waitForRagChunks` bus listener resolves when the fan-out settles.
 *
 * @api-declaration
 * buildRagDocument, buildRagChunks, hydrateChunkHeadersFromChat,
 * waitForRagChunks, ragRegenCard, runRagPipeline,
 * resolveClassifierHistory, renderSeparator,
 * renderChunkChatLabel, renderAllChunkChatLabels, clearChunkChatLabels,
 * writeChunkHeaderToChat
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
import { buildProsePairs } from '../core/transcript.js';
import { getSettings } from '../core/settings.js';
import { interpolate } from '../defaults.js';
import { uploadRagFile, registerCharacterAttachment, cnzAvatarKey, cnzFileName } from './api.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_SEPARATOR = 'Chunk {{chunk_number}} ({{turn_range}})';

// ─── RAG Document Builder ─────────────────────────────────────────────────────

/**
 * Builds the final RAG document from the workshop chunk state.
 * Each chunk is prefixed with the separator template (default '***').
 * ragContents controls whether summary header, full content, or both are emitted.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  ragChunks
 * @param {object} settings   Active profile settings (ragContents, ragSeparator).
 * @param {string} charName   Character name for separator interpolation.
 * @returns {string}
 */
export function buildRagDocument(ragChunks, settings, charName) {
    if (!ragChunks.length) return '';
    const contents    = settings.ragContents    ?? 'summary+full';
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;

    const body = ragChunks.map(c => {
        const sep = interpolate(sepTemplate, {
            chunk_number: String(c.chunkIndex + 1),
            turn_number:  String(c.chunkIndex + 1),   // backward-compat alias
            turn_range:   c.turnRange,
            char_name:    charName,
        });
        const parts = [sep];
        if (contents !== 'full')    parts.push(c.header);   // summary
        if (contents !== 'summary') parts.push(c.content);  // full content
        return parts.filter(Boolean).join('\n\n');
    }).join('\n\n***\n\n').trim();
    return `[Narrative Memory]\n\n${body}`;
}

// ─── Chunk Builder ────────────────────────────────────────────────────────────

/**
 * Builds the state._ragChunks state array from the staged prose pairs.
 * Qvink mode: forced 1-pair windows, headers from qvink_memory metadata.
 * Defined mode: ragChunkSize-pair sliding windows, headers from AI classifier.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  pairs
 * @param {number} [pairOffset=0]
 * @param {object} settings  Active profile settings (ragSummarySource, ragChunkSize, ragChunkOverlap).
 * @returns {Array}
 */
export function buildRagChunks(pairs, pairOffset = 0, settings) {
    // Exclude user-only pairs (no AI response yet) — they produce empty RAG chunks
    // that confuse the classifier with a stimulus and no reply.
    pairs = pairs.filter(p => p.messages.length > 0);
    const chunks    = [];
    const useQvink  = (settings.ragSummarySource ?? 'defined') === 'qvink';
    const chunkSize = useQvink ? 1 : Math.max(1, settings.ragChunkSize ?? 2);
    const overlap   = useQvink ? 0 : Math.max(0, settings.ragChunkOverlap ?? 0);

    if (overlap === 0) {
        // Non-overlapping: advance by chunkSize each step
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const window    = pairs.slice(i, i + chunkSize);
            const turnA     = pairOffset + i + 1;
            const turnB     = pairOffset + Math.min(i + chunkSize, pairs.length);
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            const content = window
                .map(p => {
                    const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                    for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                    return parts.join('\n\n');
                })
                .join('\n\n');

            const qvinkText = useQvink ? (pairs[i].messages[0]?.extra?.qvink_memory?.memory || null) : null;

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  i,
                pairEnd:    Math.min(i + chunkSize, pairs.length),
                turnRange,
                content,
                header:  qvinkText || turnRange,
                status:  (useQvink && qvinkText) ? 'complete' : 'pending',
            });
        }
    } else {
        // Overlapping: step = 1 new pair per chunk; each chunk includes `overlap` prior pairs
        for (let i = 0; i < pairs.length; i++) {
            const sliceFrom = Math.max(0, i - overlap);
            const window    = pairs.slice(sliceFrom, i + 1);
            const turnA     = pairOffset + sliceFrom + 1;
            const turnB     = pairOffset + i + 1;
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            const content = window
                .map(p => {
                    const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                    for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                    return parts.join('\n\n');
                })
                .join('\n\n');

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  sliceFrom,
                pairEnd:    i + 1,
                turnRange,
                content,
                header:  turnRange,
                status:  'pending',
            });
        }
    }
    return chunks;
}

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
        console.error('[CNZ] writeChunkHeaderToChat: saveChat failed:', err);
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
            console.warn(`[CNZ] RAG chunk wait timed out after ${timeoutMs}ms — some chunks may be incomplete`);
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

    return historyPairs
        .map(p => {
            const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
            for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
            return parts.join('\n\n');
        })
        .join('\n\n');
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
export async function runRagPipeline() {
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

    state._splitPairIdx           = state._stagedProsePairs.length;
    const ragSettings = getSettings();
    state._ragChunks              = buildRagChunks(state._stagedProsePairs, state._stagedPairOffset, ragSettings);

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

    const ctx2      = SillyTavern.getContext();
    const charName2 = ctx2?.characters?.[ctx2?.characterId]?.name ?? '';
    const ragText   = buildRagDocument(state._ragChunks, getSettings(), charName2);
    if (!ragText.trim()) return;

    const charName   = char.name;
    const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), charName);
    state._lastRagUrl      = await uploadRagFile(ragText, ragFileName);

    const byteSize = new TextEncoder().encode(ragText).length;
    registerCharacterAttachment(char.avatar, state._lastRagUrl, ragFileName, byteSize);
}
