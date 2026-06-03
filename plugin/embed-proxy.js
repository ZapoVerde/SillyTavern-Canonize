/**
 * @file plugins/cnz/embed-proxy.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role IO Wrapper — thin embed route using ST's own vector modules
 * @description
 * Registers a single POST /embed route that accepts a batch of texts, dispatches
 * to the embedding provider configured by the caller, and returns raw float-array
 * vectors. All provider auth happens via ST's own secrets store — no API keys
 * are ever sent from the browser.
 *
 * Batching, retry, and progress tracking are the caller's responsibility.
 * This module does one thing: text → embeddings.
 *
 * @api-declaration
 * registerEmbedRoute(router) → void
 *
 * POST /embed
 *   Request:  { texts: string[], source: string, model: string,
 *               apiUrl?: string, keep?: boolean, urlOverride?: string }
 *   Response: { embeddings: number[][] }
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [ST vector modules — openai-vectors, ollama-vectors, etc.]
 */

import { fileURLToPath } from 'url';
import path              from 'path';
import fs                from 'fs';

function _findStRoot() {
    let dir = path.dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
        if (fs.existsSync(path.join(dir, 'src', 'vectors', 'openai-vectors.js'))) return dir;
        dir = path.dirname(dir);
    }
    throw new Error(`[CNZ] Cannot locate ST root from ${path.dirname(fileURLToPath(import.meta.url))}`);
}

const _stRoot = _findStRoot();
const _stVec  = path.join(_stRoot, 'src', 'vectors');

const { getOpenAIBatchVector }                               = await import(`${_stVec}/openai-vectors.js`);
const { getOllamaBatchVector }                               = await import(`${_stVec}/ollama-vectors.js`);
const { getVllmBatchVector }                                 = await import(`${_stVec}/vllm-vectors.js`);
const { getLlamaCppBatchVector }                             = await import(`${_stVec}/llamacpp-vectors.js`);
const { getTransformersBatchVector }                         = await import(`${_stVec}/embedding.js`);
const { getCohereBatchVector }                               = await import(`${_stVec}/cohere-vectors.js`);
const { getNomicAIBatchVector }                              = await import(`${_stVec}/nomicai-vectors.js`);
const { getMakerSuiteBatchVector, getVertexBatchVector }     = await import(`${_stVec}/google-vectors.js`);
const { readSecret, SECRET_KEYS }                            = await import(`${_stRoot}/src/endpoints/secrets.js`);

const OPENAI_COMPAT = new Set([
    'openrouter', 'openai', 'mistral', 'togetherai', 'electronhub',
    'chutes', 'nanogpt', 'siliconflow', 'workers_ai', 'voyageai',
]);

/** @param {import('express').Router} router */
export function registerEmbedRoute(router) {
    router.post('/embed', async (req, res) => {
        try {
            const { texts, source, model = '', apiUrl = '', keep = false, urlOverride = null } = req.body;

            if (!Array.isArray(texts) || !texts.length || !source) {
                return res.status(400).json({ error: 'texts (array) and source are required' });
            }

            const dirs = req.user.directories;
            let embeddings;

            if (OPENAI_COMPAT.has(source)) {
                embeddings = await getOpenAIBatchVector(texts, source, dirs, model, urlOverride ?? null);
            } else {
                switch (source) {
                    case 'ollama':
                        embeddings = await getOllamaBatchVector(texts, apiUrl, model, keep, dirs);
                        break;
                    case 'vllm':
                        embeddings = await getVllmBatchVector(texts, apiUrl, model, dirs);
                        break;
                    case 'llamacpp':
                        embeddings = await getLlamaCppBatchVector(texts, apiUrl, dirs);
                        break;
                    case 'transformers':
                        embeddings = await getTransformersBatchVector(texts);
                        break;
                    case 'cohere':
                        embeddings = await getCohereBatchVector(texts, false, dirs, model);
                        break;
                    case 'nomicai':
                        embeddings = await getNomicAIBatchVector(texts, source, dirs);
                        break;
                    case 'aistudio':
                    case 'palm':
                        embeddings = await getMakerSuiteBatchVector(texts, model, req);
                        break;
                    case 'vertexai':
                        embeddings = await getVertexBatchVector(texts, model, req);
                        break;
                    default:
                        return res.status(400).json({ error: `Unsupported embedding source: ${source}` });
                }
            }

            return res.json({ embeddings });
        } catch (err) {
            console.error('[cnz] embed:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    router.post('/test-embed', async (req, res) => {
        try {
            const { source, model = '', apiUrl = '', keep = false, urlOverride = null } = req.body;
            if (!source) return res.status(400).json({ error: 'source is required' });

            const start = Date.now();
            const dirs  = req.user.directories;
            let embeddings;

            const TEST_TEXT = 'The quick brown fox jumps over the lazy dog.';
            if (OPENAI_COMPAT.has(source)) {
                embeddings = await getOpenAIBatchVector([TEST_TEXT], source, dirs, model, urlOverride ?? null);
            } else {
                switch (source) {
                    case 'ollama':       embeddings = await getOllamaBatchVector([TEST_TEXT], apiUrl, model, keep, dirs); break;
                    case 'vllm':         embeddings = await getVllmBatchVector([TEST_TEXT], apiUrl, model, dirs); break;
                    case 'llamacpp':     embeddings = await getLlamaCppBatchVector([TEST_TEXT], apiUrl, dirs); break;
                    case 'transformers': embeddings = await getTransformersBatchVector([TEST_TEXT]); break;
                    case 'cohere':       embeddings = await getCohereBatchVector([TEST_TEXT], false, dirs, model); break;
                    case 'nomicai':      embeddings = await getNomicAIBatchVector([TEST_TEXT], source, dirs); break;
                    case 'aistudio':
                    case 'palm':         embeddings = await getMakerSuiteBatchVector([TEST_TEXT], model, req); break;
                    case 'vertexai':     embeddings = await getVertexBatchVector([TEST_TEXT], model, req); break;
                    default: return res.status(400).json({ error: `Unsupported source: ${source}` });
                }
            }

            const vec = embeddings[0];
            return res.json({ ok: true, dim: vec.length, nonZero: vec.filter(v => v !== 0).length, ms: Date.now() - start });
        } catch (err) {
            console.error('[cnz] test-embed:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });

    router.get('/aistudio-models', async (req, res) => {
        try {
            const apiKey = readSecret(req.user.directories, SECRET_KEYS.MAKERSUITE);
            if (!apiKey) return res.status(400).json({ error: 'Google AI Studio API key not configured in ST.' });
            const url  = `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(apiKey)}`;
            const resp = await fetch(url);
            if (!resp.ok) {
                const text = await resp.text();
                return res.status(resp.status).json({ error: `Google AI error ${resp.status}: ${text}` });
            }
            const data   = await resp.json();
            const models = (data.models ?? [])
                .filter(m => (m.supportedGenerationMethods ?? []).includes('embedContent'))
                .map(m => ({ id: m.name.replace(/^models\//, ''), displayName: m.displayName ?? '' }));
            return res.json({ models });
        } catch (err) {
            console.error('[cnz] aistudio-models:', err.message);
            return res.status(500).json({ error: err.message });
        }
    });
}
