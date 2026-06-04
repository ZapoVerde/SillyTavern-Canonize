/**
 * @file data/default-user/extensions/canonize/rag/embed-client.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role IO Wrapper — embed config and usage reporting
 * @description
 * Provides the embed configuration block (source, model, apiUrl) read from CNZ
 * settings and the ST connection panels. Also reports embedding usage to Loggeryze.
 *
 * Vectra insert/query operations have been replaced by embed-direct.js +
 * vector-store.js. purgeCollection is retained for cleaning up any legacy Vectra
 * collections left over from before this architecture change.
 *
 * testEmbed delegates to embed-direct.js so the settings panel smoke test
 * exercises the actual embedding path.
 *
 * @api-declaration
 * embedCfg()                → EmbedCfg
 * reportEmbedUsage(chars, model) → void
 * purgeCollection(collectionId)  → Promise<void>   (legacy cleanup only)
 * testEmbed(cfg)            → Promise<{ ok, ms }>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [POST /api/vector/purge, embed-direct.js,
 *                       textgenerationwebui_settings, oai_settings]
 */

import { getRequestHeaders }                           from '../../../../../script.js';
import { textgen_types, textgenerationwebui_settings } from '../../../../textgen-settings.js';
import { oai_settings }                                from '../../../../openai.js';
import { getSettings }                                 from '../core/settings.js';
import { testEmbedDirect }                             from './embed-direct.js';
import { log }                                         from '../log.js';

const BASE = '/api/vector';

const URL_SOURCES = {
    ollama:   textgen_types.OLLAMA,
    vllm:     textgen_types.VLLM,
    llamacpp: textgen_types.LLAMACPP,
};

// ── Embed config ──────────────────────────────────────────────────────────────

/**
 * Builds the params block consumed by embed-direct.js and (legacy) /api/vector/*.
 */
export function embedCfg() {
    const s      = getSettings();
    const source = s.ragEmbeddingSource ?? 'openrouter';
    const cfg    = { source, model: s.ragEmbeddingModel ?? '' };

    if (URL_SOURCES[source])
        cfg.apiUrl = textgenerationwebui_settings.server_urls[URL_SOURCES[source]] ?? '';

    if (source === 'workers_ai') {
        const accountId = (oai_settings.workers_ai_account_id ?? '').trim();
        if (accountId) cfg.urlOverride = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`;
    }

    log('EmbedClient', `cfg source=${cfg.source} model=${cfg.model || '(unset)'}`);
    return cfg;
}

// ── Loggeryze reporting ───────────────────────────────────────────────────────

export function reportEmbedUsage(textLength, model) {
    if (!model) return;
    window.loggeryze?.reportBgUsage({
        prompt_tokens:     Math.ceil(textLength / 4),
        completion_tokens: 0,
        _lgz_model:        model.toLowerCase().replace(/:[\w-]+$/, ''),
        _lgz_ext:          'CNZ',
    });
}

// ── Legacy Vectra cleanup ─────────────────────────────────────────────────────

/**
 * Deletes a Vectra collection. Used only to clean up collections created before
 * the direct-embedding architecture change.
 * @param {string} collectionId
 */
export async function purgeCollection(collectionId) {
    const res = await fetch(`${BASE}/purge`, {
        method:  'POST',
        headers: { ...getRequestHeaders(), 'Content-Type': 'application/json' },
        body:    JSON.stringify({ collectionId }),
    });
    if (!res.ok) {
        const text = await res.text().catch(() => res.statusText);
        throw new Error(`CNZ vec-api /purge: ${text}`);
    }
}

// ── Embed test ────────────────────────────────────────────────────────────────

/**
 * Smoke test for the settings panel. Delegates to embed-direct.js.
 * @param {object} cfg  From embedCfg()
 * @returns {Promise<{ ok: boolean, ms: number }>}
 */
export async function testEmbed(cfg) {
    return testEmbedDirect(cfg);
}
