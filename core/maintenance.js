/**
 * @file data/default-user/extensions/canonize/core/maintenance.js
 * @stamp {"utc":"2026-06-04T15:31:00.000Z"}
 * @version 2.2.0
 * @architectural-role Orchestrator
 * @description
 * User-initiated RAG rebuild (concurrent worker pool) triggered from the
 * settings panel. Cleanup operations (runNewChatCleanup, purgeCnzFiles) live
 * in maintenance-cleanup.js.
 *
 * @api-declaration
 * rebuildRag()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._stagedProsePairs, state._stagedPairOffset,
 *                       state._splitPairIdx, state._ragChunks,
 *                       state._lorebookName, state._lorebookData, state._draftLorebook]
 *     external_io: [callPopup, toastr, file-store.js, file-store-lb.js, lorebook/api.js]
 */

import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain, buildAnchorBoundaries, buildAnchorChunkMap } from './dna-chain.js';
import { buildProsePairs } from './transcript.js';
import { buildRagChunks } from '../rag/chunks.js';
import { waitForRagChunks } from '../rag/pipeline.js';
import { cnzChatKey, cnzDefaultLbName, cnzGetActiveChatKey } from '../rag/api.js';
import { insertSyncChunks, anchorChunkCount } from '../rag/file-store.js';
import { insertLorebookEntries } from '../rag/file-store-lb.js';
import { reconcilePlotLorebook } from './healer.js';
import { lbEnsureLorebook, lbGetLorebook } from '../lorebook/api.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { getStringHash } from '../../../../utils.js';
import { error, warn, log } from '../log.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const CONCURRENCY = 20;
const RETRY_MS    = 1000;
const MAX_RETRIES = 3;
const MAX_ROUNDS  = 3;

// ─── Rebuild RAG ──────────────────────────────────────────────────────────────

/**
 * Re-indexes all classified chunks into the vector DB using CONCURRENCY parallel
 * workers. Idempotent (upsert). Per-anchor retry with linear backoff per round,
 * doubling delay each round; failed anchors re-queued up to MAX_ROUNDS. After
 * each failure /health is pinged to verify the server committed the insert.
 */
export async function rebuildRag() {
    const { isSyncInProgress } = await import('../scheduler.js');
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync in progress — wait for it to complete.');
        return;
    }
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const messages = ctx.chat ?? [];
    const chain    = readDnaChain(messages);
    if (!chain.lkg) {
        toastr.warning('CNZ: No anchor found in this chat — nothing to rebuild from.');
        return;
    }

    const { escapeHtml } = await import('../state.js');
    const confirmed = await callPopup(`
<h3>Rebuild RAG</h3>
<p>Re-index all chunks for <strong>${escapeHtml(char.name)}</strong> from the chain history.</p>
<p>Already-indexed chunks are skipped — safe to re-run after a partial failure.</p>
<label style="display:flex;align-items:center;gap:0.5em;margin-top:0.75em;">
  <input type="checkbox" id="cnz-rebuild-deep">
  Reclassify all chunks with AI (slow)
</label>`, 'confirm');
    if (!confirmed) return;

    const deepReclassify = document.getElementById('cnz-rebuild-deep')?.checked ?? false;

    try {
        // ── 1. Collect chunks from chain ──────────────────────────────────────
        const allPairs    = buildProsePairs(messages);
        const ragSettings = getSettings();

        // ── 1b. Assign chunks to anchor groups ────────────────────────────────
        const chatKey  = cnzGetActiveChatKey();
        if (!chatKey) { toastr.error('CNZ: Cannot rebuild — no chat file active.'); return; }
        const chatFile = ctx.chatId ?? ctx.getCurrentChatId?.() ?? char?.chat ?? null;

        let byAnchor, total;
        if (deepReclassify) {
            state._stagedProsePairs = allPairs;
            state._stagedPairOffset = 0;
            state._splitPairIdx     = allPairs.length;
            state._ragChunks        = buildRagChunks(allPairs, 0, ragSettings);
            setCurrentSettings(ragSettings);
            dispatchContract('rag_classifier', {
                ragChunks:        state._ragChunks,
                fullPairs:        allPairs,
                stagedPairs:      allPairs,
                stagedPairOffset: 0,
                splitPairIdx:     allPairs.length,
                scenario_hooks:   chain.lkg.hooks ?? '',
            }, ragSettings);
            await waitForRagChunks(300_000);
            const classified  = state._ragChunks.filter(c => c.status === 'complete');
            if (!classified.length) { toastr.warning('CNZ: No classified chunks found in chain — run a sync first.'); return; }
            total      = classified.length;
            byAnchor   = new Map();
            const boundaries = buildAnchorBoundaries(chain);
            for (const chunk of classified) {
                let uuid = chain.lkg.uuid;
                for (const b of boundaries) { if (chunk.pairStart < b.maxPairEnd) { uuid = b.uuid; break; } }
                if (!byAnchor.has(uuid)) byAnchor.set(uuid, []);
                byAnchor.get(uuid).push(chunk);
            }
        } else {
            byAnchor = buildAnchorChunkMap(chain, allPairs, chain.lkg.uuid);
            total    = [...byAnchor.values()].reduce((s, v) => s + v.length, 0);
            if (total === 0) { toastr.warning('CNZ: No classified chunks found in chain — run a sync first.'); return; }
        }

        // ── 3. Concurrent worker pool ─────────────────────────────────────────
        const queue    = [...byAnchor.entries()].map(([uuid, chunks]) => ({ uuid, chunks, round: 0 }));
        const gaveUp   = [];
        let inserted   = 0;
        let active     = 0;
        let warnedOnce = false;

        let $toast = toastr.info(`CNZ: Rebuilding — 0 / ${total} chunks`, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        const _upd = msg => {
            if ($toast?.is(':visible')) $toast.find('.toast-message').text(msg);
            else $toast = toastr.info(msg, '', { timeOut: 0, extendedTimeOut: 0, closeButton: true });
        };

        const _worker = async () => {
            while (true) {
                const item = queue.shift();
                if (!item) { if (active === 0) break; await sleep(50); continue; }
                active++;
                const { uuid, chunks, round } = item;
                const retryMs = RETRY_MS * (1 << round);
                let succeeded = false;

                for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
                    _upd(`CNZ: Rebuilding — ${inserted} / ${total} chunks${round > 0 ? ` (round ${round + 1}/${MAX_ROUNDS})` : ''}`);
                    try {
                        await insertSyncChunks(chatKey, uuid, chatFile, chunks, 0);
                        inserted += chunks.length;
                        succeeded = true;
                        break;
                    } catch {
                        // Ping /health to verify — the tunnel may have dropped the
                        // response even though the server committed the insert.
                        try {
                            const { chunksForAnchor } = await anchorChunkCount(chatKey, uuid);
                            if ((chunksForAnchor ?? 0) > 0) { inserted += chunks.length; succeeded = true; break; }
                        } catch { /* plugin unreachable — treat as genuine failure */ }
                        if (!warnedOnce) {
                            toastr.warning('CNZ: Connection trouble — retrying failed anchors.', '', { timeOut: 5000 });
                            warnedOnce = true;
                        }
                        if (attempt < MAX_RETRIES) {
                            _upd(`CNZ: Rebuilding — ${inserted} / ${total} chunks (retry ${attempt}/${MAX_RETRIES}...)`);
                            await sleep(retryMs * attempt);
                        }
                    }
                }

                if (!succeeded) {
                    if (round + 1 < MAX_ROUNDS) queue.push({ uuid, chunks, round: round + 1 });
                    else { gaveUp.push(uuid); error('Maintenance', `rebuildRag: gave up on anchor ${uuid} after ${MAX_ROUNDS} rounds`); }
                }
                active--;
            }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, _worker));

        toastr.clear($toast);
        if (gaveUp.length === 0) {
            toastr.success(`CNZ: Rebuild complete — ${inserted} / ${total} chunks indexed.`);
        } else {
            toastr.warning(`CNZ: Rebuild done — ${inserted} / ${total} chunks. ${gaveUp.length} anchor(s) failed after ${MAX_ROUNDS} rounds.`);
        }

        // ── 4. Rebuild lorebook vectors ───────────────────────────────────────
        if (!state._draftLorebook) {
            const lbName = state._lorebookName || cnzDefaultLbName(char.avatar);
            state._lorebookName  = lbName;
            const freshLorebook  = await lbEnsureLorebook(lbName);
            state._lorebookData  = freshLorebook;
            state._draftLorebook = structuredClone(freshLorebook);
            log('Maintenance', `rebuildRag: lorebook lazy-loaded: "${lbName}" (${Object.keys(freshLorebook.entries ?? {}).length} entries)`);
        }
        const lbEntries = Object.values(state._draftLorebook.entries);
        if (lbEntries.length > 0) {
            await insertLorebookEntries(chatKey, chain.lkg.uuid, state._lorebookName, lbEntries);
        }

        // ── 5. Rebuild plot lorebook vectors (shared with healer) ─────────────
        await reconcilePlotLorebook(char, chain, chatKey);

        // ── 6. Rebuild additional lorebook vectors ────────────────────────────
        const additionalLbs = state._additionalLorebooks ?? [];
        if (additionalLbs.length) {
            let addCount = 0;
            for (const lb of additionalLbs) {
                try {
                    const disk    = await lbGetLorebook(lb.name);
                    const entries = Object.values(disk?.entries ?? {})
                        .filter(e => !e.disable && e.content?.trim())
                        .map(e => ({ uid: e.uid, content: e.content, keys: e.key ?? [], comment: e.comment ?? '' }));
                    if (entries.length) {
                        await insertLorebookEntries(chatKey, chain.lkg.uuid, lb.name, entries);
                        lb.hash = getStringHash(entries.map(e => e.content).join('\n'));
                        addCount += entries.length;
                    } else {
                        lb.hash = 0;
                    }
                } catch (err) {
                    warn('Maintenance', `rebuildRag: additional LB "${lb.name}" skipped:`, err);
                    lb.hash = 0;
                }
            }
            if (addCount) log('Maintenance', `rebuildRag: indexed ${addCount} additional lorebook entries`);
        }

    } catch (err) {
        error('Maintenance', 'rebuildRag:', err);
        toastr.error(`CNZ: Rebuild failed: ${err.message}`);
    }
}