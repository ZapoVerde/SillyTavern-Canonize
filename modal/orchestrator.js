/**
 * @file data/default-user/extensions/canonize/modal/orchestrator.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.17
 * @architectural-role UI Builder
 * @description
 * Owns the four-step review wizard lifecycle: injectModal (DOM construction and
 * event delegation), openReviewModal (lorebook/chain hydration, panel population,
 * show), updateWizard (step transitions), closeModal (UI-only reset), and the
 * DNA Chain Inspector and Orphan Review modals.
 *
 * @api-declaration
 * injectModal, openReviewModal, updateWizard, closeModal, showModal,
 * openDnaChainInspector, openOrphanModal, initWizardSession
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._currentStep, state._lorebookLoading, state._hooksLoading,
 *                       state._lbActiveIngesterIndex, state._lbPendingWrite,
 *                       state._ragRawDetached, state._modalOpenHeadUuid,
 *                       state._lorebookData, state._draftLorebook, state._lorebookName,
 *                       state._lorebookSuggestions, state._parentNodeLorebook,
 *                       state._beforeSituation, state._priorSituation,
 *                       state._ragChunks, state._stagedProsePairs,
 *                       state._stagedPairOffset, state._splitPairIdx, state._dnaChain]
 *     external_io: [/api/worldinfo/*, /api/files/verify, /api/chats/saveChat]
 */

import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import {
    buildModalHTML, buildPromptModalHTML, buildDnaChainInspectorHTML, buildOrphanModalHTML,
} from '../ui.js';
import { emit, BUS_EVENTS } from '../bus.js';
import { setDnaChain } from '../scheduler.js';
import { invalidateAllJobs } from '../cycleStore.js';
import { state, escapeHtml } from '../state.js';
import { getSettings } from '../core/settings.js';
import { readDnaChain } from '../core/dna-chain.js';
import { getCnzPromptManager } from '../core/summary-prompt.js';
import { buildProsePairs } from '../core/transcript.js';
import { buildRagChunks } from '../rag/pipeline.js';
import { lbEnsureLorebook } from '../lorebook/api.js';
import { deriveSuggestionsFromAnchorDiff, serialiseSuggestionsToFreeform } from '../lorebook/utils.js';
import { patchCharacterWorld } from './commit.js';
import { CNZ_SUMMARY_ID } from '../state.js';
import { cnzDeleteFile } from '../rag/api.js';
import {
    onHooksTabSwitch, updateHooksDiff, setHooksLoading,
} from './hooks-workshop.js';
import {
    onRagTabSwitch, renderRagCards, autoResizeRagCardHeader,
} from './rag-workshop.js';
import {
    onLbTabSwitch, populateLbIngesterDropdown, renderLbIngesterDetail,
    populateTargetedEntrySelect, onLbSuggestionSelectChange,
    onLbIngesterEditorInput, onLbIngesterNext, onLbIngesterLoadLatest,
    onLbIngesterLoadPrev, onLbIngesterRegenerate, onLbIngesterReject,
    onLbIngesterApply, onLbApplyAllUnresolved, onTargetedGenerateClick,
    onLbRegenClick, setLbLoading, flushLbEditorToDraft,
} from './lb-workshop.js';
import { onConfirmClick } from './commit.js';
import { deleteLbEntry } from '../lorebook/utils.js';
import { syncFreeformFromSuggestions } from '../lorebook/utils.js';
import { onRagRawInput, onRagRevertRaw, ragRegenCard as _ragRegenCard } from './rag-workshop.js';

// ─── Modal: Orchestration ─────────────────────────────────────────────────────

export function injectModal() {
    if ($('#cnz-overlay').length) return;
    $('body').append(buildModalHTML());
    $('body').append(buildPromptModalHTML());
    $('body').append(buildDnaChainInspectorHTML());
    $('body').append(buildOrphanModalHTML());

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
    // Flush captured keystroke values to _draftLorebook as soon as focus leaves the field.
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
    // Lane 3 — selecting an existing lorebook entry loads it into the shared editor.
    $('#cnz-modal').on('change', '#cnz-targeted-entry-select', function () {
        const uid = $(this).val();
        if (!uid) return;

        const entry = state._draftLorebook?.entries?.[uid];
        if (!entry) return;

        const uidNum      = parseInt(uid, 10);
        const existingIdx = state._lorebookSuggestions.findIndex(s => s.linkedUid === uidNum);

        if (existingIdx !== -1) {
            // Entry already tracked in Lane 1 — sync the dropdowns
            state._lbActiveIngesterIndex = existingIdx;
            $('#cnz-lb-suggestion-select').val(existingIdx);
            renderLbIngesterDetail(state._lorebookSuggestions[existingIdx]);
        } else {
            // Not yet tracked — add it as an UPDATE suggestion
            const name    = entry.comment || String(entry.uid ?? uid);
            const keys    = Array.isArray(entry.key) ? [...entry.key] : [];
            const content = entry.content ?? '';
            // Content lives in _draftLorebook; suggestion carries only label + snapshot.
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
    $('#cnz-cancel').on('click',    closeModal);
    $('#cnz-move-back').on('click', () => updateWizard(state._currentStep - 1));
    $('#cnz-move-next').on('click', () => updateWizard(state._currentStep + 1));
    $('#cnz-confirm').on('click',   onConfirmClick);
}

export function showModal() {
    $('#cnz-overlay').removeClass('cnz-hidden');
}

/**
 * Hides the modal overlay and resets modal session state.
 * Must NOT clear engine state (`state._ragChunks`, `state._lorebookSuggestions`, `state._priorSituation`, etc.).
 */
export function closeModal() {
    $('#cnz-overlay').addClass('cnz-hidden');
    invalidateAllJobs();   // invalidates all in-flight bus jobs (genId replacement)
    // Reset modal UI state only (engine state must not be cleared here)
    state._hooksLoading               = false;
    state._lorebookLoading            = false;
    state._lbActiveIngesterIndex      = 0;
    state._lbPendingWrite             = null;
    state._ragRawDetached             = false;
    state._currentStep                = 1;
    state._modalOpenHeadUuid          = null;
    state._hooksRegenGen              = 0;
    state._lbRegenGen                 = 0;
}

/**
 * Resets wizard UI to its initial state (tab selection, error panels, loading spinners).
 * Must NOT touch engine state. Pass `preserveSuggestions = true` from `openReviewModal`
 * to retain lorebook suggestions and raw text populated by the last sync.
 * @param {boolean} [preserveSuggestions=false]
 */
export function initWizardSession(preserveSuggestions = false) {
    // Hooks Workshop reset
    $('#cnz-hooks-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'workshop');
    });
    $('#cnz-hooks-tab-workshop').removeClass('cnz-hidden');
    $('#cnz-hooks-tab-new, #cnz-hooks-tab-old').addClass('cnz-hidden');
    $('#cnz-hooks-diff').empty();
    // Lorebook tab reset — Ingester is the default landing tab
    $('#cnz-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'ingester');
    });
    $('#cnz-lb-tab-ingester').removeClass('cnz-hidden');
    $('#cnz-lb-tab-freeform').addClass('cnz-hidden');
    // Lane 2/3 reset
    $('#cnz-targeted-entry-select').empty().append('<option value="">— Select entry —</option>');
    $('#cnz-targeted-keyword').val('');
    $('#cnz-targeted-spinner').addClass('cnz-hidden');
    $('#cnz-targeted-error').addClass('cnz-hidden').text('');
    $('#cnz-targeted-generate').prop('disabled', false);
    populateTargetedEntrySelect();
    // Lorebook and general reset
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
    // RAG Workshop reset
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
    // Lorebook ingester reset (engine state state._lorebookSuggestions must NOT be cleared here)
    if (!preserveSuggestions) {
        state._lbActiveIngesterIndex = 0;
    }
    setHooksLoading(false);
    setLbLoading(false);
}

/**
 * Shows the given wizard step (1–4), hides all others, and updates footer
 * button visibility. Triggers workshop population on step entry.
 */
export function updateWizard(n) {
    import('./rag-workshop.js').then(({ onLeaveRagWorkshop, onEnterRagWorkshop }) => {
        if (state._currentStep === 3 && n < 3) onLeaveRagWorkshop();
        state._currentStep = n;
        for (let i = 1; i <= 4; i++) {
            $(`#cnz-step-${i}`).toggleClass('cnz-hidden', i !== n);
        }
        $('#cnz-move-back').toggleClass('cnz-hidden', n === 1);
        $('#cnz-move-next').toggleClass('cnz-hidden', n === 4);
        $('#cnz-confirm').toggleClass('cnz-hidden',   n !== 4);
        if (n === 3) onEnterRagWorkshop();
        if (n === 4) {
            import('./commit.js').then(({ populateStep4Summary }) => populateStep4Summary());
        }
    });
}

/**
 * Opens the CNZ review modal. Loads committed hooks from character scenario,
 * ensures lorebook and DNA chain are loaded, then shows Step 1.
 * Called from the sync toast "Review" link.
 */
export async function openReviewModal() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    // Ensure lorebook is loaded
    const lbName = getSettings().lorebookName || char.name;
    if (state._lorebookName !== lbName || !state._lorebookData) {
        try {
            state._lorebookName  = lbName;
            state._lorebookData  = await lbEnsureLorebook(state._lorebookName);
            state._draftLorebook = structuredClone(state._lorebookData);
        } catch (err) {
            console.error('[CNZ] openReviewModal: lorebook load failed:', err);
            state._lorebookData  = { entries: {} };
            state._draftLorebook = { entries: {} };
        }
    }

    // Derive before/after states from DNA chain — no network fetches needed.
    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    const headRef   = state._dnaChain.lkg ? { anchor: state._dnaChain.lkg, msgIdx: state._dnaChain.lkgMsgIdx } : null;
    const parentRef = headRef ? (state._dnaChain.anchors[state._dnaChain.anchors.length - 2] ?? null) : null;

    // True when the user is reopening the modal within the same sync cycle — the
    // anchor UUID matches the one captured at the last open, meaning no new sync has
    // committed since. In this case we preserve _draftLorebook, _lorebookSuggestions,
    // and _priorSituation (including any regen result) so edits survive modal close/reopen.
    const isSameSession = !!headRef && state._modalOpenHeadUuid === headRef.anchor.uuid && !!state._draftLorebook;

    // Read current hooks from the CNZ Summary prompt (source of truth after a sync).
    // Skipped on same-session reopen so an in-modal regen is not clobbered.
    if (!isSameSession) {
        const _pm        = getCnzPromptManager();
        const _cnzPrompt = _pm?.getPromptById(CNZ_SUMMARY_ID);
        state._priorSituation = (_cnzPrompt && _cnzPrompt.cnz_avatar === char.avatar)
            ? (_cnzPrompt.content ?? '')
            : '';
    }

    if (headRef) {
        state._lorebookData  = structuredClone(headRef.anchor.lorebook ?? { entries: {} });
        if (!isSameSession) state._draftLorebook = structuredClone(state._lorebookData);
        state._lorebookName  = headRef.anchor.lorebook?.name || state._lorebookName;

        // Restore RAG state from the last committed anchor when no sync has run this session.
        if (state._ragChunks.length === 0 && state._stagedProsePairs.length === 0) {
            const messages  = SillyTavern.getContext().chat ?? [];
            const allPairs  = buildProsePairs(messages);
            const { pairs, pairOffset } = deriveLastCommittedPairs(allPairs, messages, state._dnaChain);
            if (pairs.length > 0) {
                state._stagedProsePairs = pairs;
                state._stagedPairOffset = pairOffset;
                state._splitPairIdx     = pairs.length;
                state._ragChunks        = buildRagChunks(pairs, pairOffset, getSettings());

                // Apply stored headers — chunks not present in the anchor stay 'pending' for auto-regen.
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

    if (!isSameSession) state._lorebookSuggestions = headRef ? deriveSuggestionsFromAnchorDiff(state._parentNodeLorebook, state._draftLorebook) : [];
    state._modalOpenHeadUuid = headRef?.anchor?.uuid ?? null;

    // Link lorebook to character if not already set.
    const freshChar = ctx?.characters?.[ctx?.characterId];
    const charForLink = freshChar ?? char;
    if (state._lorebookName && charForLink?.data?.extensions?.world !== state._lorebookName) {
        patchCharacterWorld(charForLink, state._lorebookName).catch(e =>
            console.error('[CNZ] openReviewModal: lorebook link failed:', e.message ?? e),
        );
    }

    initWizardSession(true);

    // Populate panels before showModal()
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

// ─── Derive Last Committed Pairs (pure helper) ────────────────────────────────

/**
 * Derives the prose-pair slice that was committed in the most recent sync cycle.
 * Pure function — no module state reads.
 */
function deriveLastCommittedPairs(allPairs, messages, dnaChain) {
    const anchors = dnaChain?.anchors ?? [];
    if (anchors.length === 0) return { pairs: [], pairOffset: 0 };

    const headRef   = anchors[anchors.length - 1];
    const parentRef = anchors.length >= 2 ? anchors[anchors.length - 2] : null;

    const headPriorSeq   = messages.slice(0, headRef.msgIdx + 1).filter(m => !m.is_system).length;
    const parentPriorSeq = parentRef
        ? messages.slice(0, parentRef.msgIdx + 1).filter(m => !m.is_system).length
        : 0;

    const pairs      = allPairs.filter(p => p.validIdx >= parentPriorSeq && p.validIdx < headPriorSeq);
    const pairOffset = pairs.length > 0 ? allPairs.indexOf(pairs[0]) : 0;

    return { pairs, pairOffset };
}

// ─── DNA Chain Inspector ───────────────────────────────────────────────────────

function closeDnaChainInspector() {
    $('#cnz-li-overlay').addClass('cnz-hidden');
}

/**
 * Opens the DNA Chain Inspector modal for the current character.
 */
export async function openDnaChainInspector() {
    const ctx      = SillyTavern.getContext();
    const char     = ctx?.characters?.[ctx?.characterId];
    const messages = ctx?.chat ?? [];
    const chain    = readDnaChain(messages);

    const $overlay = $('#cnz-li-overlay');
    const $title   = $('#cnz-li-title');
    const $body    = $('#cnz-li-body');

    $title.text(`DNA Chain — ${char?.name ?? 'Unknown'}`);
    $body.empty();

    // Wire close handlers
    $('#cnz-li-close').off('click.li').on('click.li', closeDnaChainInspector);
    $overlay.off('click.li').on('click.li', closeDnaChainInspector);
    $('#cnz-li-modal').off('click.li').on('click.li', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');

    // ── Section 1: Uncommitted pairs ──────────────────────────────────────────
    const afterAnchor = chain.lkgMsgIdx >= 0 ? messages.slice(chain.lkgMsgIdx + 1) : messages;
    const uncommitted = afterAnchor.filter(m => !m.is_system && m.is_user).length;
    const pairWord    = uncommitted === 1 ? 'pair' : 'pairs';
    $body.append(`<div class="cnz-li-summary">${uncommitted} uncommitted ${pairWord} since last update</div>`);

    // ── Section 2: RAG coverage map ───────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">Narrative Memory</div>');

    const verifiedOnDisk = new Set();

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-rag-row"><span class="cnz-li-rag-name cnz-li-status-muted">No syncs committed yet.</span></div>');
    } else {
        const attachments = extension_settings.character_attachments?.[char?.avatar] ?? [];
        const anchorUrls  = chain.anchors.map(({ anchor }) => anchor.ragUrl).filter(Boolean);
        const allUrls     = [...new Set([...anchorUrls, ...attachments.map(a => a.url)])];

        if (allUrls.length > 0) {
            try {
                const res = await fetch('/api/files/verify', {
                    method:  'POST',
                    headers: getRequestHeaders(),
                    body:    JSON.stringify({ urls: allUrls }),
                });
                if (res.ok) {
                    const verified = await res.json();
                    for (const [url, exists] of Object.entries(verified)) {
                        if (exists) verifiedOnDisk.add(url);
                    }
                }
            } catch (err) {
                console.warn('[CNZ] openDnaChainInspector: RAG verify failed:', err);
            }
        }

        const total         = chain.anchors.length;
        const firstSeenLabel = new Map();

        for (let i = 0; i < chain.anchors.length; i++) {
            const { anchor }  = chain.anchors[i];
            const label       = i === total - 1 ? 'HEAD' : `#${i + 1}`;
            const shortUuid   = anchor.uuid?.slice(0, 8) ?? '—';
            const labelText   = `${label}  ${shortUuid}`;

            let statusCls, statusChr, nameHtml;
            if (!anchor.ragUrl) {
                statusCls = 'cnz-li-status-warn';
                statusChr = '⚠';
                nameHtml  = '<span class="cnz-li-rag-name cnz-li-status-muted">no file</span>';
            } else {
                const onDisk = verifiedOnDisk.has(anchor.ragUrl);
                statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                statusChr = onDisk ? '✓' : '✗';
                if (firstSeenLabel.has(anchor.ragUrl)) {
                    const ref = escapeHtml(firstSeenLabel.get(anchor.ragUrl));
                    nameHtml = `<span class="cnz-li-rag-name cnz-li-status-muted">(same as ${ref})</span>`;
                } else {
                    firstSeenLabel.set(anchor.ragUrl, label);
                    const fileName = escapeHtml(anchor.ragUrl.split('/').pop());
                    nameHtml = `<span class="cnz-li-rag-name">${fileName}</span>`;
                }
            }

            $body.append(`<div class="cnz-li-rag-row">
                <span class="cnz-li-rag-label">${escapeHtml(labelText)}</span>
                <span class="cnz-li-rag-status ${statusCls}">${statusChr}</span>
                ${nameHtml}
            </div>`);
        }
    }

    // ── Section 3: Anchor list ────────────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">Sync History</div>');

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-empty">No syncs committed yet.</div>');
        return;
    }

    const total   = chain.anchors.length;
    const reversed = [...chain.anchors].reverse();

    for (let i = 0; i < reversed.length; i++) {
        const { anchor } = reversed[i];
        const label     = i === 0 ? 'HEAD' : `#${total - i}`;
        const shortUuid = anchor.uuid?.slice(0, 8) ?? '—';
        const entries   = Object.keys(anchor.lorebook?.entries ?? {}).length;
        const chunks    = anchor.ragHeaders?.length ?? 0;
        const dateStr   = anchor.committedAt ? anchor.committedAt.slice(0, 16).replace('T', ' ') : '—';
        const summary   = `${label}  ${shortUuid}  ${entries} ${entries === 1 ? 'entry' : 'entries'}  ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'}  ${dateStr}`;

        const $row      = $('<div class="cnz-li-node-row"></div>');
        const $head     = $(`<div class="cnz-li-node-header">
            <span class="cnz-li-chevron">▶</span>
            <span class="cnz-li-node-label">${escapeHtml(summary)}</span>
        </div>`);
        const $nodeBody = $('<div class="cnz-li-node-body"></div>');
        let loaded      = false;

        $head.on('click', () => {
            const expanding = !$nodeBody.hasClass('cnz-li-expanded');
            if (expanding && !loaded) {
                loaded = true;
                const lbName  = escapeHtml(anchor.lorebook?.name ?? '—');
                let ragFileHtml;
                if (!anchor.ragUrl) {
                    ragFileHtml = '<span class="cnz-li-status-muted">none</span>';
                } else {
                    const fileName  = escapeHtml(anchor.ragUrl.split('/').pop());
                    const onDisk    = verifiedOnDisk.has(anchor.ragUrl);
                    const statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                    const statusChr = onDisk ? '✓' : '✗';
                    ragFileHtml = `<span class="${statusCls}">${statusChr}</span> ${fileName}`;
                }
                $nodeBody.html(`
                    <div class="cnz-li-field"><span class="cnz-li-field-label">UUID: </span>${escapeHtml(anchor.uuid ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Parent: </span>${escapeHtml(anchor.parentUuid ?? 'root')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Committed: </span>${escapeHtml(anchor.committedAt ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Lorebook: </span>${lbName}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">RAG file: </span>${ragFileHtml}</div>
                    <div class="cnz-li-field cnz-li-hooks-block">
                        <span class="cnz-li-field-label">Hooks:</span>
                        <div class="cnz-li-hooks-preview">${escapeHtml(anchor.hooks || '(none)')}</div>
                    </div>
                `);
            }
            $nodeBody.toggleClass('cnz-li-expanded', expanding);
            $head.find('.cnz-li-chevron').text(expanding ? '▼' : '▶');
        });

        $row.append($head).append($nodeBody);
        $body.append($row);
    }
}

// ─── Orphan Review Modal ───────────────────────────────────────────────────────

function closeOrphanModal() {
    $('#cnz-orphan-overlay').addClass('cnz-hidden');
}

/**
 * Opens the Orphan Review modal for a given list of orphaned file paths.
 * @param {string[]} orphans  Client-relative paths of unreferenced files.
 */
export function openOrphanModal(orphans) {
    const $overlay = $('#cnz-orphan-overlay');
    const $body    = $('#cnz-orphan-body');
    const $footer  = $overlay.find('.cnz-orphan-footer');

    $body.empty();
    $footer.show();

    if (!orphans.length) {
        $body.append('<div class="cnz-li-empty">No orphaned files found.</div>');
        $footer.hide();
        $overlay.removeClass('cnz-hidden');
        return;
    }

    $('#cnz-orphan-title').text(`Orphaned Files — ${orphans.length} file${orphans.length !== 1 ? 's' : ''}`);

    function checkResolved() {
        if ($body.find('.cnz-orphan-row').length === 0) {
            $body.html('<div class="cnz-li-empty">All orphaned files resolved.</div>');
            $footer.hide();
        }
    }

    orphans.forEach(path => {
        const filename = path.split('/').pop();
        const $row = $(`
<div class="cnz-orphan-row" data-path="${escapeHtml(path)}">
  <div class="cnz-orphan-row-header">
    <span class="cnz-orphan-filename">${escapeHtml(filename)}</span>
    <button class="cnz-orphan-preview-btn cnz-btn cnz-btn-secondary cnz-btn-sm">Preview</button>
    <button class="cnz-orphan-delete-btn cnz-btn cnz-btn-danger cnz-btn-sm">Delete</button>
  </div>
  <div class="cnz-orphan-preview-panel cnz-hidden"></div>
</div>`);

        // Preview toggle
        $row.find('.cnz-orphan-preview-btn').on('click', async function () {
            const $panel = $row.find('.cnz-orphan-preview-panel');
            if (!$panel.hasClass('cnz-hidden')) {
                $panel.addClass('cnz-hidden');
                $(this).text('Preview');
                return;
            }
            $(this).text('Loading…').prop('disabled', true);
            try {
                const res  = await fetch(path);
                const text = res.ok ? await res.text() : `(fetch failed: HTTP ${res.status})`;
                $panel.text(text);
            } catch (err) {
                $panel.text(`(fetch error: ${err.message})`);
            }
            $panel.removeClass('cnz-hidden');
            $(this).text('Collapse').prop('disabled', false);
        });

        // Delete single row
        $row.find('.cnz-orphan-delete-btn').on('click', async function () {
            $(this).prop('disabled', true);
            await cnzDeleteFile(path);
            $row.remove();
            checkResolved();
        });

        $body.append($row);
    });

    // Delete All
    $('#cnz-orphan-delete-all').off('click.orphan').on('click.orphan', async function () {
        $(this).prop('disabled', true);
        const paths = $body.find('.cnz-orphan-row').map((_, el) => $(el).data('path')).get();
        for (const p of paths) { await cnzDeleteFile(p); }
        $body.find('.cnz-orphan-row').remove();
        checkResolved();
    });

    // Close handlers
    $('#cnz-orphan-close').off('click.orphan').on('click.orphan', closeOrphanModal);
    $overlay.off('click.orphan').on('click.orphan', closeOrphanModal);
    $('#cnz-orphan-modal').off('click.orphan').on('click.orphan', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');
}
