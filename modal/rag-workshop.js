/**
 * @file data/default-user/extensions/canonize/modal/rag-workshop.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role UI Builder
 * @description
 * Owns Step 3 of the review modal (RAG Workshop). Handles chunk card rendering,
 * tab switching between sectioned/raw views, raw mode detach/revert, and
 * individual chunk regen dispatch.
 *
 * @api-declaration
 * onRagTabSwitch, renderRagCards, renderRagCard, autoResizeRagCardHeader,
 * updateRagRawFromCards, updateRagCardsFromRaw, updateRagRaw,
 * onRagRawInput, onRagRevertRaw, onEnterRagWorkshop, onLeaveRagWorkshop,
 * ragRegenCard
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._ragRawDetached]
 *     external_io: [generateRaw]
 */

import { state, escapeHtml } from '../state.js';
import { getSettings } from '../core/settings.js';
import { buildProsePairs } from '../core/transcript.js';
import { buildRagDocument, renderAllChunkChatLabels, ragRegenCard as _ragRegenCard } from '../rag/pipeline.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';

// ─── Internal helpers ─────────────────────────────────────────────────────────

function compileRagFromChunks() {
    const ctx      = SillyTavern.getContext();
    const charName = ctx?.characters?.[ctx?.characterId]?.name ?? '';
    return buildRagDocument(state._ragChunks, getSettings(), charName);
}

export function autoResizeRagRaw() {
    const el = document.getElementById('cnz-rag-raw');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

export function autoResizeRagCardHeader(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function buildRagCardHTML(chunk) {
    const i          = chunk.chunkIndex;
    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    return `
<div class="cnz-rag-card" data-chunk-index="${i}" data-status="${chunk.status}">
  <div class="cnz-rag-card-header-row">
    <textarea class="cnz-input cnz-rag-card-header"
              data-chunk-index="${i}"
              ${isInFlight || state._ragRawDetached ? 'disabled' : ''}>${escapeHtml(chunk.header)}</textarea>
    <span class="cnz-rag-card-spinner fa-solid fa-spinner fa-spin${isInFlight ? '' : ' cnz-hidden'}"></span>
    <span class="cnz-rag-queue-label${isPending ? '' : ' cnz-hidden'}">pending</span>
    <button class="cnz-btn cnz-btn-secondary cnz-btn-sm cnz-rag-card-regen"
            data-chunk-index="${i}"
            title="Regenerate this chunk's semantic header"
            ${state._ragRawDetached ? 'disabled' : ''}>&#x21bb;</button>
  </div>
  <div class="cnz-rag-card-body">${escapeHtml(chunk.content)}</div>
</div>`;
}

// ─── RAG Workshop ─────────────────────────────────────────────────────────────

/** Alias exported under the target API name. */
export function renderRagCards() {
    renderRagWorkshop();
}

function renderRagWorkshop() {
    const $cards = $('#cnz-rag-cards').empty();
    for (const chunk of state._ragChunks) {
        $cards.append(buildRagCardHTML(chunk));
    }
    $cards.find('.cnz-rag-card-header').each(function () { autoResizeRagCardHeader(this); });
}

/**
 * Updates the dynamic parts of a single chunk card in place.
 * No-ops silently when the modal is not open (card element not found).
 * @param {number} chunkIndex
 */
export function renderRagCard(chunkIndex) {
    const chunk = state._ragChunks[chunkIndex];
    if (!chunk) return;
    const $card = $(`.cnz-rag-card[data-chunk-index="${chunkIndex}"]`);
    if (!$card.length) return;

    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    const disabled   = isInFlight || state._ragRawDetached;

    $card.attr('data-status', chunk.status);
    const $header = $card.find('.cnz-rag-card-header').val(chunk.header).prop('disabled', disabled);
    autoResizeRagCardHeader($header[0]);
    $card.find('.cnz-rag-card-spinner').toggleClass('cnz-hidden', !isInFlight);
    $card.find('.cnz-rag-queue-label').toggleClass('cnz-hidden', !isPending).text('pending');
    $card.find('.cnz-rag-card-regen').prop('disabled', state._ragRawDetached);
}

/** Re-export ragRegenCard under the workshop name. */
export function ragRegenCard(chunkIndex) {
    _ragRegenCard(chunkIndex);
}

export function onRagTabSwitch(tabName) {
    $('#cnz-rag-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-rag-tab-sectioned').toggleClass('cnz-hidden', tabName !== 'sectioned');
    $('#cnz-rag-tab-raw').toggleClass('cnz-hidden',      tabName !== 'raw');
    if (tabName === 'raw' && !state._ragRawDetached) {
        $('#cnz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }
}

export function onRagRawInput() {
    autoResizeRagRaw();
    if (!state._ragRawDetached) {
        state._ragRawDetached = true;
        $('#cnz-rag-raw').addClass('cnz-rag-detached');
        $('#cnz-rag-raw-detached-label').removeClass('cnz-hidden');
        $('#cnz-rag-detached-warn').removeClass('cnz-hidden');
        $('#cnz-rag-detached-revert').removeClass('cnz-hidden');
        $('.cnz-rag-card-header, .cnz-rag-card-regen').prop('disabled', true);
    }
}

export function onRagRevertRaw() {
    state._ragRawDetached = false;
    $('#cnz-rag-raw').val(compileRagFromChunks()).removeClass('cnz-rag-detached');
    autoResizeRagRaw();
    $('#cnz-rag-raw-detached-label, #cnz-rag-detached-warn, #cnz-rag-detached-revert').addClass('cnz-hidden');
    renderRagWorkshop();
}

function getRagModeLabel() {
    return 'Output: AI-classified summary + full text';
}

/**
 * Called when the user enters Step 3 (RAG Workshop).
 */
export function onEnterRagWorkshop() {
    if (!getSettings().enableRag) {
        $('#cnz-rag-mode-note').addClass('cnz-hidden');
        $('#cnz-rag-disabled').removeClass('cnz-hidden');
        return;
    }
    $('#cnz-rag-disabled').addClass('cnz-hidden');
    $('#cnz-rag-mode-note').text(getRagModeLabel()).removeClass('cnz-hidden');

    renderRagWorkshop();
    renderAllChunkChatLabels();

    const pendingChunks  = state._ragChunks.filter(c => c.status === 'pending');
    const inFlightChunks = state._ragChunks.filter(c => c.status === 'in-flight');
    if (pendingChunks.length > 0 && inFlightChunks.length === 0) {
        const messages = SillyTavern.getContext().chat ?? [];
        const fullPairs = buildProsePairs(messages);
        const settings  = getSettings();
        setCurrentSettings(settings);
        dispatchContract('rag_classifier', {
            ragChunks:        pendingChunks,
            fullPairs,
            stagedPairs:      state._stagedProsePairs,
            stagedPairOffset: state._stagedPairOffset,
            splitPairIdx:     state._splitPairIdx,
            scenario_hooks:   '',
        }, settings);
    }
}

export function onLeaveRagWorkshop() {
    // Fan-out jobs remain in-flight; invalidateAllJobs() handles cancellation on modal close.
}

// Alias for the raw update functions expected in the API declaration
export function updateRagRaw() {
    if (!state._ragRawDetached) {
        $('#cnz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }
}

export function updateRagRawFromCards() { updateRagRaw(); }
export function updateRagCardsFromRaw() { renderRagWorkshop(); }
