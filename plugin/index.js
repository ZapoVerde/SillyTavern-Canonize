/**
 * @file plugins/cnz/index.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @architectural-role Orchestrator — ST server plugin entry point
 * @description
 * SillyTavern server plugin for CNZ. Initialises the embedded PGlite database
 * on startup and registers all CNZ vector store routes directly on the ST plugin
 * router. Injects the OpenRouter API key from ST's secrets store into each
 * request body before the route handlers run, so the extension never needs a
 * separate key. Exposes a /inspect endpoint returning live DB stats.
 *
 * Replaces the old two-container approach (cnz-db microservice + proxy plugin).
 * No external Docker service, no compose dependency, no Traefik routing needed.
 *
 * @api-declaration
 * init(router) → Promise<void>   (called by ST on plugin load)
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none — DB state owned by db.js]
 *     external_io:     [db.js, routes.js, ST secrets store]
 */

import { readSecret, SECRET_KEYS } from '../../src/endpoints/secrets.js';
import { initDb, chunkCountForAvatar, lbEntryCountForAvatar } from './db.js';
import { registerRoutes } from './routes.js';

const SOURCE_SECRET = {
    openrouter: SECRET_KEYS.OPENROUTER,
    openai:     SECRET_KEYS.OPENAI,
};

export const info = {
    id:          'cnz',
    name:        'Canonize Plugin',
    description: 'Embedded vector store for CNZ — PGlite + pgvector, no separate container.',
};

export async function init(router) {
    await initDb();

    // Inject embedding API key from ST secrets before any route handler sees the body.
    router.use((req, res, next) => {
        if (req.method !== 'GET' && req.body?.embeddingSource && !req.body.embeddingApiKey) {
            const secretKey = SOURCE_SECRET[req.body.embeddingSource];
            if (secretKey) {
                const apiKey = readSecret(req.user?.directories, secretKey);
                if (apiKey) req.body = { ...req.body, embeddingApiKey: apiKey };
            }
        }
        next();
    });

    registerRoutes(router);

    // ── GET /inspect — live DB stats ──────────────────────────────────────────
    router.get('/inspect', async (req, res) => {
        try {
            const { avatarKey } = req.query;
            const stats = { status: 'ok' };
            if (avatarKey) {
                stats.chunks   = await chunkCountForAvatar(String(avatarKey));
                stats.lbEntries = await lbEntryCountForAvatar(String(avatarKey));
            }
            return res.json(stats);
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    });

    console.log('[cnz] Plugin ready — embedded PGlite DB, no external service required.');
}
