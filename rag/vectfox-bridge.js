/**
 * @file data/default-user/extensions/canonize/rag/vectfox-bridge.js
 * @architectural-role IO Wrapper
 * @description
 * Pushes completed RAG chunks into a VectFox-managed vector collection instead
 * of uploading a flat document to the ST Data Bank. Activated when
 * settings.useVectFox is true.
 *
 * Dynamically imports VectFox APIs so this file is safe to load even when
 * VectFox is not installed — the error surfaces only when the bridge is called.
 *
 * Collection lifecycle: purge then re-insert on every sync. Canonize rebuilds
 * chunks from scratch each cycle, so incremental updates would require
 * hash-diffing with no meaningful gain.
 *
 * @api-declaration
 * pushChunksToVectFox, checkVectFoxAvailable
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [VectFox extension APIs]
 */

import { getStringHash } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { error, warn } from '../log.js';

const VECTFOX_BASE = '../../VectFox/core';

/**
 * Returns the VectFox collection ID for a given avatar key.
 * @param {string} avatarKey  Sanitized avatar filename (from cnzAvatarKey).
 * @returns {string}
 */
function getCollectionId(avatarKey) {
    return `cnz_${avatarKey}`;
}

/**
 * Dynamically imports the VectFox core APIs needed for insertion.
 * Throws a clear error if VectFox is not installed.
 * @returns {Promise<object>}
 */
async function loadVectFoxApi() {
    try {
        const [coreApi, collectionLoader] = await Promise.all([
            import(`${VECTFOX_BASE}/core-vector-api.js`),
            import(`${VECTFOX_BASE}/collection-loader.js`),
        ]);
        return { ...coreApi, ...collectionLoader };
    } catch (e) {
        throw new Error('VectFox extension not found. Install VectFox alongside Canonize, or disable "Use VectFox for retrieval" in RAG settings.');
    }
}

/**
 * Returns true if VectFox APIs can be imported, false otherwise.
 * Used to warn on settings toggle before the first sync.
 * @returns {Promise<boolean>}
 */
export async function checkVectFoxAvailable() {
    try {
        await loadVectFoxApi();
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Purges the Canonize collection from VectFox and re-inserts all completed
 * chunks from the current sync cycle. Only chunks with status 'complete' or
 * 'manual' are inserted; pending/error chunks are skipped.
 *
 * @param {Array}  ragChunks  state._ragChunks after classifier has settled.
 * @param {string} avatarKey  Sanitized avatar key (from cnzAvatarKey).
 * @returns {Promise<void>}
 */
export async function pushChunksToVectFox(ragChunks, avatarKey) {
    const vf = await loadVectFoxApi();
    const vfSettings = extension_settings.vectfox;

    if (!vfSettings) {
        throw new Error('VectFox settings not found. Ensure VectFox is installed and has been opened at least once.');
    }

    const collectionId = getCollectionId(avatarKey);

    // Clear stale chunks from previous sync.
    await vf.purgeVectorIndex(collectionId, vfSettings);

    const items = ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({
            hash: getStringHash(c.content),
            text: c.content,
        }));

    if (items.length === 0) {
        warn('VectFoxBridge', 'No completed chunks to insert — collection cleared but not repopulated.');
        return;
    }

    await vf.insertVectorItems(collectionId, items, vfSettings);

    // Register with VectFox's collection registry so it appears in queries.
    vf.registerCollection(collectionId);
    vf.setCollectionEnabled(collectionId, true);
}
