/**
 * @file plugins/cnz/embed.js
 * @stamp {"utc":"2026-05-23T00:00:00.000Z"}
 * @architectural-role IO Wrapper — OpenRouter embedding API
 * @description
 * Generates embeddings via OpenRouter's OpenAI-compatible embeddings endpoint.
 * All calls share a priority semaphore (MAX_CONCURRENT slots). Single-text calls
 * (generation queries, time-critical) run at priority 1 and jump ahead of batch
 * calls (healer indexing, background) at priority 0. This prevents the healer
 * from saturating OpenRouter and blocking generation while mid-index on large
 * chats. Batch calls are staggered by STAGGER_MS between launches to avoid
 * thundering-herd bursts while still running at high concurrency. Failed batches
 * retry up to MAX_RETRIES times with linear backoff; the semaphore slot is
 * released between attempts so other calls can proceed.
 *
 * @api-declaration
 * embedWithSource(cfg, text)        → Promise<number[]>   priority 1 (generation)
 * embedBatchWithSource(cfg, texts)  → Promise<number[][]> priority 0 (indexing)
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_running, _waiters]
 *     external_io:     [openrouter.ai/api/v1/embeddings]
 */

const OR_BASE        = 'https://openrouter.ai/api/v1/embeddings';
const BATCH_SIZE     = 10;
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

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function _sendOnce(model, apiKey, inputs) {
    const res = await fetch(OR_BASE, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, input: inputs }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`OpenRouter embed error (${res.status}): ${err.error ?? res.statusText}`);
    }
    const data = await res.json();
    return data.data.sort((a, b) => a.index - b.index).map(d => d.embedding);
}

async function _sendBatch(model, apiKey, inputs, priority) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        await _acquire(priority);
        try {
            return await _sendOnce(model, apiKey, inputs);
        } catch (err) {
            if (attempt >= MAX_RETRIES) {
                console.error(`[cnz embed] batch of ${inputs.length} failed after ${MAX_RETRIES} attempts:`, err.message);
                throw err;
            }
            const wait = RETRY_MS * attempt;
            console.warn(`[cnz embed] attempt ${attempt}/${MAX_RETRIES} failed — retrying in ${wait}ms:`, err.message);
            await sleep(wait);
        } finally {
            _release();
        }
    }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Embed a single string at high priority (generation queries).
 * @param {{ source: string, model: string, apiKey: string }} cfg
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedWithSource(cfg, text) {
    if (cfg.source === 'openrouter' && cfg.model && cfg.apiKey) {
        const [embedding] = await _sendBatch(cfg.model, cfg.apiKey, [text], 1);
        return embedding;
    }
    throw new Error('CNZ embed: set embeddingSource to "openrouter" and provide a model and API key in CNZ settings.');
}

/**
 * Embed an array of strings in parallel batches of BATCH_SIZE at normal priority
 * (background indexing). All batches compete for semaphore slots with generation
 * queries; high-priority queries jump the queue when slots are full.
 * @param {{ source: string, model: string, apiKey: string }} cfg
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedBatchWithSource(cfg, texts) {
    if (!texts.length) return [];
    if (!(cfg.source === 'openrouter' && cfg.model && cfg.apiKey))
        throw new Error('CNZ embed: set embeddingSource to "openrouter" and provide a model and API key in CNZ settings.');
    const batches = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) batches.push(texts.slice(i, i + BATCH_SIZE));
    _statsTotal += texts.length;
    _broadcast();
    const results = await Promise.all(
        batches.map((b, i) => sleep(i * STAGGER_MS).then(async () => {
            const r = await _sendBatch(cfg.model, cfg.apiKey, b, 0);
            _statsDone += b.length;
            _broadcast();
            return r;
        }))
    );
    return results.flat();
}
