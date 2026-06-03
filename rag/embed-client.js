/**
 * @file data/default-user/extensions/canonize/rag/embed-client.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — embedding generation via the CNZ plugin proxy
 * @description
 * Calls the minimal CNZ plugin's /embed endpoint to generate embeddings using
 * ST's own vector modules and secrets store. API keys never leave the server.
 *
 * Owns progress tracking for large batch operations: emits EMBED_PROGRESS on
 * the CNZ bus after each batch call so lifecycle.js can show a toast.
 * Handles retry (up to MAX_RETRIES) with linear backoff.
 *
 * Also owns testEmbed() and fetchAiStudioModels(), migrated from vec-store.js.
 *
 * @api-declaration
 * embedCfg()                              → EmbedCfg
 * embedText(cfg, text, signal?)            → Promise<number[]>
 * embedBatch(cfg, texts)                  → Promise<number[][]>
 * testEmbed(cfg)                          → Promise<{ ok, dim, nonZero, ms }>
 * fetchAiStudioModels()                   → Promise<{ models: {id,displayName}[] }>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_total, _done]
 *     external_io:     [POST /api/plugins/cnz/embed,
 *                       POST /api/plugins/cnz/test-embed,
 *                       GET  /api/plugins/cnz/aistudio-models,
 *                       textgenerationwebui_settings, oai_settings]
 */

import { getRequestHeaders }                           from '../../../../../script.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings }                                from '../../../../openai.js';
import { getSettings }                                 from '../core/settings.js';
import { emit, BUS_EVENTS }                            from '../bus.js';
import { log }                                         from '../log.js';

const BASE        = '/api/plugins/cnz';
const BATCH_SIZE  = 5;
const MAX_RETRIES = 3;
const RETRY_MS    = 1000;

const URL_SOURCES = {
    ollama:   textgen_types.OLLAMA,
    vllm:     textgen_types.VLLM,
    llamacpp: textgen_types.LLAMACPP,
};

let _total = 0;
let _done  = 0;

// ── Embed config ──────────────────────────────────────────────────────────────

/**
 * Builds the embedding config from current CNZ settings.
 * Matches the shape the plugin's embed-proxy expects.
 */
export function embedCfg() {
    const s      = getSettings();
    const source = s.ragEmbeddingSource ?? 'openrouter';
    const cfg    = { source, model: s.ragEmbeddingModel ?? '' };

    if (URL_SOURCES[source])
        cfg.apiUrl = textgenerationwebui_settings.server_urls[URL_SOURCES[source]] ?? '';

    if (source === 'workers_ai') {
        const accountId = (oai_settings.workers_ai_account_id ?? '').trim();
        if (accountId)
            cfg.urlOverride = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
    }

    log('EmbedClient', `cfg source=${cfg.source} model=${cfg.model || '(unset)'}`);
    return cfg;
}

// ── Loggeryze reporting ───────────────────────────────────────────────────────

function _reportUsage(textLength, model) {
    if (!model) return;
    window.loggeryze?.reportBgUsage({
        prompt_tokens:     Math.ceil(textLength / 4),
        completion_tokens: 0,
        _lgz_model:        model.toLowerCase().replace(/:[\w-]+$/, ''),
        _lgz_ext:          'CNZ',
    });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function _post(path, body, signal) {
    const res = await fetch(`${BASE}${path}`, {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`CNZ embed ${path}: ${err.error ?? res.statusText}`);
    }
    return res.json();
}

async function _get(path, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = qs ? `${BASE}${path}?${qs}` : `${BASE}${path}`;
    const res = await fetch(url, { headers: getRequestHeaders() });
    if (!res.ok) throw new Error(`CNZ embed GET ${path}: ${res.statusText}`);
    return res.json();
}

// ── Core embed with retry ─────────────────────────────────────────────────────

async function _embedWithRetry(cfg, texts, signal) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { embeddings } = await _post('/embed', { texts, ...cfg }, signal);
            return embeddings;
        } catch (err) {
            if (attempt >= MAX_RETRIES) throw err;
            log('EmbedClient', `attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${RETRY_MS * attempt}ms: ${err.message}`);
            await new Promise(r => setTimeout(r, RETRY_MS * attempt));
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embeds a single text string. Used for generation-time queries.
 * @param {object} cfg   From embedCfg()
 * @param {string}      text
 * @param {AbortSignal} [signal]
 * @returns {Promise<number[]>}
 */
export async function embedText(cfg, text, signal) {
    const [embedding] = await _embedWithRetry(cfg, [text], signal);
    _reportUsage(text.length, cfg.model);
    return embedding;
}

/**
 * Embeds an array of strings in serial BATCH_SIZE chunks.
 * Emits EMBED_PROGRESS on the bus after each batch.
 * @param {object}   cfg   From embedCfg()
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedBatch(cfg, texts) {
    if (!texts.length) return [];

    _total += texts.length;
    emit(BUS_EVENTS.EMBED_PROGRESS, { total: _total, done: _done });

    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch      = texts.slice(i, i + BATCH_SIZE);
        const embeddings = await _embedWithRetry(cfg, batch);
        results.push(...embeddings);
        _done += batch.length;
        emit(BUS_EVENTS.EMBED_PROGRESS, { total: _total, done: _done });
    }

    _reportUsage(texts.reduce((s, t) => s + t.length, 0), cfg.model);

    if (_done >= _total) { _total = 0; _done = 0; }
    return results;
}

/**
 * Sends a test string through the embedding pipeline and returns diagnostics.
 * @param {object} cfg   From embedCfg()
 */
export async function testEmbed(cfg) {
    return _post('/test-embed', cfg);
}

/**
 * Fetches the list of available Google AI Studio embedding models.
 */
export async function fetchAiStudioModels() {
    return _get('/aistudio-models');
}
