/**
 * @file data/default-user/extensions/canonize/settings/handlers-rag.js
 * @stamp {"utc":"2026-06-06T00:00:00.000Z"}
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
import { configureFts } from '../rag/fts.js';
import { DEFAULT_RAG_CLASSIFIER_PROMPT, DEFAULT_RAG_INJECTION_TEMPLATE, DEFAULT_RAG_CHUNK_TEMPLATE } from '../defaults.js';
import { getSettings } from './data.js';
import { bindEmbedHandlers } from './handlers-rag-embed.js';
import { lbSetCharacterLorebook } from '../lorebook/api.js';
import { clearCnzLbPrompt } from '../core/summary-prompt.js';
import { log, error } from '../log.js';

export function bindRagHandlers({ updateDirtyIndicator, openPromptModal }) {

    $('#cnz-set-rag-max-tokens').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) { getSettings().ragMaxTokens = val; saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-chunk-size').on('input', function () {
        getSettings().ragChunkSize = Math.max(1, parseInt($(this).val()) || 2);
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
    $('#cnz-set-rag-cutoff-mode').on('change', function () {
        getSettings().ragCutoffMode = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-pool-multiple').on('input', function () {
        const val = parseFloat($(this).val());
        if (!isNaN(val)) {
            getSettings().ragPoolMultiple = val;
            $('#cnz-set-rag-pool-multiple-val').text(val + 'x');
            saveSettingsDebounced(); updateDirtyIndicator();
        }
    });

    $('#cnz-set-rag-kw-blend').on('input', function () {
        const val = parseFloat($(this).val());
        if (!isNaN(val)) {
            getSettings().ragKwBlend = val;
            $('#cnz-set-rag-kw-blend-val').text(Math.round(val * 100) + '% vec');
            saveSettingsDebounced(); updateDirtyIndicator();
        }
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

    // ── Unicode FTS ───────────────────────────────────────────────────────────
    $('#cnz-set-rag-fts-unicode').on('change', function () {
        const unicodeMode = $(this).prop('checked');
        getSettings().ragFtsUnicode = unicodeMode;
        configureFts({ unicodeMode });
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    // ── LB RAG-only mode ──────────────────────────────────────────────────────
    $('#cnz-set-lb-rag-only').on('change', async function () {
        const bypass = $(this).prop('checked');
        getSettings().lbRagOnly = bypass;
        saveSettingsDebounced(); updateDirtyIndicator();

        const lbName = state._lorebookName
            || state._dnaChain?.lkg?.anchor?.lorebook?.name;
        if (lbName) {
            try {
                await lbSetCharacterLorebook(bypass ? '' : lbName);
                log('Settings', `LB bypass=${bypass}: lorebook ${bypass ? 'detached' : 'reattached'}`);
            } catch (err) {
                error('Settings', 'Failed to update character lorebook attachment:', err);
            }
        }

        if (!bypass) clearCnzLbPrompt();
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

