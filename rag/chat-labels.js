/**
 * @file data/default-user/extensions/canonize/rag/chat-labels.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * All RAG-related DOM and chat-message IO. Injects chunk labels into the chat
 * UI, persists chunk headers into message.extra so they survive page reloads,
 * and hydrates in-memory chunk state from those stored headers on load.
 * No classification dispatch, no upload, no bus logic.
 *
 * @api-declaration
 * renderSeparator(chunk)
 * renderChunkChatLabel(chunkIndex)
 * renderAllChunkChatLabels()
 * renderChunkLabelsFromChat()
 * clearChunkChatLabels()
 * writeChunkHeaderToChat(chunkIndex)
 * hydrateChunkHeadersFromChat()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM, /api/chats/saveChat, message.extra (read/write)]
 */

import { state } from '../state.js';
import { getSettings } from '../core/settings.js';
import { interpolate } from '../defaults.js';
import { error } from '../log.js';

const DEFAULT_SEPARATOR = 'Chunk {{chunk_number}} ({{turn_range}})';

// ─── Separator ────────────────────────────────────────────────────────────────

/**
 * Renders the separator template for a given chunk using current settings.
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

// ─── Chat Label Rendering ─────────────────────────────────────────────────────

/**
 * Injects (or refreshes) a Canonize chunk label beneath the last AI message
 * of the chunk's pair window. No-ops when the message is not in the DOM.
 * @param {number} chunkIndex
 */
export function renderChunkChatLabel(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk) return;

    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair        = state._stagedProsePairs[lastPairIdx];
    const lastMsg     = pair?.messages?.[pair.messages.length - 1];
    if (!lastMsg) return;

    const chat  = SillyTavern.getContext().chat ?? [];
    const mesId = chat.indexOf(lastMsg);
    if (mesId === -1) return;

    const $msgDiv = $(`div[mesid="${mesId}"]`);
    if (!$msgDiv.length) return;

    $msgDiv.find('.cnz-chunk-label').remove();

    if (chunk.status === 'pending' || chunk.status === 'in-flight') return;

    const bodyText = (chunk.status === 'complete' || chunk.status === 'manual')
        ? `${chunk.turnRange}: ${chunk.header}`
        : chunk.turnRange;

    const $label = $('<div class="cnz-chunk-label"></div>');
    $label.append($('<span class="cnz-chunk-label-prefix">◆ CANONIZE </span>'));
    $label.append($('<span>').text(bodyText));
    $msgDiv.find('div.mes_text').after($label);
}

/**
 * Renders chunk labels for every chunk in state._ragChunks.
 */
export function renderAllChunkChatLabels() {
    for (let i = 0; i < state._ragChunks.length; i++) {
        renderChunkChatLabel(i);
    }
}

/**
 * Renders chunk labels for all messages that carry persisted cnz_chunk_header
 * stamps. Works without staging state — reads directly from ctx.chat.
 * Called by the session lifecycle on chat load so labels survive page reloads.
 */
export function renderChunkLabelsFromChat() {
    const ctx  = SillyTavern.getContext();
    const chat = ctx?.chat ?? [];
    for (let i = 0; i < chat.length; i++) {
        const msg    = chat[i];
        const header = msg?.extra?.cnz_chunk_header;
        if (!header) continue;
        const $msgDiv = $(`div[mesid="${i}"]`);
        if (!$msgDiv.length) continue;
        $msgDiv.find('.cnz-chunk-label').remove();
        const label     = msg.extra?.cnz_turn_label ?? '';
        const turnRange = label.replace(/^[%*]+\s*Memory:\s*/i, '').trim() || label;
        const bodyText  = turnRange ? `${turnRange}: ${header}` : header;
        const $label = $('<div class="cnz-chunk-label"></div>');
        $label.append($('<span class="cnz-chunk-label-prefix">◆ CANONIZE </span>'));
        $label.append($('<span>').text(bodyText));
        $msgDiv.find('div.mes_text').after($label);
    }
}

/**
 * Removes all Canonize chunk labels from the chat UI.
 * Called on chat/character switch so stale labels don't bleed across chats.
 */
export function clearChunkChatLabels() {
    $('#chat').find('.cnz-chunk-label').remove();
}

// ─── Chat Header Persistence ──────────────────────────────────────────────────

/**
 * Writes a completed chunk's header into the last AI message of its pair window
 * as message.extra.cnz_chunk_header / cnz_turn_label, then saves the chat.
 * @param {number} chunkIndex
 */
export async function writeChunkHeaderToChat(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk || (chunk.status !== 'complete' && chunk.status !== 'manual')) return;
    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair        = state._stagedProsePairs[lastPairIdx];
    const lastMsg     = pair?.messages?.[pair.messages.length - 1];
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
 * Marks matching chunks 'complete' so they skip AI classification.
 * Mismatches (different separator template or boundaries) are left 'pending'.
 */
export function hydrateChunkHeadersFromChat() {
    for (const chunk of state._ragChunks) {
        if (chunk.status === 'complete') continue;
        const lastPairIdx = (chunk.pairEnd ?? chunk.chunkIndex + 1) - 1;
        const pair        = state._stagedProsePairs[lastPairIdx];
        const lastMsg     = pair?.messages?.[pair.messages.length - 1];
        if (!lastMsg?.extra?.cnz_chunk_header) continue;
        if (lastMsg.extra.cnz_turn_label !== renderSeparator(chunk)) continue;
        chunk.header = lastMsg.extra.cnz_chunk_header;
        chunk.status = 'complete';
    }
}
