/**
 * @file data/default-user/extensions/canonize/rag/embed-client.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — vector store proxy via ST's built-in /api/vector/* endpoints
 * @description
 * Calls ST's own vector endpoints for all embedding and retrieval operations.
 * ST's server handles API key auth via its secrets store — no key ever touches
 * the browser. Pattern identical to Vistalyze's use of /api/sd/* endpoints.
 *
 * Collection naming: cnz_chunks_{avatarKey}, cnz_headers_{avatarKey}, cnz_lb_{avatarKey}
 *
 * @api-declaration
 * embedCfg()                                         → EmbedCfg
 * insertItems(collectionId, items, cfg)               → Promise<void>
 * queryItems(collectionId, searchText, topK, cfg, signal?) → Promise<QueryResult>
 * listHashes(collectionId, cfg)                       → Promise<number[]>
 * deleteItems(collectionId, hashes, cfg)              → Promise<void>
 * purgeCollection(collectionId)                       → Promise<void>
 * testEmbed(cfg)                                      → Promise<{ ok, ms }>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [POST /api/vector/insert, POST /api/vector/query,
 *                       POST /api/vector/list,   POST /api/vector/delete,
 *                       POST /api/vector/purge,
 *                       textgenerationwebui_settings, oai_settings]
 */

import { getRequestHeaders }                           from '../../../../../script.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings }                                from '../../../../openai.js';
import { getSettings }                                 from '../core/settings.js';
import { log }                                         from '../log.js';

const BASE = '/api/vector';

const URL_SOURCES = {
    ollama:   textgen_types.OLLAMA,
    vllm:     textgen_types.VLLM,
    llamacpp: textgen_types.LLAMACPP,
};

// ── Embed config ──────────────────────────────────────────────────────────────

/**
 * Builds the params block included in every /api/vector/* request body.
 * ST's server reads source/model/apiUrl and looks up the API key itself.
 */
export function embedCfg() {
    const s      = getSettings();
    const source = s.ragEmbeddingSource ?? 'openrouter';
    const cfg    = { source, model: s.ragEmbeddingModel ?? '' };

    if (URL_SOURCES[source])
        cfg.apiUrl = textgenerationwebui_settings.server_urls[URL_SOURCES[source]] ?? '';

    if (source === 'workers_ai') {
        const accountId = (oai_settings.workers_ai_account_id ?? '').trim();
        if (accountId) cfg.workers_ai_account_id = accountId;
    }

    log('EmbedClient', `cfg source=${cfg.source} model=${cfg.model || '(unset)'}`);
    return cfg;
}

// ── Loggeryze reporting ───────────────────────────────────────────────────────

export function reportEmbedUsage(textLength, model) {
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
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`CNZ vec-api ${path}: ${text}`);
    }
    const ct = res.headers.get('content-type') ?? '';
    return ct.includes('application/json') ? res.json() : null;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embeds and stores items in a Vectra collection. ST handles the embedding call.
 * @param {string}   collectionId
 * @param {{ hash: number, text: string, index?: number }[]} items
 * @param {object}   cfg   From embedCfg()
 * @param {AbortSignal} [signal]
 */
export async function insertItems(collectionId, items, cfg, signal) {
    await _post('/insert', { collectionId, items, ...cfg }, signal);
}

/**
 * Queries a Vectra collection by semantic similarity.
 * Returns items in descending score order — position is the rank for RRF.
 * @param {string}   collectionId
 * @param {string}   searchText
 * @param {number}   topK
 * @param {object}   cfg   From embedCfg()
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ metadata: {hash:number, text:string}[], hashes: number[] }>}
 */
export async function queryItems(collectionId, searchText, topK, cfg, signal) {
    return _post('/query', { collectionId, searchText, topK, threshold: 0, ...cfg }, signal);
}

/**
 * Returns all hashes stored in a collection for a given source.
 * @param {string} collectionId
 * @param {object} cfg
 * @returns {Promise<number[]>}
 */
export async function listHashes(collectionId, cfg) {
    return _post('/list', { collectionId, ...cfg });
}

/**
 * Deletes specific items from a collection by hash.
 * @param {string}   collectionId
 * @param {number[]} hashes
 * @param {object}   cfg
 */
export async function deleteItems(collectionId, hashes, cfg) {
    await _post('/delete', { collectionId, hashes, ...cfg });
}

/**
 * Deletes an entire collection across all sources. Used for character purge.
 * @param {string} collectionId
 */
export async function purgeCollection(collectionId) {
    await _post('/purge', { collectionId });
}

/**
 * Inserts a sentinel item, measures round-trip time, then purges the test collection.
 * @param {object} cfg   From embedCfg()
 * @returns {Promise<{ ok: boolean, ms: number }>}
 */
export async function testEmbed(cfg) {
    const collectionId = `cnz_test_${Date.now()}`;
    const t0 = Date.now();
    await insertItems(collectionId, [{ hash: -1, text: 'The quick brown fox jumps over the lazy dog.', index: 0 }], cfg);
    const ms = Date.now() - t0;
    await purgeCollection(collectionId).catch(() => {});
    return { ok: true, ms };
}
