/**
 * @file data/default-user/extensions/canonize/settings/panel.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role UI Builder
 * @description
 * Owns the extension settings panel rendered in the ST extensions drawer.
 * Manages configuration inputs, binding them to activeState, and handling 
 * visibility of dependent controls.
 *
 * @api-declaration
 *   injectSettingsPanel, refreshSettingsUI
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings/getMetaSettings)]
 *     external_io: [none]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { ConnectionManagerRequestService } from '../../../shared.js';
import { buildSettingsHTML } from '../ui.js';
import { state, escapeHtml } from '../state.js';
import { 
    DEFAULT_LOREBOOK_SYNC_PROMPT, DEFAULT_HOOKSEEKER_PROMPT,
    DEFAULT_RAG_CLASSIFIER_PROMPT, DEFAULT_TARGETED_UPDATE_PROMPT, 
    DEFAULT_TARGETED_NEW_PROMPT 
} from '../defaults.js';
import { getSettings, getMetaSettings, isExtensionEnabled, setExtensionEnabled } from './data.js';
import { openDnaChainInspector } from '../modal/orchestrator.js';
import { toggleExtension } from '../core/session.js';
import { log, warn, error, setVerbose } from '../log.js';

// Refactored logic imports
import { openPromptModal } from '../ui/prompt-editor.js';
import { bindProfileHandlers, refreshProfileDropdown, updateDirtyIndicator } from './profiles-logic.js';
import { purgeAndRebuild } from '../core/healer.js';
import { purgeCnzFiles } from '../core/cleanup-logic.js';

// ─── Local Constants ──────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;   
const DEFAULT_SEPARATOR   = 'Chunk {{chunk_number}} ({{turn_range}})'; 

// ─── Settings Panel Logic ─────────────────────────────────────────────────────

/**
 * Repopulates all settings inputs from activeState. Called after loading a profile.
 * Connection profile dropdowns are re-initialized via handleDropdown.
 */
export function refreshSettingsUI() {
    const s = getSettings();

    $('#cnz-set-live-context-buffer').val(s.liveContextBuffer ?? 5);
    $('#cnz-set-chunk-every-n').val(s.chunkEveryN ?? 20);
    $('#cnz-set-gap-snooze').val(s.gapSnoozeTurns ?? 5);
    $('#cnz-set-hookseeker-horizon').val(s.hookseekerHorizon ?? 40);
    $('#cnz-set-lorebook-sync-start').val(s.lorebookSyncStart ?? 'syncPoint');
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
    
    // Ensure master toggle is visually correct
    const isExtEnabled = isExtensionEnabled();
    $('#cnz-set-extension-enabled').prop('checked', isExtEnabled);
    $('#cnz-settings-container').toggleClass('cnz-disabled', !isExtEnabled);
    
    updateDirtyIndicator();
}

function bindSettingsHandlers() {
    // ── Master Toggle ─────────────────────────────────────────────────────────
    $('#cnz-set-extension-enabled').on('change', async function () {
        const isEnabled = $(this).prop('checked');
        setExtensionEnabled(isEnabled);
        saveSettingsDebounced();
        $('#cnz-settings-container').toggleClass('cnz-disabled', !isEnabled);
        
        // Orchestrate the engine halt/resume
        await toggleExtension(isEnabled);
    });

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

        const chat       = SillyTavern.getContext().chat ?? [];
        const storedCount = chat.filter(m => m.extra?.cnz_chunk_header).length;

        if (storedCount > 0) {
            const approxTurns = storedCount * (getSettings().ragChunkSize ?? 2);
            const confirmed   = confirm(
                `Changing the separator invalidates ${storedCount} stored chunk header(s) ` +
                `(~${approxTurns} turns).\n\n` +
                `All headers will be cleared and reclassified.\n\nProceed?`
            );
            if (!confirmed) {
                $(this).val(oldVal);   
                return;
            }
            for (const m of chat) {
                if (m.extra?.cnz_chunk_header) {
                    delete m.extra.cnz_chunk_header;
                    delete m.extra.cnz_turn_label;
                }
            }
            SillyTavern.getContext().saveChat().catch(err =>
                error('Settings', 'saveChat after separator clear failed:', err),
            );
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
        ConnectionManagerRequestService.handleDropdown('#cnz-set-profile', getSettings().profileId ?? '', (profile) => {
            getSettings().profileId = profile?.id ?? null;
            saveSettingsDebounced(); updateDirtyIndicator();
        });
    } catch (e) { warn('Settings', 'Could not initialize profile dropdown:', e); }

    try {
        ConnectionManagerRequestService.handleDropdown('#cnz-set-rag-profile', getSettings().ragProfileId ?? '', (profile) => {
            getSettings().ragProfileId = profile?.id ?? null;
            saveSettingsDebounced(); updateDirtyIndicator();
        });
    } catch (e) { warn('Settings', 'Could not initialize RAG profile dropdown:', e); }

    // ── Profile management ────────────────────────────────────────────────────
    bindProfileHandlers(refreshSettingsUI);

    // ── Danger zone ───────────────────────────────────────────────────────────
    $('#cnz-set-verbose-logging').on('change', function () {
        const enabled = $(this).prop('checked');
        getMetaSettings().verboseLogging = enabled;
        setVerbose(enabled);
        saveSettingsDebounced();
    });

    $('#cnz-inspect-chain').on('click', function () { openDnaChainInspector(); });
    $('#cnz-purge-chain').on('click', function () { purgeAndRebuild(); });
    $('#cnz-purge-files').on('click', function () { purgeCnzFiles(); });
}

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
        buildSettingsHTML(
            getSettings(), 
            escapeHtml, 
            Object.keys(meta.profiles), 
            meta.currentProfileName, 
            meta.verboseLogging ?? false,
            isExtensionEnabled()
        ),
    );
    setVerbose(meta.verboseLogging ?? false);
    bindSettingsHandlers();
    refreshProfileDropdown();
    updateRagAiControlsVisibility();
    log('Init', 'injectSettingsPanel: Success.');
}