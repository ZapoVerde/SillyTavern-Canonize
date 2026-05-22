/**
 * @file server-plugin/index.js
 * @description Canonize DB server plugin entry point. Registers with ST's plugin
 * system, initializes SQLite (cnz.db), warms the embedding model, and mounts
 * routes at /api/plugins/cnz/.
 *
 * INSTALLATION (run once after adding or updating the plugin):
 *   cd <ST>/plugins/cnz && npm install
 *
 * To install/update:
 *   cp -r <CNZ_EXT>/server-plugin/. <ST>/plugins/cnz
 *   cd <ST>/plugins/cnz && npm install
 *
 * Ensure enableServerPlugins: true in <ST>/config.yaml.
 */

import { initDb, closeDb } from './db.js';
import { registerRoutes }  from './routes.js';

export const info = {
    id:          'cnz',
    name:        'Canonize DB',
    description: 'SQLite-backed RAG chunk and lorebook vector store for Canonize.',
};

/**
 * @param {import('express').Router} router
 */
export async function init(router) {
    initDb();
    console.log('[CNZ plugin] SQLite DB initialized.');
    registerRoutes(router);
    console.log('[CNZ plugin] Routes registered at /api/plugins/cnz/.');
}

export function exit() {
    closeDb();
}
