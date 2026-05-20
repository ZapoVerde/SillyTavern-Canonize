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
 * Collection lifecycle: additive insert on every regular sync — getSavedHashes
 * filters out already-indexed chunks so stable committed history is never
 * re-embedded. Explicit purge is exposed via purgeVectFoxCollection for
 * anchor-move scenarios (branch detection, Purge & Rebuild).
 *
 * @api-declaration
 * pushChunksToVectFox, purgeVectFoxCollection, checkVectFoxAvailable, isVectFoxCollectionEmpty,
 * isLorebookVectorized, revectorizeLorebookForChar
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [VectFox extension APIs]
 */

import { getStringHash } from '../../../../utils.js';
import { extension_settings } from '../../../../extensions.js';

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
        const [coreApi, collectionLoader, collectionMeta, collectionIds] = await Promise.all([
            import(`${VECTFOX_BASE}/core-vector-api.js`),
            import(`${VECTFOX_BASE}/collection-loader.js`),
            import(`${VECTFOX_BASE}/collection-metadata.js`),
            import(`${VECTFOX_BASE}/collection-ids.js`),
        ]);
        return { ...coreApi, ...collectionLoader, ...collectionMeta, ...collectionIds };
    } catch (e) {
        throw new Error('VectFox extension not found. Install VectFox alongside Canonize, or disable "Use VectFox for retrieval" in RAG settings.');
    }
}

/**
 * Scans the live VectFox registry for lorebook collections whose sourceName
 * matches lorebookName. Returns all matches — there may be several if the
 * lorebook has been vectorized more than once.
 * @param {object} vf            Loaded VectFox API object.
 * @param {string} lorebookName  Lorebook name as stored in collection metadata.
 * @returns {{ collectionId: string, registryKey: string }[]}
 */
function findLorebookCollections(vf, lorebookName) {
    const results = [];
    for (const registryKey of vf.getCollectionRegistry()) {
        const { collectionId } = vf.parseRegistryKey(registryKey);
        if (!collectionId.startsWith('vf_lorebook_')) continue;
        if (vf.getCollectionMeta(collectionId)?.sourceName === lorebookName)
            results.push({ collectionId, registryKey });
    }
    return results;
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
 * Returns true if the Canonize VectFox collection for avatarKey is empty or does not exist.
 * Used by the healer to detect a missing collection on chat load and trigger a fast-path push.
 * @param {string} avatarKey  Sanitized avatar key (from cnzAvatarKey).
 * @returns {Promise<boolean>}
 */
export async function isVectFoxCollectionEmpty(avatarKey) {
    try {
        const vf = await loadVectFoxApi();
        const vfSettings = extension_settings.vectfox;
        if (!vfSettings) return true;
        const hashes = await vf.getSavedHashes(getCollectionId(avatarKey), vfSettings);
        return !hashes || hashes.length === 0;
    } catch (_) {
        return true; // collection missing or VectFox unavailable
    }
}

/**
 * Returns true if at least one VectFox lorebook collection exists for lorebookName.
 * Used by the healer to decide whether to trigger vectorization on chat load.
 * @param {string} lorebookName
 * @returns {Promise<boolean>}
 */
export async function isLorebookVectorized(lorebookName) {
    try {
        const vf = await loadVectFoxApi();
        if (!extension_settings.vectfox) return false;
        return findLorebookCollections(vf, lorebookName).length > 0;
    } catch (_) {
        return false;
    }
}

/**
 * Purges all stale VectFox lorebook collections for the character's lorebook,
 * then re-vectorizes from the current lorebook on disk. Called fire-and-forget
 * after a CNZ lorebook commit, and on chat load when no collection exists.
 * @param {object} char  Current character object from context.
 * @returns {Promise<void>}
 */
export async function revectorizeLorebookForChar(char) {
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (!lorebookName) throw new Error('Character has no lorebook name');

    const vf = await loadVectFoxApi();
    const vfSettings = extension_settings.vectfox;
    if (!vfSettings) throw new Error('VectFox settings not found. Ensure VectFox is installed and has been opened at least once.');

    for (const { collectionId, registryKey } of findLorebookCollections(vf, lorebookName)) {
        await vf.deleteCollection(collectionId, vfSettings, registryKey);
    }

    const { vectorizeContent } = await import(`${VECTFOX_BASE}/content-vectorization.js`);
    await vectorizeContent({
        contentType: 'lorebook',
        source: { type: 'select', id: lorebookName },
        settings: vfSettings,
    });
}

/**
 * Wipes the entire Canonize collection from VectFox. Called before a full
 * rebuild (Purge & Rebuild) or when the anchor moves (branch detection).
 *
 * @param {string} avatarKey  Sanitized avatar key (from cnzAvatarKey).
 * @returns {Promise<void>}
 */
export async function purgeVectFoxCollection(avatarKey) {
    const vf = await loadVectFoxApi();
    const vfSettings = extension_settings.vectfox;

    if (!vfSettings) {
        throw new Error('VectFox settings not found. Ensure VectFox is installed and has been opened at least once.');
    }

    await vf.purgeVectorIndex(getCollectionId(avatarKey), vfSettings);
}

/**
 * Additively inserts completed chunks into the VectFox collection, skipping
 * any whose hash already exists. Safe to call every sync because content
 * behind the anchor is immutable — hashes are stable.
 *
 * Only chunks with status 'complete' or 'manual' are eligible; pending/error
 * chunks are skipped.
 *
 * @param {Array}  ragChunks  Chunks to consider for insertion.
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

    // Fetch existing hashes so we skip already-indexed chunks.
    let existingHashes;
    try {
        existingHashes = new Set(await vf.getSavedHashes(collectionId, vfSettings));
    } catch (_) {
        existingHashes = new Set(); // collection doesn't exist yet — all items are new
    }

    const items = ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({ hash: getStringHash(c.content), text: c.content }))
        .filter(item => !existingHashes.has(item.hash));

    // Always register/enable even if nothing new to insert (ensures first-sync visibility).
    vf.registerCollection(collectionId);
    vf.setCollectionEnabled(collectionId, true);

    if (items.length === 0) {
        return;
    }

    await vf.insertVectorItems(collectionId, items, vfSettings);
}
