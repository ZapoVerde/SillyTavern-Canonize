/**
 * @file data/default-user/extensions/canonize/ui/wand.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role UI Builder / Feature Trigger
 * @description
 * Manages the "Run Canonize" wand button in the SillyTavern extensions menu.
 * Owns the manual sync trigger logic, including the three-way choice dialog 
 * (Full vs. Window vs. Cancel) shown when a large turn gap is detected.
 *
 * @api-declaration
 * showSyncChoicePopup, onWandButtonClick, injectWandButton
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM, toastr]
 */

import { state } from '../state.js';
import { getSettings } from '../core/settings.js';
import { getGap, isSyncInProgress } from '../scheduler.js';
import { buildProsePairs } from '../core/transcript.js';
import { runCnzSync } from '../core/sync-pipeline.js';
import { openReviewModal } from '../modal/orchestrator.js';
import { log, warn, error } from '../log.js';

/**
 * Shows a three-button choice dialog for manual sync.
 * @param {string} bodyHtml   Inner HTML for the message body.
 * @param {string} fullLabel  Label for the "full gap" button.
 * @param {string} winLabel   Label for the "standard window" button.
 * @returns {Promise<'full'|'window'|'cancel'>}
 */
export function showSyncChoicePopup(bodyHtml, fullLabel, winLabel) {
    return new Promise(resolve => {
        const $overlay = $(`
            <div class="cnz-choice-overlay">
                <div class="cnz-choice-dialog">
                    ${bodyHtml}
                    <div class="cnz-choice-buttons">
                        <button class="cnz-choice-full menu_button">${fullLabel}</button>
                        <button class="cnz-choice-win menu_button">${winLabel}</button>
                        <button class="cnz-choice-cancel menu_button">Cancel</button>
                    </div>
                </div>
            </div>
        `);
        $overlay.find('.cnz-choice-full').on('click',   () => { $overlay.remove(); resolve('full'); });
        $overlay.find('.cnz-choice-win').on('click',    () => { $overlay.remove(); resolve('window'); });
        $overlay.find('.cnz-choice-cancel').on('click', () => { $overlay.remove(); resolve('cancel'); });
        $('body').append($overlay);
    });
}

/**
 * Handles the CNZ wand toolbar button click.
 * If gap is small, opens review modal directly.
 * If gap matches window, runs sync then opens modal.
 * If gap is large, prompts user for coverage level.
 */
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
    const winSize  = settings.chunkEveryN ?? 20;

    // 1. No new sync needed
    if (gap < winSize) {
        openReviewModal();
        return;
    }

    // 2. Perfect gap
    if (gap === winSize) {
        toastr.info('CNZ: Running sync…');
        await runCnzSync(char, messages);
        openReviewModal();
        return;
    }

    // 3. Large gap - prompt for choice
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
    
    const unragged = middlePairs.filter(p => {
        const lastMsg = p.messages.length > 0 ? p.messages[p.messages.length - 1] : p.user;
        return !lastMsg?.extra?.cnz_chunk_header;
    });

    let extraWarning = '';
    if (middlePairs.length > 0) {
        if (unragged.length === 0) {
            extraWarning = `<p class="cnz-choice-info">✓ All ${middlePairs.length} middle turn(s) are already in RAG — Standard window will only skip the anchor update.</p>`;
        } else {
            extraWarning = `<p class="cnz-choice-warn">⚠ ${unragged.length} turn(s) in the middle have never been in RAG and will be lost with Standard window.</p>`;
        }
    }

    const choice = await showSyncChoicePopup(
        `<h3>How much should this sync cover?</h3>
        <p>${gap} turn(s) have accumulated since the last sync (window size: ${winSize}).</p>
        ${extraWarning}`,
        `Full gap (${gap} turns)`,
        `Standard window (last ${winSize} turns)`,
    );
    
    if (choice === 'cancel') return;
    const coverAll = choice === 'full';

    toastr.info(`CNZ: Running sync (${coverAll ? `full ${gap}-turn gap` : `last ${winSize} turns`})…`);
    await runCnzSync(char, messages, { coverAll });
    openReviewModal();
}

/**
 * Injects the wand button into the ST extensions menu.
 */
export function injectWandButton() {
    if ($('#cnz-wand-btn').length) return;
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) {
        warn('Wand', 'injectWandButton: #extensionsMenu not found.');
        return;
    }
    const btn = $(
        '<div id="cnz-wand-btn" class="list-group-item flex-container flexGap5" title="Run Canonize">' +
        '<i class="fa-solid fa-book-open"></i>' +
        '<span>Run Canonize</span>' +
        '</div>'
    );
    btn.on('click', () => onWandButtonClick().catch(err => {
        error('Wand', 'Button error:', err);
        toastr.error(`CNZ: ${err.message}`);
    }));
    $menu.append(btn);
    log('Init', 'Wand button injected.');
}