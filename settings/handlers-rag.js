/**
 * @file data/default-user/extensions/canonize/settings/handlers-rag.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Binds RAG settings panel event handlers (all except embedding source/model/browser,
 * which live in handlers-rag-embed.js). Exported as a single function called by
 * panel.js during initialization.
 *
 * @api-declaration
 * bindRagHandlers({ updateDirtyIndicator, openPromptModal })
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings)]
 *     external_io: [DOM, saveSettingsDebounced, lorebook API]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { state } from '../state.js';
import { DEFAULT_RAG_CLASSIFIER_PROMPT, DEFAULT_RAG_INJECTION_TEMPLATE, DEFAULT_RAG_CHUNK_TEMPLATE } from '../defaults.js';
import { getSettings } from './data.js';
import { bindEmbedHandlers } from './handlers-rag-embed.js';
import { lbSaveLorebook } from '../lorebook/api.js';
import { log, error } from '../log.js';

export function bindRagHandlers({ updateDirtyIndicator, openPromptModal }) {

    $('#cnz-set-rag-contents').on('change', function () {
        getSettings().ragContents = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        _updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-max-tokens').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) { getSettings().ragMaxTokens = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-chunk-size').on('input', function () {
        getSettings().ragChunkSize = Math.max(1, parseInt($(this).val()) || 2);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-chunk-overlap').on('change', function () {
        getSettings().ragChunkOverlap = parseInt($(this).val()) || 0;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-max-concurrent').on('input', function () {
        getSettings().maxConcurrentCalls = Math.max(1, parseInt($(this).val()) || 3);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-retries').on('input', function () {
        getSettings().ragMaxRetries = Math.max(0, parseInt($(this).val()) || 0);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-classifier-history').on('input', function () {
        getSettings().ragClassifierHistory = Math.max(0, parseInt($(this).val()) || 0);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-classifier-prompt').on('click', () =>
        openPromptModal('ragClassifierPrompt', 'Edit Classifier Prompt', DEFAULT_RAG_CLASSIFIER_PROMPT,
            ['summary', 'history', 'target_turns']));

    // ── Separator (with invalidation warning) ─────────────────────────────────
    $('#cnz-set-rag-separator').on('change', function () {
        const newVal = $(this).val();
        const oldVal = getSettings().ragSeparator ?? '';
        if (newVal === oldVal) return;
        const chat        = SillyTavern.getContext().chat ?? [];
        const storedCount = chat.filter(m => m.extra?.cnz_chunk_header).length;
        if (storedCount > 0) {
            const approxTurns = storedCount * (getSettings().ragChunkSize ?? 2);
            if (!confirm(`Changing the separator invalidates ${storedCount} stored chunk header(s) (~${approxTurns} turns). All headers will be cleared and reclassified. Proceed?`)) {
                $(this).val(oldVal); return;
            }
            for (const m of chat) {
                if (m.extra?.cnz_chunk_header) { delete m.extra.cnz_chunk_header; delete m.extra.cnz_turn_label; }
            }
            SillyTavern.getContext().saveChat().catch(err => error('Settings', 'saveChat after separator clear failed:', err));
            for (const c of state._ragChunks) {
                if (c.status === 'complete' || c.status === 'manual') c.status = 'pending';
            }
        }
        getSettings().ragSeparator = newVal;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    // ── Retrieval settings ────────────────────────────────────────────────────
    $('#cnz-set-rag-signal-strength').on('input', function () {
        const val = parseFloat($(this).val());
        if (!isNaN(val)) { getSettings().ragSignalStrength = Math.min(1, Math.max(0, val)); saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-chat-min').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 0) { getSettings().ragChatMin = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-chat-max').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) { getSettings().ragChatMax = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-lb-min').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 0) { getSettings().ragLbMin = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-lb-max').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) { getSettings().ragLbMax = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    // ── LB RAG-only mode ──────────────────────────────────────────────────────
    $('#cnz-set-lb-rag-only').on('change', function () {
        getSettings().lbRagOnly = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-lb-rag-only-apply').on('click', async function () {
        const lb = state._draftLorebook ?? state._lorebookData;
        const name = state._lorebookName;
        if (!lb || !name) { toastr.warning('No lorebook loaded — run a sync first.'); return; }

        const $btn = $(this);
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            const clone = structuredClone(lb);
            let count = 0;
            for (const entry of Object.values(clone.entries ?? {})) {
                if (!entry.disable && (entry.key?.length || entry.constant || !entry.preventRecursion)) {
                    entry.key             = [];
                    entry.constant        = false;
                    entry.preventRecursion = true;
                    count++;
                }
            }
            await lbSaveLorebook(name, clone);
            if (state._lorebookData) state._lorebookData = structuredClone(clone);
            if (state._draftLorebook) state._draftLorebook = structuredClone(clone);
            state._lastIndexedLorebookHash = null;
            log('Settings', `LB RAG-only: stripped keys from ${count} entries`);
            toastr.success(`Stripped keys from ${count} entries. ST keyword activation disabled.`);
        } catch (err) {
            error('Settings', 'LB RAG-only apply failed:', err);
            toastr.error(`Failed: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).text('Apply to existing entries');
        }
    });

    // ── Templates and prompt editors ─────────────────────────────────────────
    $('#cnz-inflection-explainer-trigger').on('click', function () {
        $('#cnz-inflection-explainer-body').toggleClass('cnz-hidden');
    });

    $('#cnz-edit-injection-template').on('click', () =>
        openPromptModal('ragInjectionTemplate', 'Edit Injection Template', DEFAULT_RAG_INJECTION_TEMPLATE, ['text']));

    $('#cnz-edit-chunk-template').on('click', () =>
        openPromptModal('ragChunkTemplate', 'Edit Chunk Template', DEFAULT_RAG_CHUNK_TEMPLATE, ['text', 'turn_range', 'header', 'char_name']));

    // ── Embed source / model / test / browser ─────────────────────────────────
    bindEmbedHandlers({ getSettings, updateDirtyIndicator });
}

export function updateRagAiControlsVisibility() {
    _updateRagAiControlsVisibility();
}

function _updateRagAiControlsVisibility() {
    const hasSummary = (getSettings().ragContents ?? 'summary+full') !== 'full';
    $('#cnz-rag-ai-controls').toggleClass('cnz-disabled', !hasSummary);
}
