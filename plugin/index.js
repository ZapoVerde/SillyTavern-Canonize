/**
 * @file plugins/cnz/index.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @architectural-role Orchestrator — ST server plugin entry point
 * @description
 * SillyTavern server plugin for CNZ. Initialises the embedded PGlite database
 * on startup and registers all CNZ vector store routes on the ST plugin router.
 * Auth and provider dispatch are handled inside embed.js via ST's own vector
 * modules, so no key injection is needed here. Exposes a /inspect endpoint
 * returning live DB stats.
 *
 * Replaces the old two-container approach (cnz-db microservice + proxy plugin).
 * No external Docker service, no compose dependency, no Traefik routing needed.
 *
 * @deployment
 * This file ships inside the Canonize extension at plugin/index.js.
 * Users must copy the entire plugin/ folder to [ST]/plugins/cnz/ and run
 * `npm install` there before restarting SillyTavern. The extension copy and
 * the deployed copy are NOT linked — edit both when making changes here.
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

import { initDb, chunkCountForAvatar, lbEntryCountForAvatar } from './db.js';
import { registerRoutes } from './routes.js';

export const info = {
    id:          'cnz',
    name:        'Canonize Plugin',
    description: 'Embedded vector store for CNZ — PGlite + pgvector, no separate container.',
};

export async function init(router) {
    await initDb();
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
