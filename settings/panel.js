/**
 * @file data/default-user/extensions/canonize/settings/panel.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role UI Builder
 * @description
 * Owns the extension settings panel rendered in the ST extensions drawer.
 * Manages profile creation, switching, and deletion; binds all input handlers
 * to activeState; controls visibility of dependent controls (e.g. RAG AI
 * controls hidden when RAG is disabled); and hosts the prompt-editor modal
 * for editing multi-line AI prompts.
 *
 * @core-principles
 *   1. All handlers write to activeState first, then call saveSettingsDebounced.
 *   2. refreshSettingsUI is the single source of truth for control state — never set DOM directly.
 *
 * @api-declaration
 *   injectSettingsPanel
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings/getMetaSettings)]
 *     external_io: [none]
 */

import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { buildSettingsHTML } from '../ui.js';
import { state, escapeHtml } from '../state.js';
import { DEFAULT_LOREBOOK_SYNC_PROMPT, DEFAULT_HOOKSEEKER_PROMPT,
         DEFAULT_RAG_CLASSIFIER_PROMPT,
         DEFAULT_TARGETED_UPDATE_PROMPT, DEFAULT_TARGETED_NEW_PROMPT } from '../defaults.js';
import { getSettings, getMetaSettings } from './data.js';
import { openDnaChainInspector } from '../modal/orchestrator.js';
import { purgeAndRebuild, purgeCnzFiles } from '../core/healer.js';
import { log, warn, error, setVerbose } from '../log.js';

// ─── Local Constants ──────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;   // default for maxConcurrentCalls setting
const DEFAULT_SEPARATOR   = 'Chunk {{chunk_number}} ({{turn_range}})'; // RAG separator default

// ─── Prompt Modal ─────────────────────────────────────────────────────────────

/**
 * Opens the prompt-editor popup for a given settings key.
 * Changes are saved live on input; the modal is closed with the Close button
 * or by clicking the overlay backdrop.
 * @param {string}      settingsKey        Key in extension_settings[EXT_NAME] to read/write.
 * @param {string}      title              Title displayed in the modal header.
 * @param {string}      defaultValue       Value used by the "Reset to Default" button.
 * @param {string[]}    vars               Template variable names to display as badges.
 */
function openPromptModal(settingsKey, title, defaultValue, vars = []) {
    const $overlay  = $('#cnz-pm-overlay');
    const $textarea = $('#cnz-pm-textarea');
    const $titleEl  = $('#cnz-pm-title');
    const $reset    = $('#cnz-pm-reset');
    const $close    = $('#cnz-pm-close');
    const $vars     = $('#cnz-pm-vars');

    $titleEl.text(title);
    $textarea.val(getSettings()[settingsKey] ?? defaultValue);
    $vars.html(vars.map(v => `<code class="cnz-pm-var">{{${v}}}</code>`).join(' '));

    // Unbind any previous open's handlers before re-binding
    $textarea.off('input.pm');
    $reset.off('click.pm');
    $close.off('click.pm');
    $overlay.off('mousedown.pm click.pm');
    $('#cnz-pm-modal').off('mousedown.pm click.pm').on('mousedown.pm click.pm', e => e.stopPropagation());

    $textarea.on('input.pm', function () {
        getSettings()[settingsKey] = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $reset.on('click.pm', function () {
        getSettings()[settingsKey] = defaultValue;
        $textarea.val(defaultValue);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    const closePromptModal = (e) => {
        e?.stopPropagation();
        $overlay.addClass('cnz-hidden');
    };
    $close.on('click.pm', closePromptModal);
    $overlay.on('click.pm', function (e) {
        if (e.target === this) closePromptModal(e);
    }).on('mousedown.pm', function (e) {
        if (e.target === this) e.stopPropagation();
    });

    $overlay.removeClass('cnz-hidden');
    requestAnimationFrame(() => $textarea[0]?.focus());
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

/** True if activeState differs from the saved profile snapshot. */
function isStateDirty() {
    const meta = getMetaSettings();
    return JSON.stringify(meta.activeState) !== JSON.stringify(meta.profiles[meta.currentProfileName]);
}

/** Updates the profile dropdown label to append '*' when state is dirty. */
function updateDirtyIndicator() {
    const meta  = getMetaSettings();
    const label = meta.currentProfileName + (isStateDirty() ? ' *' : '');
    const $sel  = $('#cnz-profile-select');
    $sel.find(`option[value="${CSS.escape(meta.currentProfileName)}"]`).text(label);
    $sel.val(meta.currentProfileName);
}

/**
 * Repopulates all settings inputs from activeState. Called after loading a profile.
 * Connection profile dropdowns are re-initialized via handleDropdown, which
 * requires the element to already be in the DOM.
 */
function refreshSettingsUI() {
    const s = getSettings();

    $('#cnz-set-live-context-buffer').val(s.liveContextBuffer ?? 5);
    $('#cnz-set-chunk-every-n').val(s.chunkEveryN ?? 20);
    $('#cnz-set-gap-snooze').val(s.gapSnoozeTurns ?? 5);
    $('#cnz-set-hookseeker-horizon').val(s.hookseekerHorizon ?? 40);
    $('#cnz-set-lorebook-sync-start').val(s.lorebookSyncStart ?? 'syncPoint');
    $('#cnz-set-enable-personalyze').prop('checked', s.enablePersonalyze ?? false);
    $('#cnz-set-auto-advance-mask').prop('checked', s.autoAdvanceMask ?? false);
    $('#cnz-set-enable-rag').prop('checked', s.enableRag ?? false);
    $('#cnz-rag-settings-body').toggleClass('cnz-disabled', !(s.enableRag ?? false));
    $('#cnz-set-rag-separator').val(s.ragSeparator ?? DEFAULT_SEPARATOR);
    $('#cnz-set-rag-contents').val(s.ragContents ?? 'summary+full');

    const hasSummary = (s.ragContents ?? 'summary+full') !== 'full';
    $('#cnz-rag-summary-source-row').toggleClass('cnz-hidden', !hasSummary);
    $('#cnz-set-rag-summary-source').val(s.ragSummarySource ?? 'defined');
    $('#cnz-set-rag-max-tokens').val(s.ragMaxTokens ?? 100);
    $('#cnz-set-rag-chunk-size').val(s.ragChunkSize ?? 2);
    $('#cnz-set-rag-chunk-overlap').val(s.ragChunkOverlap ?? 0);
    $('#cnz-set-rag-classifier-history').val(s.ragClassifierHistory ?? 0);
    $('#cnz-set-rag-max-concurrent').val(s.maxConcurrentCalls ?? DEFAULT_CONCURRENCY);
    $('#cnz-set-rag-retries').val(s.ragMaxRetries ?? 1);
    updateRagAiControlsVisibility();

    // Re-initialize connection profile dropdowns with the newly loaded values.
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile',
            s.profileId ?? '',
            (profile) => { getSettings().profileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile',
            s.ragProfileId ?? '',
            (profile) => { getSettings().ragProfileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }

    $('#cnz-set-verbose-logging').prop('checked', getMetaSettings().verboseLogging ?? false);
    updateDirtyIndicator();
}

/** Rebuilds the profile <select> options from the current profiles dict. */
function refreshProfileDropdown() {
    const meta = getMetaSettings();
    const $sel = $('#cnz-profile-select');
    $sel.empty();
    for (const name of Object.keys(meta.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateDirtyIndicator();
}

function bindSettingsHandlers() {
    // ── Summary / Lorebook ────────────────────────────────────────────────────
    $('#cnz-set-live-context-buffer').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 5);
        getSettings().liveContextBuffer = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-chunk-every-n').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 20);
        getSettings().chunkEveryN = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-gap-snooze').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 5);
        getSettings().gapSnoozeTurns = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-hookseeker-horizon').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 40);
        getSettings().hookseekerHorizon = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-lorebook-sync-start').on('change', function () {
        getSettings().lorebookSyncStart = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-enable-personalyze').on('change', function () {
        getSettings().enablePersonalyze = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-auto-advance-mask').on('change', function () {
        getSettings().autoAdvanceMask = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-summary-prompt').on('click', () =>
        openPromptModal('hookseekerPrompt', 'Edit Summary Prompt', DEFAULT_HOOKSEEKER_PROMPT,
            ['transcript', 'prev_summary']));

    $('#cnz-edit-lorebook-prompt').on('click', () =>
        openPromptModal('lorebookSyncPrompt', 'Edit Lorebook Sync Prompt', DEFAULT_LOREBOOK_SYNC_PROMPT,
            ['lorebook_entries', 'transcript']));

    $('#cnz-edit-targeted-update-prompt').on('click', () =>
        openPromptModal('targetedUpdatePrompt', 'Edit Targeted Update Prompt',
            DEFAULT_TARGETED_UPDATE_PROMPT,
            ['entry_name', 'entry_keys', 'entry_content', 'transcript']));

    $('#cnz-edit-targeted-new-prompt').on('click', () =>
        openPromptModal('targetedNewPrompt', 'Edit Targeted New Entry Prompt',
            DEFAULT_TARGETED_NEW_PROMPT,
            ['entry_name', 'transcript']));

    // ── RAG ───────────────────────────────────────────────────────────────────
    $('#cnz-set-enable-rag').on('change', function () {
        getSettings().enableRag = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
        $('#cnz-rag-settings-body').toggleClass('cnz-disabled', !getSettings().enableRag);
    });

    $('#cnz-set-rag-separator').on('change', function () {
        const newVal   = $(this).val();
        const oldVal   = getSettings().ragSeparator ?? '';
        if (newVal === oldVal) return;

        // Count stored chunk headers in the current chat
        const chat       = SillyTavern.getContext().chat ?? [];
        const storedCount = chat.filter(m => m.extra?.cnz_chunk_header).length;

        if (storedCount > 0) {
            const approxTurns = storedCount * (getSettings().ragChunkSize ?? 2);
            const confirmed   = confirm(
                `Changing the separator invalidates ${storedCount} stored chunk header(s) ` +
                `(~${approxTurns} turns).\n\n` +
                `All headers will be cleared and reclassified, and your external vector store ` +
                `will need to resync.\n\nProceed?`
            );
            if (!confirmed) {
                $(this).val(oldVal);   // revert the input
                return;
            }
            // Clear stored headers from all chat messages
            for (const m of chat) {
                if (m.extra?.cnz_chunk_header) {
                    delete m.extra.cnz_chunk_header;
                    delete m.extra.cnz_turn_label;
                }
            }
            SillyTavern.getContext().saveChat().catch(err =>
                error('Settings', 'saveChat after separator clear failed:', err),
            );
            // Mark any in-memory chunks as pending so they reclassify on next open
            for (const c of state._ragChunks) {
                if (c.status === 'complete' || c.status === 'manual') c.status = 'pending';
            }
        }

        getSettings().ragSeparator = newVal;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-contents').on('change', function () {
        getSettings().ragContents = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        const hasSummary = $(this).val() !== 'full';
        $('#cnz-rag-summary-source-row').toggleClass('cnz-hidden', !hasSummary);
        updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-summary-source').on('change', function () {
        getSettings().ragSummarySource = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-max-tokens').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) {
            getSettings().ragMaxTokens = val;
            saveSettingsDebounced(); updateDirtyIndicator();
        }
    });

    $('#cnz-set-rag-chunk-size').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 2);
        getSettings().ragChunkSize = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-chunk-overlap').on('change', function () {
        getSettings().ragChunkOverlap = parseInt($(this).val()) || 0;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-max-concurrent').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || DEFAULT_CONCURRENCY);
        getSettings().maxConcurrentCalls = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-retries').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().ragMaxRetries = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-classifier-history').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().ragClassifierHistory = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-classifier-prompt').on('click', () =>
        openPromptModal('ragClassifierPrompt', 'Edit Classifier Prompt', DEFAULT_RAG_CLASSIFIER_PROMPT,
            ['summary', 'history', 'target_turns']));

    // ── Connection profiles ───────────────────────────────────────────────────
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile',
            getSettings().profileId ?? '',
            (profile) => {
                getSettings().profileId = profile?.id ?? null;
                saveSettingsDebounced(); updateDirtyIndicator();
            },
        );
    } catch (e) {
        warn('Settings', 'Could not initialize profile dropdown:', e);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile',
            getSettings().ragProfileId ?? '',
            (profile) => {
                getSettings().ragProfileId = profile?.id ?? null;
                saveSettingsDebounced(); updateDirtyIndicator();
            },
        );
    } catch (e) {
        warn('Settings', 'Could not initialize RAG profile dropdown:', e);
    }

    // ── Profile management ────────────────────────────────────────────────────
    $('#cnz-profile-select').on('change', function () {
        const newName = $(this).val();
        const meta    = getMetaSettings();
        if (!meta.profiles[newName]) return;
        meta.currentProfileName = newName;
        meta.activeState        = structuredClone(meta.profiles[newName]);
        saveSettingsDebounced();
        refreshSettingsUI();
    });

    $('#cnz-profile-save').on('click', function () {
        const meta = getMetaSettings();
        meta.profiles[meta.currentProfileName] = structuredClone(meta.activeState);
        saveSettingsDebounced();
        updateDirtyIndicator();
    });

    $('#cnz-profile-add').on('click', async function () {
        const rawName = await callPopup('<h3>New profile name</h3>', 'input', '');
        const name    = (rawName ?? '').trim();
        if (!name) return;
        const meta = getMetaSettings();
        if (meta.profiles[name]) {
            toastr.warning(`Profile "${name}" already exists.`);
            return;
        }
        meta.profiles[name]     = structuredClone(meta.activeState);
        meta.currentProfileName = name;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#cnz-profile-rename').on('click', async function () {
        const meta    = getMetaSettings();
        const rawName = await callPopup('<h3>Rename profile</h3>', 'input', meta.currentProfileName);
        const newName = (rawName ?? '').trim();
        if (!newName || newName === meta.currentProfileName) return;
        if (meta.profiles[newName]) {
            toastr.warning(`Profile "${newName}" already exists.`);
            return;
        }
        meta.profiles[newName] = meta.profiles[meta.currentProfileName];
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = newName;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#cnz-profile-delete').on('click', async function () {
        const meta = getMetaSettings();
        if (Object.keys(meta.profiles).length <= 1) {
            toastr.warning('Cannot delete the only profile.');
            return;
        }
        const confirmed = await callPopup(
            `<h3>Delete profile "${escapeHtml(meta.currentProfileName)}"?</h3>This cannot be undone.`,
            'confirm',
        );
        if (!confirmed) return;
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = Object.keys(meta.profiles)[0];
        meta.activeState        = structuredClone(meta.profiles[meta.currentProfileName]);
        saveSettingsDebounced();
        refreshProfileDropdown();
        refreshSettingsUI();
    });

    $('#cnz-set-verbose-logging').on('change', function () {
        const enabled = $(this).prop('checked');
        getMetaSettings().verboseLogging = enabled;
        setVerbose(enabled);
        saveSettingsDebounced();
    });

    $('#cnz-inspect-chain').on('click', function () {
        openDnaChainInspector();
    });

    $('#cnz-purge-chain').on('click', function () { purgeAndRebuild(); });
    $('#cnz-purge-files').on('click', function () { purgeCnzFiles(); });
}

/**
 * Shows/hides the RAG AI controls subgroup based on current ragContents and
 * ragSummarySource settings. Called on init and on dropdown changes.
 */
function updateRagAiControlsVisibility() {
    const s = getSettings();
    const hasSummary    = (s.ragContents ?? 'summary+full') !== 'full';
    const isDefinedHere = (s.ragSummarySource ?? 'defined') === 'defined';
    $('#cnz-rag-ai-controls').toggleClass('cnz-disabled', !(hasSummary && isDefinedHere));
}

export function injectSettingsPanel() {
    log('Init', 'injectSettingsPanel: Checking for #extensions_settings...');
    if ($('#cnz-settings').length) return;
    const $parent = $('#extensions_settings');
    if ($parent.length === 0) {
        warn('Init', 'injectSettingsPanel: #extensions_settings not found in DOM!');
        return;
    }
    const meta = getMetaSettings();
    $parent.append(
        buildSettingsHTML(getSettings(), escapeHtml, Object.keys(meta.profiles), meta.currentProfileName, meta.verboseLogging ?? false),
    );
    setVerbose(meta.verboseLogging ?? false);
    bindSettingsHandlers();
    refreshProfileDropdown();
    updateRagAiControlsVisibility();
    log('Init', 'injectSettingsPanel: Success.');
}
