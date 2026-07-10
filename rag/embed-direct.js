/**
 * @file data/default-user/extensions/canonize/rag/embed-direct.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role IO Wrapper — direct embedding API calls using ST's stored secrets
 * @description
 * Calls the configured embedding provider directly from the browser, bypassing
 * ST's /api/vector/* proxy. ST retains ownership of secrets: the key is read at
 * call time via findSecret() (requires allowKeysExposure: true in config.yaml)
 * and never stored or forwarded by CNZ.
 *
 * Covers all OpenAI-compatible cloud providers and local providers in CNZ's
 * source dropdown. Google (aistudio/palm/vertexai) and Transformers (in-browser)
 * are not supported; those sources should not be selected when using CNZ.
 *
 * Returns normalised Float32Arrays so callers can use dot() as cosine similarity.
 *
 * @api-declaration
 * embedText(text, cfg, isQuery?, signal?)      → Promise<Float32Array>   single embed
 * embedBatch(texts, cfg, isQuery?, signal?)    → Promise<Float32Array[]>  batch embed
 * testEmbedDirect(cfg)                         → Promise<{ ok, ms }>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [/api/secrets/find, embedding provider HTTPS endpoints]
 */

import { findSecret } from '../../../../../scripts/secrets.js';
import { normalize }  from './vec-math.js';
import { log }        from '../log.js';

// ── Provider table ────────────────────────────────────────────────────────────
// Each entry describes how to reach the embedding endpoint.
//   secretKey   — ST SECRET_KEYS value; null for local/no-auth providers
//   url         — base URL (before /embeddings); null means derived at runtime
//   extraHeaders — additional headers beyond Authorization
//   inputType   — provider supports input_type: 'document'/'query' (VoyageAI)
//   cohere      — uses Cohere v2 embed format instead of OpenAI
//   nomicai     — uses NomicAI atlas format instead of OpenAI
//   local       — URL comes from cfg.apiUrl; no secret key needed
//   chutes      — URL is built from model name

const PROVIDERS = {
    openrouter:  { secretKey: 'api_key_openrouter',  url: 'https://openrouter.ai/api/v1',
                   extraHeaders: { 'HTTP-Referer': 'https://github.com/SillyTavern/SillyTavern',
                                   'X-Title': 'SillyTavern' } },
    openai:      { secretKey: 'api_key_openai',      url: 'https://api.openai.com/v1' },
    mistral:     { secretKey: 'api_key_mistralai',   url: 'https://api.mistral.ai/v1' },
    togetherai:  { secretKey: 'api_key_togetherai',  url: 'https://api.together.xyz/v1' },
    electronhub: { secretKey: 'api_key_electronhub', url: 'https://api.electronhub.ai/v1' },
    nanogpt:     { secretKey: 'api_key_nanogpt',     url: 'https://nano-gpt.com/api/v1' },
    siliconflow: { secretKey: 'api_key_siliconflow', url: 'https://api.siliconflow.com/v1' },
    voyageai:    { secretKey: 'api_key_voyageai',    url: 'https://api.voyageai.com/v1',
                   inputType: true },
    workers_ai:  { secretKey: 'api_key_workers_ai',  url: null }, // cfg.urlOverride
    chutes:      { secretKey: 'api_key_chutes',      url: null, chutes: true },
    cohere:      { secretKey: 'api_key_cohere',      url: 'https://api.cohere.ai', cohere: true },
    nomicai:     { secretKey: 'api_key_nomicai',     url: 'https://api-atlas.nomic.ai', nomicai: true },
    // Local providers — URL from cfg.apiUrl, no key required
    ollama:      { local: true },
    llamacpp:    { local: true },
    vllm:        { local: true },
};

const UNSUPPORTED = new Set(['aistudio', 'palm', 'vertexai', 'transformers', 'extras']);

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Strips a trailing slash and/or trailing /v1 so a base URL can be safely
 * re-joined with '/v1/embeddings'. Mirrors ST core's trimV1() (src/util.js)
 * so local-provider URLs behave the same whether or not the user typed /v1.
 */
function _trimV1(url) {
    return url.replace(/\/+$/, '').replace(/\/v1$/, '');
}

async function _key(secretKey) {
    const val = await findSecret(secretKey);
    if (!val) throw new Error(
        `CNZ embed-direct: no key for "${secretKey}". ` +
        'Set allowKeysExposure: true in config.yaml and reload ST.'
    );
    return val;
}

/**
 * OpenAI-compatible batch embed. Returns number[][] in input order.
 */
async function _openAI(texts, key, url, model, extraHeaders, inputType, isQuery, signal) {
    const body = { model, input: texts };
    if (inputType) body.input_type = isQuery ? 'query' : 'document';

    const res = await fetch(`${url}/embeddings`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json',
                   'Authorization': `Bearer ${key}`,
                   ...(extraHeaders ?? {}) },
        body:    JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`CNZ embed-direct [${url}]: ${res.status} ${txt}`);
    }
    const json = await res.json();
    // OpenAI response: { data: [{ index, embedding }] } — sort by index for safety
    return json.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding);
}

/**
 * Cohere v2 batch embed.
 */
async function _cohere(texts, key, model, isQuery, signal) {
    const body = {
        model,
        texts,
        input_type:       isQuery ? 'search_query' : 'search_document',
        embedding_types:  ['float'],
    };
    const res = await fetch('https://api.cohere.ai/v2/embed', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body:    JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`CNZ embed-direct [cohere]: ${res.status} ${txt}`);
    }
    const json = await res.json();
    return json.embeddings.float; // number[][]
}

/**
 * NomicAI atlas batch embed.
 */
async function _nomicai(texts, key, model, isQuery, signal) {
    const body = {
        model,
        texts,
        task_type: isQuery ? 'search_query' : 'search_document',
    };
    const res = await fetch('https://api-atlas.nomic.ai/v1/embedding/text', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body:    JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const txt = await res.text().catch(() => res.statusText);
        throw new Error(`CNZ embed-direct [nomicai]: ${res.status} ${txt}`);
    }
    const json = await res.json();
    return json.embeddings; // number[][]
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embeds a batch of texts using the configured provider. Returns normalised
 * Float32Arrays in input order.
 *
 * @param {string[]}    texts
 * @param {object}      cfg        From embedCfg()
 * @param {boolean}     [isQuery]  true for query-time embeds; affects input_type on supporting providers
 * @param {AbortSignal} [signal]
 * @returns {Promise<Float32Array[]>}
 */
export async function embedBatch(texts, cfg, isQuery = false, signal) {
    if (!texts.length) return [];

    const source = cfg.source;
    if (UNSUPPORTED.has(source))
        throw new Error(`CNZ embed-direct: source "${source}" is not supported for direct embedding.`);

    const prov  = PROVIDERS[source];
    if (!prov)
        throw new Error(`CNZ embed-direct: unknown source "${source}".`);

    const model = cfg.model || '';
    let vecs;

    if (prov.local) {
        const raw = cfg.apiUrl?.replace(/\/+$/, '');
        if (!raw) throw new Error(`CNZ embed-direct: no apiUrl configured for local source "${source}".`);
        const url = `${_trimV1(raw)}/v1`;
        vecs = await _openAI(texts, '', url, model, null, false, isQuery, signal);
    } else if (prov.chutes) {
        const key = await _key(prov.secretKey);
        const url = `https://${model}.chutes.ai/v1`;
        // Chutes: model field is null in the body (the model is the subdomain)
        vecs = await _openAI(texts, key, url, null, null, false, isQuery, signal);
    } else if (prov.cohere) {
        const key = await _key(prov.secretKey);
        vecs = await _cohere(texts, key, model, isQuery, signal);
    } else if (prov.nomicai) {
        const key = await _key(prov.secretKey);
        vecs = await _nomicai(texts, key, model, isQuery, signal);
    } else {
        const key = await _key(prov.secretKey);
        const url = (prov.url === null ? cfg.urlOverride : prov.url)?.replace(/\/+$/, '');
        if (!url) throw new Error(`CNZ embed-direct: no URL for source "${source}".`);
        vecs = await _openAI(texts, key, url, model, prov.extraHeaders, prov.inputType ?? false, isQuery, signal);
    }

    log('EmbedDirect', `${source} embedded ${texts.length} texts (isQuery=${isQuery})`);
    return vecs.map(v => normalize(new Float32Array(v)));
}

/**
 * Embeds a single text. Thin wrapper over embedBatch.
 *
 * @param {string}      text
 * @param {object}      cfg
 * @param {boolean}     [isQuery]
 * @param {AbortSignal} [signal]
 * @returns {Promise<Float32Array>}
 */
export async function embedText(text, cfg, isQuery = false, signal) {
    const [vec] = await embedBatch([text], cfg, isQuery, signal);
    return vec;
}

/**
 * Smoke test: embeds a sentinel string and measures round-trip time.
 * @param {object} cfg  From embedCfg()
 * @returns {Promise<{ ok: boolean, ms: number }>}
 */
export async function testEmbedDirect(cfg) {
    const t0 = Date.now();
    await embedText('The quick brown fox jumps over the lazy dog.', cfg, false);
    return { ok: true, ms: Date.now() - t0 };
}
