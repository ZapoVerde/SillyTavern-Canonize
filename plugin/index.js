/**
 * @file plugins/cnz/index.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Orchestrator — ST server plugin entry point
 * @description
 * Minimal SillyTavern server plugin for CNZ. Registers the embed proxy route
 * so the extension can generate embeddings using ST's own vector modules and
 * secrets store. All vector storage, similarity search, and FTS happen
 * client-side in the extension — this plugin is a thin auth proxy only.
 *
 * No database. No npm install. No external dependencies.
 * Installation: copy this folder to [ST]/plugins/cnz/ and restart ST.
 *
 * @api-declaration
 * init(router) → Promise<void>   (called by ST on plugin load)
 *
 * Routes registered:
 * POST /embed           → { embeddings: number[][] }
 * POST /test-embed      → { ok, dim, nonZero, ms }
 * GET  /aistudio-models → { models: {id, displayName}[] }
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [embed-proxy.js]
 */

import { registerEmbedRoute } from './embed-proxy.js';

export const info = {
    id:          'cnz',
    name:        'Canonize Plugin',
    description: 'Embed proxy for CNZ — routes embedding calls through ST\'s own vector modules and secrets store.',
};

export async function init(router) {
    registerEmbedRoute(router);
    console.log('[cnz] Plugin ready — embed proxy active, no local DB.');
}
