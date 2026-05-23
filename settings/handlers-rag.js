/**
 * @file data/default-user/extensions/canonize/settings/handlers-rag.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Binds all RAG-related settings panel event handlers. Exported as a single
 * function called by panel.js during initialization. Receives shared utilities
 * (updateDirtyIndicator, openPromptModal) as parameters to avoid circular imports.
 *
 * @api-declaration
 * bindRagHandlers({ updateDirtyIndicator, openPromptModal })
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings)]
 *     external_io: [DOM, saveSettingsDebounced]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { state } from '../state.js';
import { DEFAULT_RAG_CLASSIFIER_PROMPT, DEFAULT_RAG_INJECTION_TEMPLATE, DEFAULT_RAG_CHUNK_TEMPLATE } from '../defaults.js';
import { getSettings } from './data.js';
import { error } from '../log.js';

let _orModelCache = null;

const OPENAI_EMBED_MODELS = [
    { id: 'text-embedding-3-large', label: 'text-embedding-3-large' },
    { id: 'text-embedding-3-small', label: 'text-embedding-3-small' },
    { id: 'text-embedding-ada-002',  label: 'text-embedding-ada-002' },
];

function _renderEmbedModelList(items, showingAll, withToggle = false) {
    const $list   = $('#cnz-embedding-model-list');
    const current = $('#cnz-set-embedding-model').val().trim();
    const sorted  = [...items].sort((a, b) => a.id.localeCompare(b.id));
    const opts    = ['<option value="">— Select a model —</option>'];
    if (withToggle) {
        const lbl = showingAll
            ? '— Showing all models · click to filter to embedding-only —'
            : '— Showing embedding models · click to show all —';
        opts.unshift(`<option value="__toggle__">${lbl}</option>`);
    }
    opts.push(...sorted.map(({ id, label }) => {
        const sel = id === current ? ' selected' : '';
        return `<option value="${$('<span>').text(id).html()}"${sel}>${$('<span>').text(label || id).html()}</option>`;
    }));
    $list.html(opts.join('')).data('showing-all', showingAll).removeClass('cnz-hidden');
}

export function bindRagHandlers({ updateDirtyIndicator, openPromptModal }) {

    $('#cnz-set-enable-rag').on('change', function () {
        getSettings().enableRag = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
        $('#cnz-rag-settings-body').toggleClass('cnz-disabled', !getSettings().enableRag);
    });

    $('#cnz-set-rag-contents').on('change', function () {
        getSettings().ragContents = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        const hasSummary = $(this).val() !== 'full';
        $('#cnz-rag-summary-source-row').toggleClass('cnz-hidden', !hasSummary);
        _updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-summary-source').on('change', function () {
        getSettings().ragSummarySource = $(this).val();
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
    $('#cnz-set-embedding-source').on('change', function () {
        getSettings().ragEmbeddingSource = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-embedding-model').on('input', function () {
        getSettings().ragEmbeddingModel = $(this).val().trim();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-score-threshold').on('input', function () {
        const val = parseFloat($(this).val());
        if (!isNaN(val)) { getSettings().ragScoreThreshold = Math.min(1, Math.max(0, val)); saveSettingsDebounced(); updateDirtyIndicator(); }
    });

    $('#cnz-set-rag-retrieval-topk').on('input', function () {
        getSettings().ragRetrievalTopK = Math.max(0, parseInt($(this).val()) || 5);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-lb-retrieval-topk').on('input', function () {
        getSettings().ragLbRetrievalTopK = Math.max(0, parseInt($(this).val()) || 3);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-injection-template').on('click', () =>
        openPromptModal('ragInjectionTemplate', 'Edit Injection Template', DEFAULT_RAG_INJECTION_TEMPLATE, ['text']));

    $('#cnz-edit-chunk-template').on('click', () =>
        openPromptModal('ragChunkTemplate', 'Edit Chunk Template', DEFAULT_RAG_CHUNK_TEMPLATE, ['text', 'turn_range', 'header', 'char_name']));

    // ── Embedding model browser ───────────────────────────────────────────────
    $('#cnz-browse-embedding-model').on('click', async function () {
        const source = getSettings().ragEmbeddingSource ?? 'openrouter';
        if (source !== 'openrouter') {
            _renderEmbedModelList(OPENAI_EMBED_MODELS, false, false);
            return;
        }
        const $btn = $(this);
        const orig = $btn.html();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
        try {
            if (!_orModelCache) {
                const [embResp, allResp] = await Promise.all([
                    fetch('https://openrouter.ai/api/v1/models?output_modalities=embeddings'),
                    fetch('https://openrouter.ai/api/v1/models'),
                ]);
                const toEntry = m => ({ id: m.id, label: m.name ? `${m.id} — ${m.name}` : m.id });
                const embModels = embResp.ok ? ((await embResp.json()).data ?? []).map(toEntry) : [];
                const allModels = allResp.ok ? ((await allResp.json()).data ?? []).map(toEntry) : [];
                const embIds = new Set(embModels.map(m => m.id));
                _orModelCache = {
                    embeddings: embModels,
                    all: [...embModels, ...allModels.filter(m => !embIds.has(m.id))],
                };
            }
            const { embeddings, all } = _orModelCache;
            _renderEmbedModelList(embeddings.length ? embeddings : all, !embeddings.length, true);
        } catch (err) {
            error('Settings', 'OpenRouter model list fetch failed:', err);
            toastr.error(`Could not fetch model list: ${err?.message || err}`);
        } finally {
            $btn.prop('disabled', false).html(orig);
        }
    });

    $('#cnz-embedding-model-list').on('change', function () {
        const val = String($(this).val() || '').trim();
        if (val === '__toggle__') {
            if (!_orModelCache) return;
            const nowShowingAll = !$(this).data('showing-all');
            _renderEmbedModelList(
                nowShowingAll ? _orModelCache.all : _orModelCache.embeddings,
                nowShowingAll, true,
            );
            return;
        }
        if (val) $('#cnz-set-embedding-model').val(val).trigger('input');
        $(this).addClass('cnz-hidden');
    });
}

export function updateRagAiControlsVisibility() {
    _updateRagAiControlsVisibility();
}

function _updateRagAiControlsVisibility() {
    const s = getSettings();
    const hasSummary    = (s.ragContents ?? 'summary+full') !== 'full';
    const isDefinedHere = (s.ragSummarySource ?? 'defined') === 'defined';
    $('#cnz-rag-ai-controls').toggleClass('cnz-disabled', !(hasSummary && isDefinedHere));
}
