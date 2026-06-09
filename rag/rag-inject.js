/**
 * @file data/default-user/extensions/canonize/rag/rag-inject.js
 * @stamp {"utc":"2026-06-09T12:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role IO Wrapper — RAG result injection and WI activation
 * @description
 * Applies a completed RagResult to the ST prompt stack. Handles three injection
 * paths: prose chunks into the CNZ RAG prompt, primary/additional lorebook
 * entries via WORLDINFO_FORCE_ACTIVATE or direct CNZ LB prompt injection
 * (lbRagOnly / bypass), and plot arc entries via appendCnzPlotArcs.
 *
 * @api-declaration
 * injectRagResult(result, settings) → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [summary-prompt.js, WORLDINFO_FORCE_ACTIVATE, lorebook/api.js]
 */

import { state }       from '../state.js';
import { log, error }  from '../log.js';
import { eventSource, event_types } from '../../../../../script.js';
import { writeCnzRagPrompt, clearCnzRagPrompt, appendCnzPlotArcs,
         writeCnzLbPrompt, clearCnzLbPrompt } from '../core/summary-prompt.js';
import { lbGetLorebook } from '../lorebook/api.js';
import { DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE } from '../defaults.js';

// ── Pure helpers ──────────────────────────────────────────────────────────────

function _formatPlotArcs(entries, chunkTmpl) {
    const tmpl = chunkTmpl || DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE;
    const arcMap = new Map();
    for (const { content } of entries) {
        const tags = content.match(/#\w+/g) ?? [];
        const tag  = tags[tags.length - 1];
        if (!tag) continue;
        const text = content.replace(/#\w+/g, '').trim();
        if (!arcMap.has(tag)) arcMap.set(tag, []);
        arcMap.get(tag).push(text);
    }
    return [...arcMap.entries()]
        .map(([tag, texts]) => {
            const arcTag = tag.slice(1);
            return tmpl
                .replace(/\{\{arc_tag\}\}/g, arcTag)
                .replace(/\{\{text\}\}/g, texts.join('\n\n'));
        })
        .join('\n\n');
}

function _buildBypassBlock(entry) {
    const tag   = (entry.comment ?? '').trim().replace(/\s+/g, '_') || entry.lorebookName;
    const keys  = entry.key?.length ? entry.key : [];
    const alias = keys.length ? `(${keys.join(', ')})\n` : '';
    return `<${tag}>\n${alias}${entry.content ?? ''}\n</${tag}>`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Applies a completed RagResult to the ST prompt stack.
 * @param {{ injection:string, toActivate:object[], bypassEntries:object[] }} result
 * @param {object} settings  CNZ settings snapshot
 */
export async function injectRagResult(result, settings) {
    // ── RAG prose chunks ──────────────────────────────────────────────────────
    if (result.injection) {
        writeCnzRagPrompt(result.injection);
    } else {
        clearCnzRagPrompt();
    }

    // ── Primary lorebook activation ───────────────────────────────────────────
    const plotLbName   = state._plotLorebookName ?? null;
    const lbActivate   = plotLbName ? result.toActivate.filter(a => a.world !== plotLbName) : result.toActivate;
    const plotActivate = plotLbName ? result.toActivate.filter(a => a.world === plotLbName) : [];

    // Collect all blocks that need direct prompt injection, then write once.
    const directBlocks = [];

    const primaryLbName = state._lorebookName ?? null;
    if (settings.lbRagOnly ?? false) {
        // Primary CNZ lorebook entries — looked up directly from _draftLorebook
        const lbEntries = lbActivate
            .filter(a => a.world === primaryLbName)
            .map(a => state._draftLorebook?.entries?.[String(a.uid)])
            .filter(Boolean);
        for (const e of lbEntries) {
            const tag   = (e.comment ?? '').replace(/\s+/g, '_');
            const keys  = (e.key?.length ? e.key : e.extensions?.cnz_keys ?? []);
            const alias = keys.length ? `(${keys.join(', ')})\n` : '';
            directBlocks.push(`<${tag}>\n${alias}${e.content ?? ''}\n</${tag}>`);
        }
        if (lbEntries.length) log('RagInject', `LB direct inject: ${lbEntries.length} entries`);

        // Additional non-bypass LB entries — fetch from their own lorebooks, placed at bottom
        const addLbActivate = lbActivate.filter(a => a.world !== primaryLbName);
        if (addLbActivate.length) {
            const byWorld = new Map();
            for (const a of addLbActivate) {
                if (!byWorld.has(a.world)) byWorld.set(a.world, []);
                byWorld.get(a.world).push(a.uid);
            }
            let addCount = 0;
            for (const [world, uids] of byWorld) {
                try {
                    const lb = await lbGetLorebook(world);
                    const worldEntries = [];
                    for (const uid of uids) {
                        const e = lb?.entries?.[String(uid)];
                        if (!e) continue;
                        const tag   = (e.comment ?? '').trim().replace(/\s+/g, '_') || world;
                        const keys  = e.key ?? [];
                        const alias = keys.length ? `(${keys.join(', ')})\n` : '';
                        directBlocks.push(`<${tag}>\n${alias}${e.content ?? ''}\n</${tag}>`);
                        worldEntries.push(e);
                        addCount++;
                    }
                    if (worldEntries.length) {
                        const _p = e => (e.content ?? '').split('\n').slice(0, 2).join(' ').slice(0, 80);
                        const first = worldEntries[0], last = worldEntries.at(-1);
                        const suffix = worldEntries.length > 1 ? `  ‖  last: ${_p(last)}` : '';
                        log('RagInject', `AddLB [${world}] ${worldEntries.length} | first: ${_p(first)}${suffix}`);
                    }
                } catch (err) {
                    error('RagInject', `Additional LB lookup failed (${world}):`, err);
                }
            }
            if (addCount) log('RagInject', `Additional LB direct inject: ${addCount} entries`);
        }
    } else {
        if (lbActivate.length) {
            // Primary entries enriched from _draftLorebook; additional fetched from their lorebooks
            const toForceActivate = lbActivate
                .filter(a => a.world === primaryLbName)
                .map(a => {
                    const entry = state._draftLorebook?.entries?.[String(a.uid)];
                    return entry ? { ...entry, world: a.world } : a;
                });
            const addLbActivate = lbActivate.filter(a => a.world !== primaryLbName);
            if (addLbActivate.length) {
                const byWorld = new Map();
                for (const a of addLbActivate) {
                    if (!byWorld.has(a.world)) byWorld.set(a.world, []);
                    byWorld.get(a.world).push(a.uid);
                }
                for (const [world, uids] of byWorld) {
                    try {
                        const lb = await lbGetLorebook(world);
                        for (const uid of uids) {
                            const e = lb?.entries?.[String(uid)];
                            toForceActivate.push(e ? { ...e, world } : { world, uid });
                        }
                    } catch (err) {
                        error('RagInject', `Additional LB lookup failed (${world}):`, err);
                        for (const uid of uids) toForceActivate.push({ world, uid });
                    }
                }
            }
            log('RagInject', `Semantic LB activation: ${toForceActivate.length} entries`);
            try {
                window.loggeryze?.time('CNZ LB activate [blocking]');
                await eventSource.emit(event_types.WORLDINFO_FORCE_ACTIVATE, toForceActivate);
                window.loggeryze?.timeEnd('CNZ LB activate [blocking]');
            } catch (err) {
                window.loggeryze?.timeEnd('CNZ LB activate [blocking]');
                error('RagInject', 'LB WI activation failed:', err);
            }
        }
    }

    // ── Additional lorebook bypass entries always go to direct injection ───────
    if (result.bypassEntries?.length) {
        for (const e of result.bypassEntries) directBlocks.push(_buildBypassBlock(e));
        log('RagInject', `Additional LB bypass inject: ${result.bypassEntries.length} entries`);
    }

    if (directBlocks.length) {
        writeCnzLbPrompt(`The following are relevant world info entries:\n\n${directBlocks.join('\n\n')}`);
    } else {
        clearCnzLbPrompt();
    }

    // ── Plot arc injection ────────────────────────────────────────────────────
    if (plotLbName) {
        try {
            if (plotActivate.length) {
                const lb      = await lbGetLorebook(plotLbName);
                const entries = plotActivate.map(a => lb.entries?.[String(a.uid)]).filter(Boolean)
                    .sort((a, b) => a.uid - b.uid);
                if (entries.length) {
                    const arcGroups = new Map();
                    for (const e of entries) {
                        const tags = e.content.match(/#\w+/g) ?? [];
                        const arc  = tags[tags.length - 1] ?? '(no arc)';
                        if (!arcGroups.has(arc)) arcGroups.set(arc, []);
                        arcGroups.get(arc).push(e);
                    }
                    for (const [arc, grp] of arcGroups) {
                        const _p  = e => e.content.replace(/#\w+/g, '').trim().split('\n').slice(0, 2).join(' ').slice(0, 80);
                        const suffix = grp.length > 1 ? `  ‖  last: ${_p(grp.at(-1))}` : '';
                        log('RagInject', `Plot card arc=${arc} (${grp.length}) | first: ${_p(grp[0])}${suffix}`);
                    }
                }
                appendCnzPlotArcs(entries.length ? _formatPlotArcs(entries, settings.cnzPlotChunkTemplate) : '');
                if (entries.length) log('RagInject', `Plot arcs injected: ${entries.length} entries (${plotActivate.length} in plotActivate)`);
            } else {
                appendCnzPlotArcs('');
            }
        } catch (err) {
            error('RagInject', 'Plot arc injection failed:', err);
        }
    }
}
