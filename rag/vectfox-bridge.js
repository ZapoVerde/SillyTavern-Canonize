/**
 * @file data/default-user/extensions/canonize/rag/vectfox-bridge.js
 * @architectural-role IO Wrapper
 * @description
 * Pushes scene-sliced transcript text into a VectFox-managed vector collection
 * and queries it for per-generation retrieval. Activated when settings.useVectFox
 * is true.
 *
 * Dynamically imports VectFox APIs so this file is safe to load even when
 * VectFox is not installed — the error surfaces only when the bridge is called.
 *
 * Collection lifecycle: additive insert on every sync — hash dedup filters out
 * already-indexed scenes. The cnz_* collection is registered but kept DISABLED
 * in VectFox's auto-retrieval pipeline so CNZ controls injection via
 * queryVectFoxScenes at generation time. Explicit purge is exposed via
 * purgeVectFoxCollection for branch-detection and Purge & Rebuild scenarios.
 *
 * Lorebook re-vectorization is triggered by commit.js after a lorebook change
 * and by the branch healer after a lorebook rollback.
 *
 * @api-declaration
 * pushScenesToVectFox, queryVectFoxScenes, purgeVectFoxCollection,
 * checkVectFoxAvailable, revectorizeLorebookForChar, scopeVectFoxToChar
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
 * matches lorebookName.
 * @param {object} vf            Loaded VectFox API object.
 * @param {string} lorebookName  Lorebook name as stored in collection metadata.
 * @returns {{ collectionId: string, registryKey: string }[]}
 */
function findLorebookCollections(vf, lorebookName) {
    const results = [];
    for (const registryKey of vf.getCollectionRegistry()) {
        const { collectionId } = vf.parseRegistryKey(registryKey);
        if (!collectionId.startsWith('vf_lorebook_')) continue;
        if (vf.getCollectionMeta(registryKey)?.sourceName === lorebookName)
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
 * Queries the cnz_* VectFox collection for scenes most relevant to the given
 * text. Called at GENERATION_STARTED so CNZ injects only semantically relevant
 * transcript context instead of the full collection.
 *
 * @param {string} avatarKey   Sanitized avatar key (from cnzAvatarKey).
 * @param {string} queryText   Recent chat text used as the search query.
 * @param {number} [topK=3]    Maximum number of scenes to return.
 * @returns {Promise<{ text: string, score: number, pairStart: number, pairEnd: number }[]>}
 */
export async function queryVectFoxScenes(avatarKey, queryText, topK = 3) {
    const vf = await loadVectFoxApi();
    const vfSettings = extension_settings.vectfox;
    if (!vfSettings) throw new Error('VectFox settings not found. Ensure VectFox is installed and has been opened at least once.');

    const collectionId = getCollectionId(avatarKey);
    const results = await vf.queryCollection(collectionId, queryText, topK, vfSettings);

    return results.metadata.map((meta, idx) => ({
        text: meta.text || '',
        hash: results.hashes[idx],
        score: meta.score ?? 1.0,
        pairStart: meta.pairStart,
        pairEnd: meta.pairEnd,
    }));
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
 * Additively inserts scene-sliced transcript text into the VectFox collection,
 * skipping any scenes whose hash already exists. Each scene is one vector item.
 *
 * Scenes are produced by buildSceneSlices in transcript.js: they are either
 * bounded by Vistalyze location-change events or by the vectfoxMaxPairsPerChunk
 * cap, whichever comes first. Scene boundary pairs appear in both the closing
 * and opening slice for better retrieval across transitions.
 *
 * @param {{ text: string, pairStart: number, pairEnd: number }[]} scenes
 * @param {string} avatarKey  Sanitized avatar key (from cnzAvatarKey).
 * @returns {Promise<void>}
 */
export async function pushScenesToVectFox(scenes, avatarKey) {
    const vf = await loadVectFoxApi();
    const vfSettings = extension_settings.vectfox;

    if (!vfSettings) {
        throw new Error('VectFox settings not found. Ensure VectFox is installed and has been opened at least once.');
    }

    const collectionId = getCollectionId(avatarKey);

    let existingHashes;
    try {
        existingHashes = new Set(await vf.getSavedHashes(collectionId, vfSettings));
    } catch (_) {
        existingHashes = new Set();
    }

    const items = scenes
        .map(s => ({
            hash: getStringHash(s.text),
            text: s.text,
            metadata: { pairStart: s.pairStart, pairEnd: s.pairEnd },
        }))
        .filter(item => !existingHashes.has(item.hash));

    // Register then explicitly DISABLE — collections default to enabled, so we
    // must set enabled=false here. CNZ queries this collection directly at
    // generation time via queryVectFoxScenes. Leaving it enabled would let
    // VectFox's auto-retrieval pipeline inject the full transcript on every
    // generation with the global top_k.
    vf.registerCollection(collectionId);
    vf.setCollectionEnabled(collectionId, false);

    if (items.length === 0) return;

    await vf.insertVectorItems(collectionId, items, vfSettings);
}

/**
 * Temporarily disables all VectFox collections except those belonging to the
 * current character. Returns an async restore function that re-enables them.
 *
 * Use this in a try/finally around heal operations so irrelevant collections
 * don't interfere during purge/re-vectorize, and are restored afterward.
 *
 * @param {string} avatarKey      Sanitized avatar key (from cnzAvatarKey).
 * @param {string} [lorebookName] Character's lorebook name for vf_lorebook_ matching.
 * @returns {Promise<() => Promise<void>>} Async restore function.
 */
export async function scopeVectFoxToChar(avatarKey, lorebookName) {
    const vf = await loadVectFoxApi();
    const cnzId = getCollectionId(avatarKey);
    const disabled = [];

    for (const registryKey of vf.getCollectionRegistry()) {
        const { collectionId } = vf.parseRegistryKey(registryKey);

        if (collectionId === cnzId) continue;

        if (lorebookName && collectionId.startsWith('vf_lorebook_')) {
            const meta = vf.getCollectionMeta(registryKey);
            if (meta?.sourceName === lorebookName) continue;
        }

        if (vf.isCollectionEnabled(registryKey)) {
            vf.setCollectionEnabled(registryKey, false);
            disabled.push(registryKey);
        }
    }

    return async () => {
        for (const registryKey of disabled) {
            vf.setCollectionEnabled(registryKey, true);
        }
    };
}

/**
 * Purges all stale VectFox lorebook collections for the character's lorebook,
 * then re-vectorizes from the current lorebook on disk. Called fire-and-forget
 * after a CNZ lorebook commit, and after a branch heal that rolls the lorebook back.
 * @param {object} char  Current character object from context.
 * @returns {Promise<void>}
 */
export async function revectorizeLorebookForChar(char) {
    const lorebookName = char?.data?.extensions?.world || null;
    if (!lorebookName) throw new Error('Character has no explicitly assigned lorebook');

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
