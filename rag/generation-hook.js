/**
 * @file data/default-user/extensions/canonize/rag/generation-hook.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 2.0.0
 * @architectural-role IO Wrapper
 * @description
 * GENERATION_STARTED handler. Performs dual-path vector retrieval and injects
 * relevant chunks into the prompt via setExtensionPrompt.
 *
 * Two query paths run in parallel and are merged (deduplicated by text):
 *   1. Chat-context path  — query built from the last N recent message pairs.
 *   2. Lorebook-context path — query built from currently activated WI entries.
 *
 * Results are filtered by ragScoreThreshold, then wrapped in ragInjectionTemplate
 * and injected at ragInjectionDepth. Only fires when RAG is enabled and the DNA
 * chain has at least one anchor.
 *
 * @api-declaration
 * onGenerationStarted()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [vec-store.js, setExtensionPrompt]
 */

import { state }             from '../state.js';
import { getSettings }       from '../core/settings.js';
import { buildProsePairs, formatPairsAsTranscript } from '../core/transcript.js';
import { querySyncChunks }   from './vec-store.js';
import { error }             from '../log.js';
import { DEFAULT_RAG_INJECTION_TEMPLATE } from '../defaults.js';

const EXT_PROMPT_KEY  = 'cnz_rag';
const INJECT_POSITION = 2;

/**
 * Fired on GENERATION_STARTED. Injects relevant RAG chunks into the prompt.
 * Errors are caught and logged; on failure the generation proceeds without injection.
 */
export async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enableRag) return;

    const chain = state._dnaChain;
    if (!chain || chain.anchors.length === 0) return;

    const ctx      = SillyTavern.getContext();
    const messages = ctx.chat ?? [];
    if (!messages.length) return;

    const validUuids  = chain.anchors.map(r => r.anchor.uuid);
    const topK        = settings.ragRetrievalTopK   ?? 5;
    const topKLb      = settings.ragLbRetrievalTopK ?? 3;
    const threshold   = settings.ragScoreThreshold  ?? 0;

    // ── Path 1: recent chat context ───────────────────────────────────────────
    const horizonPairs = Math.max(1, settings.ragClassifierHistory ?? 3);
    const allPairs     = buildProsePairs(messages);
    const recentPairs  = allPairs.slice(-horizonPairs);
    const chatQuery    = formatPairsAsTranscript(recentPairs);

    // ── Path 2: active lorebook entries ───────────────────────────────────────
    const activatedWi = ctx.worldInfoActivated ?? [];
    const lbQuery     = activatedWi
        .map(e => [e.comment, ...(e.key ?? []), e.content].filter(Boolean).join(' '))
        .join('\n')
        .slice(0, 2000);

    // ── Parallel fetch, filter, dedup ─────────────────────────────────────────
    let results = [];
    try {
        const promises = [];
        if (chatQuery.trim() && topK > 0)  promises.push(querySyncChunks(validUuids, chatQuery, topK));
        if (lbQuery.trim()   && topKLb > 0) promises.push(querySyncChunks(validUuids, lbQuery, topKLb));
        if (!promises.length) return;

        const batches = await Promise.all(promises);
        const seen    = new Set();
        for (const batch of batches) {
            for (const r of batch) {
                if (r.score < threshold) continue;
                if (seen.has(r.text)) continue;
                seen.add(r.text);
                results.push(r);
            }
        }
        results.sort((a, b) => b.score - a.score);
    } catch (err) {
        error('RagHook', 'Failed to query CNZ vector store:', err);
        return;
    }

    if (!results.length) {
        ctx.setExtensionPrompt(EXT_PROMPT_KEY, '', INJECT_POSITION, 0);
        return;
    }

    // ── Format and inject ─────────────────────────────────────────────────────
    const separator = settings.ragSeparator || '***';
    const lines     = results.map(r => {
        const label = r.header ? `[${r.header}]` : (r.turnRange ?? '');
        return label ? `${label}\n${r.text}` : r.text;
    });
    const body     = lines.join(`\n${separator}\n`);
    const tmpl     = settings.ragInjectionTemplate || DEFAULT_RAG_INJECTION_TEMPLATE;
    const injection = tmpl.replace('{{text}}', body);
    const depth     = settings.ragInjectionDepth ?? 0;

    ctx.setExtensionPrompt(EXT_PROMPT_KEY, injection, INJECT_POSITION, depth);
}
