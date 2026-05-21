/**
 * @file data/default-user/extensions/canonize/modal/modal-setup.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * DOM injection and event delegation for the CNZ review wizard. Appends all
 * modal HTML to the page and binds every wizard UI interaction to its handler.
 * Contains no orchestration logic and no narrative state — it wires events
 * to handlers that live in the workshop modules.
 *
 * @api-declaration
 * injectModal()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM, jQuery event delegation]
 */

import {
    buildModalHTML, buildPromptModalHTML, buildDnaChainInspectorHTML, buildOrphanModalHTML,
} from '../ui.js';
import { state } from '../state.js';
import {
    onHooksTabSwitch, updateHooksDiff,
} from './hooks-workshop.js';
import {
    onRagTabSwitch, autoResizeRagCardHeader, onRagRawInput, onRagRevertRaw,
    ragRegenCard as _ragRegenCard,
} from './rag-workshop.js';
import {
    onLbTabSwitch, populateLbIngesterDropdown, renderLbIngesterDetail,
    populateTargetedEntrySelect, onLbSuggestionSelectChange,
    onLbIngesterEditorInput, onLbIngesterNext, onLbIngesterLoadLatest,
    onLbIngesterLoadPrev, onLbIngesterRegenerate, onLbIngesterReject,
    onLbIngesterApply, onLbApplyAllUnresolved, onTargetedGenerateClick,
    onLbRegenClick, flushLbEditorToDraft,
} from './lb-workshop.js';
import { onConfirmClick } from './commit.js';
import { deleteLbEntry, syncFreeformFromSuggestions } from '../lorebook/utils.js';

/**
 * Appends all CNZ modal HTML to the page and binds event handlers.
 * Called once at extension init. No-ops if already injected.
 */
export function injectModal() {
    if ($('#cnz-overlay').length) return;
    $('body').append(buildModalHTML());
    $('body').append(buildPromptModalHTML());
    $('body').append(buildDnaChainInspectorHTML());
    $('body').append(buildOrphanModalHTML());

    $('#cnz-modal, #cnz-pm-modal, #cnz-li-modal, #cnz-orphan-modal').on('mousedown click', (e) => {
        e.stopPropagation();
    });

    // Step 1 — Hooks Workshop
    $('#cnz-modal').on('click', '#cnz-hooks-tab-bar .cnz-tab-btn', function () {
        onHooksTabSwitch($(this).data('tab'));
    });
    $('#cnz-modal').on('input', '#cnz-situation-text', updateHooksDiff);
    $('#cnz-hooks-revert-old').on('click', () => {
        $('#cnz-situation-text').val(state._beforeSituation);
        updateHooksDiff();
    });
    $('#cnz-hooks-revert-new').on('click', () => {
        $('#cnz-situation-text').val(state._priorSituation);
        updateHooksDiff();
    });
    $('#cnz-regen-hooks').on('click', function () {
        import('./hooks-workshop.js').then(({ onRegenHooksClick }) => onRegenHooksClick());
    });

    // Step 2 — Lorebook Workshop
    $('#cnz-lb-freeform-regen').on('click',       onLbRegenClick);
    $('#cnz-lb-suggestion-select').on('change',   onLbSuggestionSelectChange);
    $('#cnz-lb-editor-name').on('input',          onLbIngesterEditorInput);
    $('#cnz-lb-editor-keys').on('input',          onLbIngesterEditorInput);
    $('#cnz-lb-editor-content').on('input',       onLbIngesterEditorInput);
    $('#cnz-lb-editor-name, #cnz-lb-editor-keys, #cnz-lb-editor-content').on('blur', flushLbEditorToDraft);
    $('#cnz-lb-ingester-next').on('click',        onLbIngesterNext);
    $('#cnz-lb-btn-latest').on('click',           onLbIngesterLoadLatest);
    $('#cnz-lb-btn-prev').on('click',             onLbIngesterLoadPrev);
    $('#cnz-lb-btn-regen').on('click',            onLbIngesterRegenerate);
    $('#cnz-lb-reject-one').on('click',           onLbIngesterReject);
    $('#cnz-lb-apply-one').on('click',            onLbIngesterApply);
    $('#cnz-lb-delete-one').on('click',           () => deleteLbEntry(state._lbActiveIngesterIndex));
    $('#cnz-lb-apply-all-unresolved').on('click', onLbApplyAllUnresolved);
    $('#cnz-modal').on('click', '#cnz-lb-tab-bar .cnz-tab-btn', function () {
        onLbTabSwitch($(this).data('tab'));
    });
    $('#cnz-modal').on('change', '#cnz-targeted-entry-select', function () {
        const uid = $(this).val();
        if (!uid) return;
        const entry = state._draftLorebook?.entries?.[uid];
        if (!entry) return;
        const uidNum      = parseInt(uid, 10);
        const existingIdx = state._lorebookSuggestions.findIndex(s => s.linkedUid === uidNum);
        if (existingIdx !== -1) {
            state._lbActiveIngesterIndex = existingIdx;
            $('#cnz-lb-suggestion-select').val(existingIdx);
            renderLbIngesterDetail(state._lorebookSuggestions[existingIdx]);
        } else {
            const name    = entry.comment || String(entry.uid ?? uid);
            const keys    = Array.isArray(entry.key) ? [...entry.key] : [];
            const content = entry.content ?? '';
            const newSuggestion = {
                type:        'UPDATE',
                name,
                linkedUid:   uidNum,
                status:      'applied',
                _aiSnapshot: { name, keys: [...keys], content },
            };
            state._lorebookSuggestions.push(newSuggestion);
            state._lbActiveIngesterIndex = state._lorebookSuggestions.length - 1;
            populateLbIngesterDropdown();
            renderLbIngesterDetail(newSuggestion);
            syncFreeformFromSuggestions();
        }
    });
    $('#cnz-modal').on('click', '#cnz-targeted-generate', onTargetedGenerateClick);

    // Step 3 — Narrative Memory Workshop
    $('#cnz-modal').on('click', '#cnz-rag-tab-bar .cnz-tab-btn', function () {
        onRagTabSwitch($(this).data('tab'));
    });
    $('#cnz-modal').on('input', '.cnz-rag-card-header', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        autoResizeRagCardHeader(this);
        if (!isNaN(idx) && state._ragChunks[idx]) {
            state._ragChunks[idx].header = $(this).val();
            state._ragChunks[idx].status = 'manual';
            $(`.cnz-rag-card[data-chunk-index="${idx}"]`).attr('data-status', 'manual');
        }
    });
    $('#cnz-modal').on('click', '.cnz-rag-card-regen', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        if (!isNaN(idx)) _ragRegenCard(idx);
    });
    $('#cnz-rag-raw').on('input', onRagRawInput);
    $('#cnz-rag-revert-raw-btn').on('click', onRagRevertRaw);

    // Shared wizard footer
    $('#cnz-cancel').on('click', () => import('./orchestrator.js').then(({ closeModal }) => closeModal()));
    $('#cnz-move-back').on('click', () => import('./orchestrator.js').then(({ updateWizard }) => updateWizard(state._currentStep - 1)));
    $('#cnz-move-next').on('click', () => import('./orchestrator.js').then(({ updateWizard }) => updateWizard(state._currentStep + 1)));
    $('#cnz-confirm').on('click', onConfirmClick);
}
