/**
 * @file data/default-user/extensions/canonize/modal/commit-ui.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * DOM-only rendering helpers for Step 4 of the review modal. Covers receipt
 * panel display, draft change counting, step summary population, and error
 * surfacing. No IO — reads from state, writes to DOM only.
 *
 * @api-declaration
 * showReceiptsPanel, showRecoveryGuide, upsertReceiptItem,
 * receiptSuccess, receiptFailure, countDraftChanges,
 * populateRagPanel, populateStep4Summary, abortCommitWithError,
 * renderReceipts
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM]
 */

import { state, escapeHtml }  from '../state.js';
import { getSettings }        from '../core/settings.js';
import { stripProtectedBlock } from '../lorebook/utils.js';

// ─── Receipt Panel ────────────────────────────────────────────────────────────

export function showReceiptsPanel() { $('#cnz-receipts').removeClass('cnz-hidden'); }

export function showRecoveryGuide() {
    $('#cnz-recovery-guide').removeClass('cnz-hidden');
    $('#cnz-cancel').text('Close');
}

export function upsertReceiptItem(id, html) {
    if (!$(`#${id}`).length) {
        $('#cnz-receipts-content').append(`<div id="${id}" class="cnz-receipt-row"></div>`);
    }
    $(`#${id}`).html(html);
}

export function receiptSuccess(text, hint = null) {
    return `<span class="cnz-receipt-item success">&#x2713; ${escapeHtml(text)}</span>` +
           (hint ? `<div class="cnz-receipt-hint">${escapeHtml(hint)}</div>` : '');
}

export function receiptFailure(text) {
    return `<span class="cnz-receipt-item failure">&#x2717; ${escapeHtml(text)}</span>`;
}

// ─── Step Summary ─────────────────────────────────────────────────────────────

export function countDraftChanges() {
    if (!state._draftLorebook || !state._lorebookData) return 0;
    const orig  = state._lorebookData.entries  ?? {};
    const draft = state._draftLorebook.entries ?? {};
    return Object.values(draft).filter(e => {
        const o = orig[String(e.uid)];
        return !o
            || stripProtectedBlock(o.content) !== stripProtectedBlock(e.content)
            || JSON.stringify(o.key) !== JSON.stringify(e.key)
            || (o.comment ?? '') !== (e.comment ?? '');
    }).length;
}

export function populateRagPanel() {
    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    const settled = state._ragChunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    const label = `${settled.length} chunk${settled.length !== 1 ? 's' : ''} indexed in vector DB`;
    $('#cnz-rag-timeline').html(`<div class="cnz-rag-item cnz-rag-item--existing">&#x2713; ${escapeHtml(label)}</div>`);
    $('#cnz-rag-warning').addClass('cnz-hidden');
    $('#cnz-step4-rag').removeClass('cnz-hidden');
}

export function populateStep4Summary() {
    const loreCount   = countDraftChanges();
    const loreLabel   = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb   = state._lorebookSuggestions.filter(s => s.status === 'pending').length;
    const pendingText = pendingLb > 0
        ? ` ⚠ ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    const plotCount = Object.keys(state._draftPlotLorebook?.entries ?? {}).length;
    const hooksText    = $('#cnz-situation-text').val().trim();
    const hooksPreview = hooksText.length > 100 ? hooksText.slice(0, 100) + '…' : (hooksText || '(empty)');
    $('#cnz-step4-hooks').text(`Hooks: ${hooksPreview}`);
    $('#cnz-step4-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
    $('#cnz-step4-plot').text(`Plot: ${plotCount} entr${plotCount !== 1 ? 'ies' : 'y'}`);
    populateRagPanel();
}

export function abortCommitWithError(message) {
    $('#cnz-error-4').text(message).removeClass('cnz-hidden');
    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', false);
    showRecoveryGuide();
}

// ─── Receipts Renderer ────────────────────────────────────────────────────────

export function renderReceipts(results) {
    for (const r of results) {
        if (r.status === 'skipped') continue;
        const id = `cnz-receipt-${r.task}`;
        if (r.status === 'success') {
            upsertReceiptItem(id, receiptSuccess(r.detail));
        } else {
            upsertReceiptItem(id, receiptFailure(r.error));
        }
    }
}
