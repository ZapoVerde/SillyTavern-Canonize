/**
 * @file data/default-user/extensions/canonize/modal/commit.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role UI Builder
 * @description
 * Owns Step 4 of the review modal (Finalize / Commit). Handles the receipts
 * panel, draft-change counting, RAG panel population, step-4 summary display,
 * character world patching, and the Confirm button handler that conditionally
 * writes hooks, lorebook, RAG, and updates the DNA anchor in place.
 *
 * @api-declaration
 * patchCharacterWorld, showReceiptsPanel, showRecoveryGuide, upsertReceiptItem,
 * receiptSuccess, receiptFailure, countDraftChanges, populateRagPanel,
 * populateStep4Summary, abortCommitWithError, onConfirmClick
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: []
 *     external_io: [/api/characters/edit, /api/files/upload, /api/chats/saveChat]
 */

import { getRequestHeaders } from '../../../../../script.js';
import { extension_settings as ext_settings } from '../../../../extensions.js';
import { state, escapeHtml } from '../state.js';
import { getSettings } from '../core/settings.js';
import { readDnaChain } from '../core/dna-chain.js';
import { writeCnzSummaryPrompt } from '../core/summary-prompt.js';
import { isDraftDirty } from '../lorebook/utils.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { buildRagDocument } from '../rag/pipeline.js';
import { uploadRagFile, registerCharacterAttachment, cnzAvatarKey, cnzFileName } from '../rag/api.js';

// ─── Character World Patch ────────────────────────────────────────────────────

export async function patchCharacterWorld(char, lorebookName) {
    const updatedChar = structuredClone(char);
    if (!updatedChar.data)            updatedChar.data = {};
    if (!updatedChar.data.extensions) updatedChar.data.extensions = {};
    updatedChar.data.extensions.world = lorebookName;

    const formData = new FormData();
    formData.append('ch_name',                   char.name);
    formData.append('description',               char.description                      ?? '');
    formData.append('personality',               char.personality                      ?? '');
    formData.append('scenario',                  char.scenario                         ?? '');
    formData.append('first_mes',                 char.first_mes                        ?? '');
    formData.append('mes_example',               char.mes_example                      ?? '');
    formData.append('creator_notes',             char.data?.creator_notes              ?? '');
    formData.append('system_prompt',             char.data?.system_prompt              ?? '');
    formData.append('post_history_instructions', char.data?.post_history_instructions  ?? '');
    formData.append('creator',                   char.data?.creator                    ?? '');
    formData.append('character_version',         char.data?.character_version          ?? '');
    formData.append('world',                     lorebookName);
    formData.append('json_data',                 JSON.stringify(updatedChar));
    formData.append('avatar_url',                char.avatar);
    formData.append('chat',                      char.chat);
    formData.append('create_date',               char.create_date);

    const headers = getRequestHeaders();
    delete headers['Content-Type'];

    const res = await fetch('/api/characters/edit', {
        method:  'POST',
        headers,
        body:    formData,
    });
    if (!res.ok) throw new Error(`World link patch failed (HTTP ${res.status})`);
}

// ─── Modal: Commit Receipts Panel ─────────────────────────────────────────────

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

// ─── Modal: Review & Commit Step ─────────────────────────────────────────────

export function countDraftChanges() {
    if (!state._draftLorebook || !state._lorebookData) return 0;
    const orig  = state._lorebookData.entries  ?? {};
    const draft = state._draftLorebook.entries ?? {};
    return Object.values(draft).filter(e => {
        const o = orig[String(e.uid)];
        return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key) || (o.comment ?? '') !== (e.comment ?? '');
    }).length;
}

export function populateRagPanel() {
    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char || !getSettings().enableRag) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    const allAttachments = ext_settings.character_attachments?.[char.avatar] ?? [];
    const headAnchor     = state._dnaChain?.lkg;
    const ragExpected    = headAnchor && (headAnchor.ragHeaders?.length > 0 || headAnchor.ragUrl);
    if (!allAttachments.length && !ragExpected) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    if (ragExpected && !allAttachments.length) {
        $('#cnz-rag-timeline').empty();
        $('#cnz-rag-warning').text('Narrative Memory file missing — confirm to rebuild from current chunks.').removeClass('cnz-hidden');
        $('#cnz-step4-rag').removeClass('cnz-hidden');
        return;
    }
    const rows = allAttachments.map(a =>
        `<div class="cnz-rag-item cnz-rag-item--existing">&#x2713; ${escapeHtml(a.name.replace(/\.txt$/i, ''))}</div>`,
    );
    $('#cnz-rag-timeline').html(rows.join(''));
    $('#cnz-rag-warning').addClass('cnz-hidden');
    $('#cnz-step4-rag').removeClass('cnz-hidden');
}

export function populateStep4Summary() {
    const loreCount   = countDraftChanges();
    const loreLabel   = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb   = state._lorebookSuggestions.filter(s => !s._applied && !s._rejected).length;
    const pendingText = pendingLb > 0
        ? ` \u26a0 ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    const hooksText    = $('#cnz-situation-text').val().trim();
    const hooksPreview = hooksText.length > 100 ? hooksText.slice(0, 100) + '\u2026' : (hooksText || '(empty)');
    $('#cnz-step4-hooks').text(`Hooks: ${hooksPreview}`);
    $('#cnz-step4-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
    populateRagPanel();
}

export function abortCommitWithError(message) {
    $('#cnz-error-4').text(message).removeClass('cnz-hidden');
    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', false);
    showRecoveryGuide();
}

/**
 * Handles the modal Confirm button. Conditionally writes back only what changed:
 * hooks (if textarea diverged from `_priorSituation`), lorebook (if `isDraftDirty`),
 * RAG (if any chunk header was manually edited or raw mode is detached).
 * Updates the head anchor in place — never writes a new anchor.
 * Closes the modal on completion.
 */
export async function onConfirmClick() {
    const hooksText = $('#cnz-situation-text').val().trim();

    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char) { toastr.error('CNZ: No character in context.'); return; }

    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', true);
    $('#cnz-error-4').addClass('cnz-hidden').text('');
    showReceiptsPanel();

    // Freshness check — abort if a sync committed while this modal was open
    const liveChainNow = readDnaChain(SillyTavern.getContext().chat ?? []);
    if ((liveChainNow.lkg?.uuid ?? null) !== state._modalOpenHeadUuid) {
        abortCommitWithError('A sync committed while this modal was open. Close and re-open to retry.');
        return;
    }

    let hooksChanged    = false;
    let lorebookChanged = false;
    let ragChanged      = false;
    let newRagUrl       = null;
    let newRagFileName  = null;

    // ── Step 1: Hooks save ───────────────────────────────────────────────────
    if (hooksText !== state._priorSituation) {
        try {
            // UUID unchanged — Confirm patches the head anchor in-place
            writeCnzSummaryPrompt(char.avatar, hooksText, state._dnaChain.lkg?.uuid ?? null);
            state._priorSituation = hooksText;
            hooksChanged = true;
            upsertReceiptItem('cnz-receipt-hooks', receiptSuccess('Narrative Hooks updated in CNZ Summary prompt'));
        } catch (err) {
            console.error('[CNZ] Hooks save failed:', err);
            upsertReceiptItem('cnz-receipt-hooks', receiptFailure(`Hooks save failed: ${err.message}`));
            abortCommitWithError(err.message);
            return;
        }
    }

    // ── Step 2: Lorebook save ────────────────────────────────────────────────
    if (isDraftDirty(state._draftLorebook, state._lorebookData)) {
        if (state._draftLorebook && state._lorebookName) {
            try {
                const preLorebook = structuredClone(state._lorebookData ?? { entries: {} });
                await lbSaveLorebook(state._lorebookName, state._draftLorebook);
                state._lorebookData = structuredClone(state._draftLorebook);

                lorebookChanged = true;

                const changedNames = Object.values(state._draftLorebook.entries ?? {})
                    .filter(e => { const o = preLorebook.entries[String(e.uid)]; return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key) || (o.comment ?? '') !== (e.comment ?? ''); })
                    .map(e => e.comment || String(e.uid));
                upsertReceiptItem('cnz-receipt-lorebook', receiptSuccess(
                    `Lorebook committed: ${changedNames.length ? changedNames.map(n => `"${n}"`).join(', ') : '(no changes staged)'}`,
                ));
            } catch (err) {
                upsertReceiptItem('cnz-receipt-lorebook', receiptFailure(`Lorebook save failed: ${err.message}`));
                abortCommitWithError(err.message);
                return;
            }
        }
    }

    // Reverts are saved immediately but the head anchor still needs updating
    if (!lorebookChanged && state._lorebookSuggestions.some(s => s._rejected)) {
        lorebookChanged = true;
    }

    // ── Step 3: RAG upload ───────────────────────────────────────────────────
    const hasManualChunks    = state._ragChunks.some(c => c.status === 'manual');
    const hasSettledChunks   = state._ragChunks.some(c => c.status === 'complete' || c.status === 'manual');
    const ragAttachments     = ext_settings.character_attachments?.[char.avatar] ?? [];
    const ragFileMissing     = hasSettledChunks && ragAttachments.length === 0;
    if (hasManualChunks || state._ragRawDetached || ragFileMissing) {
        try {
            const _ragCtx      = SillyTavern.getContext();
            const _ragCharName = _ragCtx?.characters?.[_ragCtx?.characterId]?.name ?? '';
            const ragText = state._ragRawDetached ? $('#cnz-rag-raw').val() : buildRagDocument(state._ragChunks, getSettings(), _ragCharName);
            if (ragText.trim()) {
                newRagFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name);
                newRagUrl      = await uploadRagFile(ragText, newRagFileName);
                state._lastRagUrl    = newRagUrl;
                const byteSize = new TextEncoder().encode(ragText).length;
                registerCharacterAttachment(char.avatar, newRagUrl, newRagFileName, byteSize);
                ragChanged = true;
                upsertReceiptItem('cnz-receipt-rag', receiptSuccess(`Narrative Memory saved: "${newRagFileName}" (${state._ragChunks.length} chunks)`));
            }
        } catch (err) {
            upsertReceiptItem('cnz-receipt-rag', receiptFailure(`RAG save failed: ${err.message}`));
            abortCommitWithError(`RAG upload failed: ${err.message}`);
            return;
        }
    }

    // ── Step 4: Patch DNA anchor in chat ─────────────────────────────────────
    if (hooksChanged || lorebookChanged || ragChanged) {
        try {
            const liveChain = readDnaChain(SillyTavern.getContext().chat ?? []);
            const lkgRef    = liveChain.lkg ? { anchor: liveChain.lkg, msgIdx: liveChain.lkgMsgIdx } : null;
            if (!lkgRef) {
                console.warn('[CNZ] onConfirmClick: no lkg anchor to patch — skipping DNA update');
            } else {
                const chatMsgs  = SillyTavern.getContext().chat ?? [];
                const anchorMsg = chatMsgs[lkgRef.msgIdx];
                if (!anchorMsg) {
                    console.warn('[CNZ] onConfirmClick: anchor message not found at index', lkgRef.msgIdx);
                } else {
                    const existing      = lkgRef.anchor;
                    const ragHeadersNew = state._ragChunks
                        .filter(c => c.status === 'complete' || c.status === 'manual')
                        .map(c => ({ chunkIndex: c.chunkIndex, header: c.header, turnRange: c.turnRange, pairStart: state._stagedPairOffset + c.pairStart, pairEnd: state._stagedPairOffset + c.pairEnd }));
                    anchorMsg.extra.cnz = Object.assign({}, existing, {
                        hooks:      hooksChanged    ? state._priorSituation                                                          : existing.hooks,
                        lorebook:   lorebookChanged ? Object.assign({ name: state._lorebookName }, structuredClone(state._draftLorebook)) : existing.lorebook,
                        ragUrl:     ragChanged      ? newRagUrl     : existing.ragUrl,
                        ragHeaders: ragChanged      ? ragHeadersNew : existing.ragHeaders,
                    });
                    try {
                        await SillyTavern.getContext().saveChat();
                        upsertReceiptItem('cnz-receipt-anchor', receiptSuccess('DNA anchor updated'));
                    } catch (saveErr) {
                        console.error('[CNZ] onConfirmClick: saveChat failed:', saveErr);
                        upsertReceiptItem('cnz-receipt-anchor', receiptFailure(`DNA anchor save failed: ${saveErr.message} (content saved)`));
                    }
                }
            }
        } catch (err) {
            console.error('[CNZ] DNA anchor update failed:', err);
            upsertReceiptItem('cnz-receipt-anchor', receiptFailure(`DNA anchor update failed: ${err.message} (content saved)`));
            // Non-fatal
        }
    }

    // Reset session guard so the next openReviewModal starts fresh from the
    // newly-committed anchor state rather than reusing this now-stale draft.
    state._modalOpenHeadUuid = null;
    import('./orchestrator.js').then(({ closeModal }) => closeModal());
}
