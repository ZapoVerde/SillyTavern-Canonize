/**
 * @file data/default-user/extensions/canonize/rag/vec-store.js
 * @stamp {"utc":"2026-05-31T00:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role IO Wrapper
 * @description
 * Client-side interface to the CNZ server plugin's SQLite vector store.
 * Translates CNZ domain concepts (anchors, chunks, avatarKeys) into HTTP calls
 * to /api/plugins/cnz/*. All embedding generation happens server-side.
 *
 * If the plugin is not installed, every call rejects with a clear error message
 * so the caller can surface it via toastr rather than silently failing.
 *
 * @api-declaration
 * testEmbed()                                              → Promise<{ ok, dim, nonZero, ms }>
 * insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset)
 * querySyncChunks(avatarKey, validAnchorUuids, queryText, topK)
 * insertLorebookEntries(avatarKey, anchorUuid, lorebookName, entries)
 * queryLorebookEntries(validAnchorUuids, queryText, topK)
 * purgeAnchorChunks(anchorUuid)
 * purgeCharacterChunks(avatarKey)
 * purgeCharacterLbEntries(avatarKey)
 * anchorChunkCount(avatarKey, anchorUuid)
 * anchorStats(anchorUuid)
 * fetchAiStudioModels()                                          → Promise<{ models: {id,displayName}[] }>
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/plugins/cnz/*, textgenerationwebui_settings, oai_settings]
 */

import { getRequestHeaders }                             from '../../../../../script.js';
import { getStringHash }                                 from '../../../../utils.js';
import { textgen_types, textgenerationwebui_settings }   from '../../../../textgen-settings.js';
import { oai_settings }                                  from '../../../../openai.js';
import { getSettings }                                   from '../core/settings.js';
import { log }                                           from '../log.js';

const URL_SOURCES = {
    ollama:   textgen_types.OLLAMA,
    vllm:     textgen_types.VLLM,
    llamacpp: textgen_types.LLAMACPP,
};

const BASE = '/api/plugins/cnz';

// Reports estimated embedding token usage to Loggeryze (no-op if not loaded).
// textLength is the total character count of text sent for embedding.
// Token estimate: 1 token ≈ 4 characters (rough English average).
function _reportEmbedUsage(textLength, model) {
    if (!model) return;
    window.loggeryze?.reportBgUsage({
        prompt_tokens:     Math.ceil(textLength / 4),
        completion_tokens: 0,
        _lgz_model:        model.toLowerCase().replace(/:[\w-]+$/, ''),
        _lgz_ext:          'CNZ',
    });
}

function embedCfg() {
    const s      = getSettings();
    const source = s.ragEmbeddingSource ?? 'openrouter';
    const cfg    = { embeddingSource: source, embeddingModel: s.ragEmbeddingModel ?? '' };

    // URL-based local providers: read the server URL from ST's textgen settings.
    if (URL_SOURCES[source]) {
        cfg.embeddingApiUrl = textgenerationwebui_settings.server_urls[URL_SOURCES[source]] ?? '';
    }

    // workers_ai: construct URL from the Cloudflare account ID in ST's API settings.
    if (source === 'workers_ai') {
        const accountId = (oai_settings.workers_ai_account_id ?? '').trim();
        if (accountId)
            cfg.embeddingUrlOverride = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/ai/v1`;
    }

    log('VecStore', `embedCfg source=${cfg.embeddingSource} model=${cfg.embeddingModel || '(unset)'}`);
    return cfg;
}

async function post(path, body, signal) {
    const res = await fetch(`${BASE}${path}`, {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
        signal,
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`CNZ vec-store ${path}: ${err.error ?? res.statusText}`);
    }
    return res.json();
}

async function get(path, params = {}) {
    const qs  = new URLSearchParams(params).toString();
    const url = qs ? `${BASE}${path}?${qs}` : `${BASE}${path}`;
    const res = await fetch(url, { headers: getRequestHeaders() });
    if (!res.ok) throw new Error(`CNZ vec-store GET ${path}: ${res.statusText}`);
    return res.json();
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Inserts classified RAG chunks for an anchor into the DB. Skips chunks that
 * are already indexed (upsert by hash + anchor_uuid unique constraint).
 *
 * @param {string} avatarKey    Sanitized avatar filename (from cnzAvatarKey).
 * @param {string} anchorUuid   UUID of the committing anchor.
 * @param {string|null} chatFile  ST chat filename, for catalog queries.
 * @param {{ chunkIndex:number, header:string, turnRange:string, content:string,
 *           pairStart:number, pairEnd:number, status:string }[]} chunks
 *   Completed chunks from state._ragChunks.
 * @param {number} pairOffset   Absolute pair offset (state._stagedPairOffset).
 * @returns {Promise<{ inserted: number }>}
 */
export async function insertSyncChunks(avatarKey, anchorUuid, chatFile, chunks, pairOffset) {
    const settled = chunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (!settled.length) return { inserted: 0 };

    const payload = settled.map(c => ({
        hash:      getStringHash(c.content),
        pairStart: pairOffset + c.pairStart,
        pairEnd:   pairOffset + c.pairEnd,
        header:    c.header,
        turnRange: c.turnRange,
        text:      c.content,
    }));

    const cfg    = embedCfg();
    const result = await post('/insert-chunks', { avatarKey, anchorUuid, chatFile, chunks: payload, ...cfg });
    _reportEmbedUsage(settled.reduce((s, c) => s + c.content.length, 0), cfg.embeddingModel);
    return result;
}

/**
 * Queries the DB for chunks semantically similar to queryText, scoped to the
 * provided valid ancestor UUIDs.
 *
 * @param {string[]} validAnchorUuids  UUIDs from the current DNA chain.
 * @param {string}   queryText         Recent chat context used as the query.
 * @param {number}   [topK=5]          Maximum results to return.
 * @returns {Promise<{ text:string, header:string, turnRange:string,
 *                     pairStart:number, pairEnd:number, score:number }[]>}
 */
export async function querySyncChunks(validAnchorUuids, queryText, topK = 5, signal) {
    const cfg    = embedCfg();
    const result = await post('/query-chunks', { queryText, validAnchorUuids, topK, ...cfg }, signal);
    _reportEmbedUsage(queryText.length, cfg.embeddingModel);
    return result;
}

/**
 * Deletes all chunks belonging to a specific anchor. Used by Purge & Rebuild
 * before re-indexing.
 * @param {string} anchorUuid
 */
export async function purgeAnchorChunks(anchorUuid) {
    return post('/purge-anchor', { anchorUuid });
}

/**
 * Deletes all chunks belonging to a character. Used by runNewChatCleanup and
 * purgeCnzFiles.
 * @param {string} avatarKey
 */
export async function purgeCharacterChunks(avatarKey) {
    return post('/purge-character', { avatarKey });
}

/**
 * Deletes all lorebook vector entries belonging to a character. Used by
 * runNewChatCleanup and purgeCnzFiles to make the lb purge intent explicit.
 * @param {string} avatarKey
 */
export async function purgeCharacterLbEntries(avatarKey) {
    return post('/purge-character', { avatarKey });
}

/**
 * Returns the number of indexed chunks and lorebook entries for an anchor
 * and/or character. Used by reconcileWorldState and for health checks.
 * @param {string} [avatarKey]
 * @param {string} [anchorUuid]
 * @returns {Promise<{ chunksForAnchor?:number, chunksForCharacter?:number, lbEntriesForCharacter?:number }>}
 */
export async function anchorChunkCount(avatarKey, anchorUuid) {
    const params = {};
    if (avatarKey)  params.avatarKey  = avatarKey;
    if (anchorUuid) params.anchorUuid = anchorUuid;
    return get('/health', params);
}

/**
 * Returns per-anchor DB record counts for the DNA inspector.
 * @param {string} anchorUuid
 * @returns {Promise<{ chunksForAnchor:number, lbEntriesForAnchor:number }>}
 */
export async function anchorStats(anchorUuid) {
    return get('/health', { anchorUuid });
}

/**
 * Embeds and inserts lorebook entries for an anchor into the DB. Skips entries
 * that are already indexed (upsert by hash + anchor_uuid unique constraint).
 *
 * @param {string} avatarKey     Sanitized avatar filename.
 * @param {string} anchorUuid    UUID of the owning anchor.
 * @param {string} lorebookName  Name of the lorebook (for WORLDINFO_FORCE_ACTIVATE).
 * @param {{ uid:number, content:string, comment:string }[]} entries
 * @returns {Promise<{ inserted: number }>}
 */
export async function insertLorebookEntries(avatarKey, anchorUuid, lorebookName, entries) {
    if (!entries.length) return { inserted: 0 };
    const payload = entries.map(e => ({
        hash:    getStringHash(e.content),
        uid:     e.uid,
        content: e.content,
        keys:    e.keys ?? [],    // kept for regular LB entries; empty [] for plot entries
    }));
    const cfg    = embedCfg();
    const result = await post('/insert-lorebook', { avatarKey, anchorUuid, lorebookName, entries: payload, ...cfg });
    _reportEmbedUsage(entries.reduce((s, e) => s + e.content.length, 0), cfg.embeddingModel);
    return result;
}

/**
 * Queries the DB for lorebook entries semantically similar to queryText.
 * Returns entries for WORLDINFO_FORCE_ACTIVATE — caller dedupes against
 * already-active keyword-matched entries.
 *
 * @param {string[]} validAnchorUuids  UUIDs from the current DNA chain.
 * @param {string}   queryText         Recent chat context used as the query.
 * @param {number}   [topK=3]
 * @returns {Promise<{ lorebookName:string, entryUid:number, score:number }[]>}
 */
export async function queryLorebookEntries(validAnchorUuids, queryText, topK = 3, signal, lorebookName = null) {
    const cfg    = embedCfg();
    const result = await post('/query-lorebook', { queryText, validAnchorUuids, topK, lorebookName, ...cfg }, signal);
    _reportEmbedUsage(queryText.length, cfg.embeddingModel);
    return result;
}

export async function queryRecentPlotEntries(lorebookName, validAnchorUuids, semanticUids, recencyCount = 3, signal, minArcs = 0, fillerEnabled = false, fillerCards = 1, fillerStrategy = 'random', currentTurn = 0) {
    return post('/recent-plot-entries', { lorebookName, validAnchorUuids, semanticUids, recencyCount, minArcs, fillerEnabled, fillerCards, fillerStrategy, currentTurn }, signal);
}

export async function fetchEmbedStats() {
    return get('/embed-stats');
}

export async function fetchAiStudioModels() {
    return get('/aistudio-models');
}

export async function testEmbed() {
    return post('/test-embed', embedCfg());
}
