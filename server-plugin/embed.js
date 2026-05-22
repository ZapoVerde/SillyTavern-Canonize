/**
 * @file server-plugin/embed.js
 * @description Embedding generation via OpenRouter (OpenAI-compatible API).
 * Local @xenova/transformers support has been removed — incompatible with Node v24.
 * Configure embeddingSource: 'openrouter' with a model and apiKey in CNZ settings.
 */

const OR_BASE = 'https://openrouter.ai/api/v1/embeddings';

async function embedRemote(model, apiKey, text) {
    const res = await fetch(OR_BASE, {
        method:  'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, input: text }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`OpenRouter embed error: ${err.error ?? res.statusText}`);
    }
    const data = await res.json();
    return data.data[0].embedding;
}

/**
 * Embed a single string. Requires embeddingSource: 'openrouter' with model + apiKey.
 * @param {{ source: string, model: string, apiKey: string }} cfg
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function embedWithSource(cfg, text) {
    if (cfg.source === 'openrouter' && cfg.model && cfg.apiKey) {
        return embedRemote(cfg.model, cfg.apiKey, text);
    }
    throw new Error('CNZ embed: set embeddingSource to "openrouter" and provide a model and API key in CNZ settings.');
}

/**
 * Embed an array of strings sequentially.
 * @param {{ source: string, model: string, apiKey: string }} cfg
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function embedBatchWithSource(cfg, texts) {
    const result = [];
    for (const t of texts) result.push(await embedWithSource(cfg, t));
    return result;
}

/**
 * Cosine similarity between two equal-length vectors.
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number} score in [-1, 1]
 */
export function cosineSimilarity(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        na  += a[i] * a[i];
        nb  += b[i] * b[i];
    }
    const denom = Math.sqrt(na) * Math.sqrt(nb);
    return denom ? dot / denom : 0;
}
