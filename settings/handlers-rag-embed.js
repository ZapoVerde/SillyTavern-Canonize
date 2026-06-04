/**
 * @file data/default-user/extensions/canonize/settings/handlers-rag-embed.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Embedding source, model selection, and model browser handlers for the RAG
 * settings panel. Extracted from handlers-rag.js to keep both files under the
 * 300-line budget.
 *
 * @api-declaration
 * bindEmbedHandlers({ getSettings, updateDirtyIndicator }) — binds all embed-related controls
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings)]
 *     external_io: [DOM, saveSettingsDebounced, openrouter.ai]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { testEmbed, embedCfg } from '../rag/embed-client.js';
import { log, error } from '../log.js';

const EMBED_KEY_MAP = { voyageai: 'api_key_voyageai', nomicai: 'api_key_nomicai' };

let _orModelCache = null;

const OPENAI_EMBED_MODELS = [
    { id: 'text-embedding-3-large', label: 'text-embedding-3-large' },
    { id: 'text-embedding-3-small', label: 'text-embedding-3-small' },
    { id: 'text-embedding-ada-002',  label: 'text-embedding-ada-002' },
];

const COHERE_EMBED_MODELS = [
    { id: 'embed-english-v3.0',            label: 'embed-english-v3.0' },
    { id: 'embed-multilingual-v3.0',       label: 'embed-multilingual-v3.0' },
    { id: 'embed-english-light-v3.0',      label: 'embed-english-light-v3.0' },
    { id: 'embed-multilingual-light-v3.0', label: 'embed-multilingual-light-v3.0' },
];

const NOMIC_EMBED_MODELS = [
    { id: 'nomic-embed-text-v1',   label: 'nomic-embed-text-v1' },
    { id: 'nomic-embed-text-v1.5', label: 'nomic-embed-text-v1.5' },
];

const MISTRAL_EMBED_MODELS = [
    { id: 'mistral-embed', label: 'mistral-embed' },
];

const VOYAGE_EMBED_MODELS = [
    { id: 'voyage-4-large',        label: 'voyage-4-large' },
    { id: 'voyage-4',              label: 'voyage-4' },
    { id: 'voyage-4-lite',         label: 'voyage-4-lite' },
    { id: 'voyage-4-nano',         label: 'voyage-4-nano' },
    { id: 'voyage-3.5',            label: 'voyage-3.5' },
    { id: 'voyage-3.5-lite',       label: 'voyage-3.5-lite' },
    { id: 'voyage-3-large',        label: 'voyage-3-large' },
    { id: 'voyage-3',              label: 'voyage-3' },
    { id: 'voyage-3-lite',         label: 'voyage-3-lite' },
    { id: 'voyage-code-3',         label: 'voyage-code-3' },
    { id: 'voyage-finance-2',      label: 'voyage-finance-2' },
    { id: 'voyage-law-2',          label: 'voyage-law-2' },
    { id: 'voyage-multilingual-2', label: 'voyage-multilingual-2' },
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

export function bindEmbedHandlers({ getSettings, updateDirtyIndicator }) {

    $('#cnz-set-embedding-source').on('change', function () {
        const src    = $(this).val();
        const apiKey = EMBED_KEY_MAP[src] ?? null;
        getSettings().ragEmbeddingSource = src;
        saveSettingsDebounced(); updateDirtyIndicator();
        $('#cnz-embed-or-note').toggleClass('cnz-hidden', src !== 'openrouter');
        $('#cnz-embed-set-key-row').toggleClass('cnz-hidden', !apiKey);
        if (apiKey) $('#cnz-embed-set-key-btn').attr('data-key', apiKey);
    });

    $('#cnz-set-embedding-model').on('input', function () {
        getSettings().ragEmbeddingModel = $(this).val().trim();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-test-embedding').on('click', async function () {
        const $btn    = $(this);
        const $result = $('#cnz-embed-test-result');
        const s       = getSettings();
        $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
        $result.removeAttr('style').removeClass('cnz-error-inline').text('');
        log('EmbedTest', `source=${s.ragEmbeddingSource ?? 'openrouter'} model=${s.ragEmbeddingModel || '(unset)'}`);
        try {
            const { ok, ms } = await testEmbed(embedCfg());
            log('EmbedTest', `OK ms=${ms}`);
            $result.css('color', 'var(--cnz-btn-success-fg)').text(`OK — ${ms}ms`);
        } catch (err) {
            error('EmbedTest', err.message);
            $result.addClass('cnz-error-inline').text(err.message);
        } finally {
            $btn.prop('disabled', false).text('Test');
        }
    });

    $('#cnz-browse-embedding-model').on('click', async function () {
        const source = getSettings().ragEmbeddingSource ?? 'openrouter';
        if (source === 'openai')   { _renderEmbedModelList(OPENAI_EMBED_MODELS,   false); return; }
        if (source === 'cohere')   { _renderEmbedModelList(COHERE_EMBED_MODELS,   false); return; }
        if (source === 'nomicai')  { _renderEmbedModelList(NOMIC_EMBED_MODELS,    false); return; }
        if (source === 'mistral')  { _renderEmbedModelList(MISTRAL_EMBED_MODELS,  false); return; }
        if (source === 'voyageai') { _renderEmbedModelList(VOYAGE_EMBED_MODELS,   false); return; }
        if (source === 'aistudio' || source === 'palm') {
            _renderEmbedModelList([
                { id: 'text-embedding-005',              label: 'text-embedding-005' },
                { id: 'text-embedding-004',              label: 'text-embedding-004' },
                { id: 'text-multilingual-embedding-002', label: 'text-multilingual-embedding-002' },
                { id: 'gemini-embedding-exp-03-07',      label: 'gemini-embedding-exp-03-07' },
            ], false);
            return;
        }
        if (source !== 'openrouter') {
            toastr.info('No model list available for this provider — enter the model ID manually.');
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
