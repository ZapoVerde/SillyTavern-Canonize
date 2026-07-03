/**
 * @file data/default-user/extensions/canonize/wand.js
 * @stamp {"utc":"2026-07-02T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Orchestrator
 * @description
 * Wand toolbar button — the manual sync entry point. Injects the button into
 * the ST extensions menu, and when the gap exceeds the sync window shows a
 * three-way radio choice (single pass / one step and stop / auto stepthrough)
 * before dispatching to runCnzSync or runCnzSyncCatchUp, then openReviewModal.
 *
 * @api-declaration
 * injectWandButton() — inserts the wand button into #extensionsMenu
 * onWandButtonClick() — decision tree: open modal, run sync, or show gap dialog
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [ST context, DOM, runCnzSync, runCnzSyncCatchUp, openReviewModal]
 */

import { log, warn, error } from './log.js';
import { isSyncInProgress, getGap } from './scheduler.js';
import { getSettings, getMetaSettings } from './core/settings.js';
import { buildProsePairs } from './core/transcript.js';
import { runCnzSync } from './core/sync.js';
import { runCnzSyncCatchUp } from './core/sync-catchup.js';
import { buildGapModeRadiosHtml } from './core/gap-mode.js';
import { openReviewModal } from './modal/orchestrator.js';
import { state } from './state.js';

/**
 * @param {string} bodyHtml
 * @param {{value: string, label: string, desc: string, checked: boolean}[]} modes
 * @returns {Promise<string>} selected mode value, or 'cancel'
 */
function showSyncChoicePopup(bodyHtml, modes) {
    return new Promise(resolve => {
        const $overlay = $(`
            <div class="cnz-choice-overlay">
                <div class="cnz-choice-dialog">
                    ${bodyHtml}
                    ${buildGapModeRadiosHtml(modes)}
                    <div class="cnz-choice-buttons">
                        <button class="cnz-choice-confirm menu_button">Continue</button>
                        <button class="cnz-choice-cancel menu_button">Cancel</button>
                    </div>
                </div>
            </div>
        `);
        $overlay.find('.cnz-choice-confirm').on('click', () => {
            const mode = $overlay.find('input[name="cnz-gap-mode"]:checked').val() ?? 'cancel';
            $overlay.remove(); resolve(mode);
        });
        $overlay.find('.cnz-choice-cancel').on('click', () => { $overlay.remove(); resolve('cancel'); });
        $('body').append($overlay);
    });
}

export async function onWandButtonClick() {
    const ctx = SillyTavern.getContext();
    if (!ctx || ctx.groupId || ctx.characterId == null) {
        toastr.error('CNZ: No character selected.');
        return;
    }
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync already in progress — please wait.');
        return;
    }

    const char     = ctx.characters[ctx.characterId];
    const messages = ctx.chat ?? [];
    const settings = getSettings();
    const gap      = getGap(settings);

    if (gap < (settings.chunkEveryN ?? 20)) {
        openReviewModal();
        return;
    }

    if (gap === (settings.chunkEveryN ?? 20)) {
        toastr.info('CNZ: Running sync…');
        await runCnzSync(char, messages);
        openReviewModal();
        return;
    }

    const winSize       = settings.chunkEveryN ?? 20;
    const lkgIdx        = state._dnaChain?.lkgMsgIdx ?? -1;
    const lcb           = settings.liveContextBuffer ?? 5;
    const pairCount     = messages.filter(m => !m.is_system && m.is_user).length;
    const priorPairs    = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system && m.is_user).length
        : 0;
    const trailingBound = Math.max(0, pairCount - lcb);
    const allPairs      = buildProsePairs(messages);
    const gapPairs      = allPairs.slice(priorPairs, trailingBound);
    const middlePairs   = gapPairs.slice(0, Math.max(0, gapPairs.length - winSize));
    const unragged      = middlePairs.filter(p => {
        const lastMsg = p.messages.length > 0 ? p.messages[p.messages.length - 1] : p.user;
        return !lastMsg?.extra?.cnz_chunk_header;
    });

    let extraWarning;
    if (middlePairs.length === 0) {
        extraWarning = '';
    } else if (unragged.length === 0) {
        extraWarning = `<p class="cnz-choice-info">✓ All ${middlePairs.length} middle turn(s) are already in RAG — Individual step will only skip the anchor update.</p>`;
    } else if (unragged.length < middlePairs.length) {
        extraWarning = `<p class="cnz-choice-warn">⚠ ${unragged.length} of ${middlePairs.length} middle turn(s) have never been in RAG and will be lost with Individual step.</p>`;
    } else {
        extraWarning = `<p class="cnz-choice-warn">⚠ ${unragged.length} turn(s) in the middle have never been in RAG and will be lost with Individual step.</p>`;
    }

    const defaultMode = getMetaSettings().gapCatchupDefault ?? 'onestep';
    const autoSteps   = Math.max(1, Math.ceil(gap / winSize));
    const choice = await showSyncChoicePopup(
        `<h3>How much should this sync cover?</h3>
        <p>${gap} turn(s) have accumulated since the last sync (window size: ${winSize}).</p>
        ${extraWarning}`,
        [
            {
                value: 'single', checked: defaultMode === 'single',
                label: 'Full gap, one shot',
                desc: `Processes all ${gap} turns in a single pass, right now.`,
            },
            {
                value: 'onestep', checked: defaultMode === 'onestep',
                label: 'Individual step and stop',
                desc: `Processes just the standard window (${winSize} turns) now (spends tokens as each step gets processed by an LLM), then stops — lets you review what's committed before running another sync.`,
            },
            {
                value: 'auto', checked: defaultMode === 'auto',
                label: 'Auto step and continue',
                desc: `Runs standard-window syncs back-to-back, without stopping, until the entire gap is closed (${autoSteps} sync ${autoSteps === 1 ? 'step' : 'steps'}). Takes time and spends tokens as each step gets processed by an LLM.`,
            },
        ],
    );
    if (choice === 'cancel') return;

    // Re-check: time passed while the popup awaited user input, and a
    // background sync (auto trigger, or the healer's chat-load offer) may
    // have started in the meantime.
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync already in progress — please wait.');
        return;
    }

    if (choice === 'single') {
        toastr.info(`CNZ: Running sync (full ${gap}-turn gap)…`);
        await runCnzSync(char, messages, { coverAll: true });
    } else if (choice === 'auto') {
        toastr.info(`CNZ: Auto-stepping through ${gap}-turn gap…`);
        await runCnzSyncCatchUp(char, messages);
    } else {
        toastr.info(`CNZ: Running sync (last ${winSize} turns)…`);
        await runCnzSync(char, messages, { coverAll: false });
    }
    openReviewModal();
}

export function injectWandButton() {
    log('Init', 'injectWandButton: Checking for #extensionsMenu...');
    if ($('#cnz-wand-btn').length) return;
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) {
        warn('Init', 'injectWandButton: #extensionsMenu not found in DOM!');
        return;
    }
    const btn = $(
        '<div id="cnz-wand-btn" class="list-group-item flex-container flexGap5" title="Run Canonize">' +
        '<i class="fa-solid fa-book-open"></i>' +
        '<span>Run Canonize</span>' +
        '</div>'
    );
    btn.on('click', () => onWandButtonClick().catch(err => {
        error('Init', 'Wand button error:', err);
        toastr.error(`CNZ: ${err.message}`);
    }));
    $menu.append(btn);
    log('Init', 'injectWandButton: Success.');
}
