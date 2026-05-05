/**
 * @file data/default-user/extensions/canonize/modal/hooks-workshop.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role UI Builder
 * @description
 * Owns Step 1 of the review modal (Hooks Workshop). Handles tab switching
 * between workshop/new/old views, drives hookseeker regen, and renders the
 * word-level diff against the previous sync's hookseeker output.
 *
 * @api-declaration
 * setHooksLoading, onHooksTabSwitch, updateHooksDiff, onRegenHooksClick,
 * buildSyncWindowTranscript, buildModalTranscript
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._hooksLoading, state._priorSituation, state._hooksRegenGen]
 *     external_io: [generateRaw]
 */

import { state } from '../state.js';
import { getSettings } from '../core/settings.js';
import { buildProsePairs, buildTranscript } from '../core/transcript.js';
import { wordDiff } from '../lorebook/utils.js';

// ─── Modal: Hooks Workshop ────────────────────────────────────────────────────

export function setHooksLoading(isLoading) {
    state._hooksLoading = isLoading;
    $('#cnz-spin-hooks').toggleClass('cnz-hidden', !isLoading);
    $('#cnz-regen-hooks').prop('disabled', isLoading);
    $('#cnz-situation-text').prop('disabled', isLoading);
}

/**
 * Builds a rolling window transcript for modal AI calls, using the full chat
 * (up to the latest turn). Used when "up to latest turn" is explicitly requested.
 * @param {number} horizonTurns  Number of trailing turns to include.
 * @returns {string}
 */
export function buildModalTranscript(horizonTurns) {
    const context      = SillyTavern.getContext();
    const messages     = context.chat ?? [];
    const allPairs     = buildProsePairs(messages);
    const windowPairs  = allPairs.slice(-horizonTurns);
    const windowMsgs   = windowPairs.flatMap(p => [p.user, ...p.messages]);
    return buildTranscript(windowMsgs);
}

/**
 * Builds a transcript bounded by the sync window (state._stagedProsePairs), so AI calls
 * never see turns beyond the edge of the last sync.
 * @param {number}   horizonTurns  Number of trailing turns to include.
 * @param {object[]} messages      Full chat message array.
 * @param {object}   settings      Active profile settings (liveContextBuffer).
 * @returns {string}
 */
export function buildSyncWindowTranscript(horizonTurns, messages, settings) {
    const allPairs = buildProsePairs(messages);

    const lcb = settings.liveContextBuffer ?? 5;
    const tbb = Math.max(0, allPairs.length - lcb);   // trailing buffer boundary in pairs

    let windowPairs = allPairs.filter((_, i) => i < tbb);

    // SURGICAL UNLOCK: If the buffer is larger than the chat,
    // don't send an empty transcript. Send the last available pair.
    if (windowPairs.length === 0 && allPairs.length > 0) {
        windowPairs = [allPairs[allPairs.length - 1]];
    }

    const windowMsgs = windowPairs.slice(-horizonTurns).flatMap(p => [p.user, ...p.messages]);
    return buildTranscript(windowMsgs);
}

/**
 * Switches the Step 1 Hooks Workshop to the given tab ('workshop' | 'new' | 'old').
 * @param {string} tabName
 */
export function onHooksTabSwitch(tabName) {
    $('#cnz-hooks-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-hooks-tab-workshop').toggleClass('cnz-hidden', tabName !== 'workshop');
    $('#cnz-hooks-tab-new').toggleClass('cnz-hidden',      tabName !== 'new');
    $('#cnz-hooks-tab-old').toggleClass('cnz-hidden',      tabName !== 'old');
}

/** Recomputes the Workshop tab diff display (textarea content vs `state._beforeSituation`). */
export function updateHooksDiff() {
    const current = $('#cnz-situation-text').val();
    $('#cnz-hooks-diff').html(wordDiff(state._beforeSituation, current));
}

/**
 * Fires a fresh hookseeker AI call and updates `state._priorSituation`, the textarea,
 * the New tab display, and the Workshop diff. Switches to Workshop tab on success.
 */
export function onRegenHooksClick() {
    setHooksLoading(true);
    $('#cnz-error-1').addClass('cnz-hidden').text('');
    const thisGen       = ++state._hooksRegenGen;
    const horizon       = getSettings().hookseekerHorizon ?? 40;
    const regenMessages = SillyTavern.getContext().chat ?? [];
    const regenSettings = getSettings();
    const transcript    = buildSyncWindowTranscript(horizon, regenMessages, regenSettings);

    import('../core/llm-calls.js').then(({ runHookseekerCall }) => {
        runHookseekerCall(transcript, state._priorSituation)
            .then(text => {
                if (state._hooksRegenGen !== thisGen) return;
                const trimmed = text.trim();
                state._priorSituation = trimmed;
                $('#cnz-situation-text').val(trimmed);
                $('#cnz-hooks-new-display').text(trimmed);
                updateHooksDiff();
                setHooksLoading(false);
                onHooksTabSwitch('workshop');
            })
            .catch(err => {
                $('#cnz-error-1').text(`Hooks generation failed: ${err.message}`).removeClass('cnz-hidden');
                setHooksLoading(false);
            });
    });
}
