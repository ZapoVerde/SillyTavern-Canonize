/**
 * @file plugins/cnz/embed.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @architectural-role IO Wrapper — ST-native embedding dispatch
 * @description
 * Generates embeddings by delegating to SillyTavern's own vector modules,
 * giving CNZ access to every embedding provider supported by the Vectorize
 * extension. All calls share a priority semaphore (MAX_CONCURRENT slots).
 * Single-text calls (generation queries) run at priority 1 and jump ahead of
 * batch calls (healer indexing) at priority 0. Batch calls are staggered by
 * STAGGER_MS to avoid thundering-herd bursts. Failed calls retry up to
 * MAX_RETRIES times with linear backoff; the semaphore slot is released
 * between attempts so other calls can proceed.
 *
 * @api-declaration
 * embedWithSource(cfg, text)        → Promise<number[]>   priority 1 (generation)
 * embedBatchWithSource(cfg, texts)  → Promise<number[][]> priority 0 (indexing)
 * getEmbedStats()                   → { total, done, running, waiting }
 * addSseClient(res) / removeSseClient(res)
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_running, _waiters, _statsTotal, _statsDone, _sseClients]
 *     external_io:     [ST vector modules — openai-vectors, ollama-vectors, etc.]
 */

import { fileURLToPath } from 'url';
import path              from 'path';
import fs                from 'fs';

// Static relative imports break when the plugin is loaded via a symlink because
// Node.js resolves import.meta.url to the real file path (after following the symlink),
// making ../../src/vectors/ resolve relative to the extension directory rather than
// the ST root. Walk up from the real location to find ST root dynamically instead.
function _findStRoot() {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'src', 'vectors', 'openai-vectors.js'))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error(`[CNZ embed] Cannot locate ST root from ${path.dirname(fileURLToPath(import.meta.url))}`);
}

const _stVec = path.join(_findStRoot(), 'src', 'vectors');

const { getOpenAIVector, getOpenAIBatchVector }              = await import(`${_stVec}/openai-vectors.js`);
const { getOllamaVector, getOllamaBatchVector }              = await import(`${_stVec}/ollama-vectors.js`);
const { getVllmVector, getVllmBatchVector }                  = await import(`${_stVec}/vllm-vectors.js`);
const { getLlamaCppVector, getLlamaCppBatchVector }          = await import(`${_stVec}/llamacpp-vectors.js`);
const { getTransformersVector, getTransformersBatchVector }  = await import(`${_stVec}/embedding.js`);
const { getCohereVector, getCohereBatchVector }              = await import(`${_stVec}/cohere-vectors.js`);
const { getNomicAIVector, getNomicAIBatchVector }            = await import(`${_stVec}/nomicai-vectors.js`);
const { getMakerSuiteVector, getMakerSuiteBatchVector,
        getVertexVector, getVertexBatchVector }              = await import(`${_stVec}/google-vectors.js`);

const BATCH_SIZE     = 5;
const MAX_CONCURRENT = 20;
const STAGGER_MS     = 50;
const MAX_RETRIES    = 3;
const RETRY_MS       = 1000;

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Priority semaphore ────────────────────────────────────────────────────────

let _running = 0;
const _waiters = []; // [{ resolve, priority }] sorted high→low

let _statsTotal  = 0;
let _statsDone   = 0;
const _sseClients = new Set();

export function getEmbedStats() {
    return { total: _statsTotal, done: _statsDone, running: _running, waiting: _waiters.length };
}

export function addSseClient(res)    { _sseClients.add(res); }
export function removeSseClient(res) { _sseClients.delete(res); }

function _broadcast() {
    if (!_sseClients.size) return;
    const payload = `data: ${JSON.stringify(getEmbedStats())}\n\n`;
    for (const res of _sseClients) {
        try { res.write(payload); } catch { _sseClients.delete(res); }
    }
}

function _acquire(priority) {
    if (_running < MAX_CONCURRENT) { _running++; return Promise.resolve(); }
    return new Promise(resolve => {
        const i = _waiters.findIndex(w => w.priority < priority);
        const waiter = { resolve, priority };
        if (i === -1) _waiters.push(waiter);
        else _waiters.splice(i, 0, waiter);
    });
}

function _release() {
    if (_waiters.length) _waiters.shift().resolve();
    else {
        _running--;
        if (_running === 0 && _waiters.length === 0) { _statsTotal = 0; _statsDone = 0; _broadcast(); }
    }
}

// ── Provider dispatch ─────────────────────────────────────────────────────────

const OPENAI_COMPAT = new Set([
    'openrouter', 'openai', 'mistral', 'togetherai', 'electronhub',
    'chutes', 'nanogpt', 'siliconflow', 'workers_ai',
]);

async function _one(cfg, text) {
    const { source, model, directories, request, apiUrl, keep, urlOverride } = cfg;
    if (OPENAI_COMPAT.has(source))
        return getOpenAIVector(text, source, directories, model, urlOverride ?? null);
    switch (source) {
        case 'ollama':       return getOllamaVector(text, apiUrl, model, keep ?? false, directories);
        case 'vllm':         return getVllmVector(text, apiUrl, model, directories);
        case 'llamacpp':     return getLlamaCppVector(text, apiUrl, directories);
        case 'transformers': return getTransformersVector(text);
        case 'cohere':       return getCohereVector(text, false, directories, model);
        case 'nomicai':      return getNomicAIVector(text, source, directories);
        case 'palm':         return getMakerSuiteVector(text, model, request);
        case 'vertexai':     return getVertexVector(text, model, request);
        default: throw new Error(`CNZ embed: unsupported source "${source}"`);
    }
}

async function _batch(cfg, texts) {
    const { source, model, directories, request, apiUrl, keep, urlOverride } = cfg;
    if (OPENAI_COMPAT.has(source))
        return getOpenAIBatchVector(texts, source, directories, model, urlOverride ?? null);
    switch (source) {
        case 'ollama':       return getOllamaBatchVector(texts, apiUrl, model, keep ?? false, directories);
        case 'vllm':         return getVllmBatchVector(texts, apiUrl, model, directories);
        case 'llamacpp':     return getLlamaCppBatchVector(texts, apiUrl, directories);
        case 'transformers': return getTransformersBatchVector(texts);
        case 'cohere':       return getCohereBatchVector(texts, false, directories, model);
        case 'nomicai':      return getNomicAIBatchVector(texts, source, directories);
        case 'palm':         return getMakerSuiteBatchVector(texts, model, request);
        case 'vertexai':     return getVertexBatchVector(texts, model, request);
        default: throw new Error(`CNZ embed: unsupported source "${source}"`);
    }
}

// ── Retry wrapper ─────────────────────────────────────────────────────────────

async function _embed(cfg, texts, priority) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        await _acquire(priority);
        try {
            return texts.length === 1 ? [await _one(cfg, texts[0])] : await _batch(cfg, texts);
        } catch (err) {
            if (attempt >= MAX_RETRIES) {
                console.error(`[cnz embed] failed after ${MAX_RETRIES} attempts:`, err.message);
                throw err;
            }
            console.warn(`[cnz embed] attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${RETRY_MS * attempt}ms:`, err.message);
            await sleep(RETRY_MS * attempt);
        } finally {
            _release();
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a single string at high priority (generation queries).
 * @param {{ source, model, directories, request, apiUrl?, keep?, urlOverride? }} cfg
 */
export async function embedWithSource(cfg, text) {
    const [embedding] = await _embed(cfg, [text], 1);
    return embedding;
}

/**
 * Embed an array of strings in parallel batches at normal priority (indexing).
 * @param {{ source, model, directories, request, apiUrl?, keep?, urlOverride? }} cfg
 */
export async function embedBatchWithSource(cfg, texts) {
    if (!texts.length) return [];
    const batches = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) batches.push(texts.slice(i, i + BATCH_SIZE));
    _statsTotal += texts.length;
    _broadcast();
    const results = await Promise.all(
        batches.map((b, i) => sleep(i * STAGGER_MS).then(async () => {
            const r = await _embed(cfg, b, 0);
            _statsDone += b.length;
            _broadcast();
            return r;
        }))
    );
    return results.flat();
}
