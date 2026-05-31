/**
 * @file data/default-user/extensions/canonize/modal/orchestrator.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 2.0.0
 * @architectural-role Orchestrator
 * @description
 * Review wizard lifecycle: show, hide, step transitions, UI reset, and the
 * openReviewModal hydration sequence that loads lorebook, DNA chain, and RAG
 * state before showing Step 1. Drives the four-step wizard but owns none of
 * the per-step workshop logic.
 *
 * Event wiring lives in modal-setup.js. Tool modals (DNA Inspector, Orphan
 * Review) live in dna-inspector.js and orphan-modal.js.
 *
 * @api-declaration
 * showModal, closeModal, initWizardSession, updateWizard, openReviewModal
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._currentStep, state._hooksLoading, state._lorebookLoading,
 *                       state._lbActiveIngesterIndex, state._lbPendingWrite,
 *                       state._ragRawDetached, state._modalOpenHeadUuid,
 *                       state._lorebookData, state._draftLorebook, state._lorebookName,
 *                       state._lorebookSuggestions, state._parentNodeLorebook,
 *                       state._beforeSituation, state._priorSituation,
 *                       state._ragChunks, state._stagedProsePairs,
 *                       state._stagedPairOffset, state._splitPairIdx, state._dnaChain]
 *     external_io: [DOM, toastr, /api/worldinfo/*, /api/chats/saveChat]
 */

import { emit, BUS_EVENTS } from '../bus.js';
import { setDnaChain } from '../scheduler.js';
import { invalidateAllJobs } from '../cycleStore.js';
import { error } from '../log.js';
import { state, CNZ_SUMMARY_ID } from '../state.js';
import { getSettings } from '../core/settings.js';
import { readDnaChain } from '../core/dna-chain.js';
import { getCnzPromptManager } from '../core/summary-prompt.js';
import { buildProsePairs, deriveLastCommittedPairs } from '../core/transcript.js';
import { buildRagChunks } from '../rag/pipeline.js';
import { cnzDefaultLbName, cnzPlotLbName } from '../rag/api.js';
import { lbEnsureLorebook } from '../lorebook/api.js';
import { deriveSuggestionsFromAnchorDiff, serialiseSuggestionsToFreeform } from '../lorebook/utils.js';
import { patchCharacterWorld } from './commit.js';
import { updateHooksDiff } from './hooks-workshop.js';
import { populateLbIngesterDropdown, renderLbIngesterDetail, populateTargetedEntrySelect } from './lb-workshop.js';
import { setHooksLoading } from './hooks-workshop.js';
import { setLbLoading } from './lb-workshop.js';
import { populatePlotLbDropdown, populatePlotLbFullEntrySelect, syncPlotLbFreeform } from './plot-lb-workshop.js';

// ─── Show / Hide ──────────────────────────────────────────────────────────────

export function showModal() {
    $('#cnz-overlay').removeClass('cnz-hidden');
}

/**
 * Hides the modal overlay and resets modal session state.
 * Must NOT clear engine state (ragChunks, lorebookSuggestions, priorSituation).
 */
export function closeModal() {
    $('#cnz-overlay').addClass('cnz-hidden');
    invalidateAllJobs();
    state._hooksLoading               = false;
    state._lorebookLoading            = false;
    state._lbActiveIngesterIndex      = 0;
    state._lbPendingWrite             = null;
    state._plotLbActiveIngesterIndex  = 0;
    state._plotLbPendingWrite         = null;
    state._plotLorebookSuggestions    = [];
    state._ragRawDetached             = false;
    state._currentStep                = 1;
    state._modalOpenHeadUuid          = null;
    state._hooksRegenGen              = 0;
    state._lbRegenGen                 = 0;
}

// ─── Wizard UI Reset ──────────────────────────────────────────────────────────

/**
 * Resets wizard UI to its initial state without touching engine state.
 * Pass `preserveSuggestions = true` from openReviewModal to retain lorebook
 * suggestions populated by the last sync.
 * @param {boolean} [preserveSuggestions=false]
 */
export function initWizardSession(preserveSuggestions = false) {
    $('#cnz-hooks-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'workshop');
    });
    $('#cnz-hooks-tab-workshop').removeClass('cnz-hidden');
    $('#cnz-hooks-tab-new, #cnz-hooks-tab-old').addClass('cnz-hidden');
    $('#cnz-hooks-diff').empty();
    $('#cnz-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'ingester');
    });
    $('#cnz-lb-tab-ingester').removeClass('cnz-hidden');
    $('#cnz-lb-tab-freeform').addClass('cnz-hidden');
    $('#cnz-targeted-entry-select').empty().append('<option value="">— Select entry —</option>');
    $('#cnz-targeted-keyword').val('');
    $('#cnz-targeted-spinner').addClass('cnz-hidden');
    $('#cnz-targeted-error').addClass('cnz-hidden').text('');
    $('#cnz-targeted-generate').prop('disabled', false);
    populateTargetedEntrySelect();
    $('#cnz-lb-title').text(`Lorebook: ${state._lorebookName}`);
    $('#cnz-lb-freeform').val('');
    $('#cnz-lb-error').addClass('cnz-hidden').text('');
    $('#cnz-lb-error-ingester').addClass('cnz-hidden').text('');
    $('#cnz-error-1').addClass('cnz-hidden').text('');
    $('#cnz-error-4').addClass('cnz-hidden').text('');
    $('#cnz-receipts').addClass('cnz-hidden');
    $('#cnz-receipts-content').empty();
    $('#cnz-recovery-guide').addClass('cnz-hidden');
    $('#cnz-cancel').text('Cancel').prop('disabled', false);
    $('#cnz-confirm').prop('disabled', false);
    $('#cnz-rag-cards').empty();
    $('#cnz-rag-no-summary, #cnz-rag-disabled').addClass('cnz-hidden');
    $('#cnz-rag-detached-warn, #cnz-rag-detached-revert').addClass('cnz-hidden');
    $('#cnz-rag-raw').val('').removeClass('cnz-rag-detached');
    $('#cnz-rag-raw-detached-label').addClass('cnz-hidden');
    $('#cnz-rag-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'sectioned');
    });
    $('#cnz-rag-tab-sectioned').removeClass('cnz-hidden');
    $('#cnz-rag-tab-raw').addClass('cnz-hidden');
    // Plot LB reset
    $('#cnz-plot-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'entries');
    });
    $('#cnz-plot-lb-tab-entries').removeClass('cnz-hidden');
    $('#cnz-plot-lb-tab-freeform').addClass('cnz-hidden');
    $('#cnz-plot-lb-freeform').val('');
    $('#cnz-plot-lb-error').addClass('cnz-hidden').text('');

    if (!preserveSuggestions) {
        state._lbActiveIngesterIndex      = 0;
        state._plotLbActiveIngesterIndex  = 0;
    }
    setHooksLoading(false);
    setLbLoading(false);
}

// ─── Step Navigation ──────────────────────────────────────────────────────────

/**
 * Shows the given wizard step (1–4), hides all others, and updates footer
 * button visibility. Triggers workshop population on step entry.
 */
export function updateWizard(n) {
    import('./rag-workshop.js').then(({ onLeaveRagWorkshop, onEnterRagWorkshop }) => {
        if (state._currentStep === 4 && n < 4) onLeaveRagWorkshop();
        state._currentStep = n;
        for (let i = 1; i <= 5; i++) {
            $(`#cnz-step-${i}`).toggleClass('cnz-hidden', i !== n);
        }
        $('#cnz-move-back').toggleClass('cnz-hidden', n === 1);
        $('#cnz-move-next').toggleClass('cnz-hidden', n === 5);
        $('#cnz-confirm').toggleClass('cnz-hidden',   n !== 5);
        if (n === 2) {
            populatePlotLbDropdown();
            populatePlotLbFullEntrySelect();
            syncPlotLbFreeform();
            $('#cnz-plot-lb-title').text(`Plot Lorebook: ${state._plotLorebookName ?? ''}`);
        }
        if (n === 4) onEnterRagWorkshop();
        if (n === 5) {
            import('./commit-ui.js').then(({ populateStep4Summary }) => populateStep4Summary());
        }
    });
}

// ─── Open ─────────────────────────────────────────────────────────────────────

/**
 * Hydrates modal state from the current DNA chain and lorebook, then shows Step 1.
 * Called from the sync toast "Review" link and from the wand button.
 */
export async function openReviewModal() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const lbName = state._lorebookName || cnzDefaultLbName(char.avatar);
    if (state._lorebookName !== lbName || !state._lorebookData) {
        try {
            state._lorebookName  = lbName;
            state._lorebookData  = await lbEnsureLorebook(state._lorebookName);
            state._draftLorebook = structuredClone(state._lorebookData);
        } catch (err) {
            error('Modal', 'openReviewModal: lorebook load failed:', err);
            state._lorebookData  = { entries: {} };
            state._draftLorebook = { entries: {} };
        }
    }

    // Load plot lorebook
    const plotLbName = state._plotLorebookName || cnzPlotLbName(char.avatar);
    state._plotLorebookName = plotLbName;
    try {
        state._plotLorebookData  = await lbEnsureLorebook(plotLbName);
        state._draftPlotLorebook = structuredClone(state._plotLorebookData);
    } catch (err) {
        error('Modal', 'openReviewModal: plot lorebook load failed:', err);
        state._plotLorebookData  = { entries: {} };
        state._draftPlotLorebook = { entries: {} };
    }

    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    const headRef   = state._dnaChain.lkg ? { anchor: state._dnaChain.lkg, msgIdx: state._dnaChain.lkgMsgIdx } : null;
    const parentRef = headRef ? (state._dnaChain.anchors[state._dnaChain.anchors.length - 2] ?? null) : null;

    // Suggestions = entries written by the last hookseeker sync, stored in the head anchor
    state._plotLorebookSuggestions = (headRef?.anchor?.plotEntries ?? []).map(e => ({
        uid:    e.uid,
        name:   e.comment ?? String(e.uid),
        status: 'pending',
    }));

    const isSameSession = !!headRef && state._modalOpenHeadUuid === headRef.anchor.uuid && !!state._draftLorebook;

    if (!isSameSession) {
        const _pm        = getCnzPromptManager();
        const _cnzPrompt = _pm?.getPromptById(CNZ_SUMMARY_ID);
        state._priorSituation = (_cnzPrompt && _cnzPrompt.cnz_avatar === char.avatar)
            ? (_cnzPrompt.cnz_scene ?? _cnzPrompt.content ?? '')
            : '';
    }

    if (headRef) {
        state._lorebookData = structuredClone(headRef.anchor.lorebook ?? { entries: {} });
        if (!isSameSession) state._draftLorebook = structuredClone(state._lorebookData);
        state._lorebookName = headRef.anchor.lorebook?.name || state._lorebookName;

        if (state._ragChunks.length === 0 && state._stagedProsePairs.length === 0) {
            const messages  = SillyTavern.getContext().chat ?? [];
            const allPairs  = buildProsePairs(messages);
            const { pairs, pairOffset } = deriveLastCommittedPairs(allPairs, messages, state._dnaChain);
            if (pairs.length > 0) {
                state._stagedProsePairs = pairs;
                state._stagedPairOffset = pairOffset;
                state._splitPairIdx     = pairs.length;
                state._ragChunks        = buildRagChunks(pairs, pairOffset, getSettings());
                const headerMap = new Map((headRef.anchor.ragHeaders ?? []).map(h => [h.chunkIndex, h]));
                for (const chunk of state._ragChunks) {
                    const stored = headerMap.get(chunk.chunkIndex);
                    if (stored?.header) {
                        chunk.header = stored.header;
                        chunk.status = 'complete';
                    }
                }
            }
        }
    }

    if (parentRef) {
        state._beforeSituation    = parentRef.anchor.hooks ?? '';
        state._parentNodeLorebook = parentRef.anchor.lorebook ?? null;
    } else {
        state._beforeSituation    = '';
        state._parentNodeLorebook = null;
    }

    if (!isSameSession) state._lorebookSuggestions = headRef
        ? deriveSuggestionsFromAnchorDiff(state._parentNodeLorebook, state._draftLorebook) : [];
    state._modalOpenHeadUuid = headRef?.anchor?.uuid ?? null;

    const freshChar   = ctx?.characters?.[ctx?.characterId];
    const charForLink = freshChar ?? char;
    if (state._lorebookName && charForLink?.data?.extensions?.world !== state._lorebookName) {
        patchCharacterWorld(charForLink, state._lorebookName).catch(e =>
            error('Modal', 'openReviewModal: lorebook link failed:', e.message ?? e),
        );
    }

    initWizardSession(true);

    $('#cnz-situation-text').val(state._priorSituation);
    $('#cnz-hooks-new-display').text(state._priorSituation);
    $('#cnz-hooks-old-display').text(state._beforeSituation);
    updateHooksDiff();
    $('#cnz-lb-freeform').val(serialiseSuggestionsToFreeform(state._lorebookSuggestions, state._draftLorebook));
    if (state._lorebookSuggestions.length) {
        populateLbIngesterDropdown();
        renderLbIngesterDetail(state._lorebookSuggestions[0]);
    }

    showModal();
    updateWizard(1);
    emit(BUS_EVENTS.MODAL_OPENED, {});
}
