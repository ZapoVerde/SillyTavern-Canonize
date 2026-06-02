/**
 * @file data/default-user/extensions/canonize/core/maintenance.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @version 2.1.0
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
 *                       state._splitPairIdx, state._ragChunks]
 *     external_io: [callPopup, toastr, /api/plugins/cnz/*]
 */

import { callPopup } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain } from './dna-chain.js';
import { buildProsePairs, formatPairsAsTranscript } from './transcript.js';
import { buildRagChunks } from '../rag/chunks.js';
import { waitForRagChunks } from '../rag/pipeline.js';
import { cnzAvatarKey, cnzPlotLbName } from '../rag/api.js';
import { insertSyncChunks, insertLorebookEntries, anchorChunkCount } from '../rag/vec-store.js';
import { rebuildPlotLorebook } from '../lorebook/plot-lorebook.js';
import { getSettings } from './settings.js';
import { dispatchContract, setCurrentSettings } from '../cycleStore.js';
import { error, log } from '../log.js';

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

        let combinedChunks;
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
            combinedChunks = state._ragChunks.filter(c => c.status === 'complete');
        } else {
            combinedChunks = [];
            let prevPairEnd = 0;
            for (let i = 0; i < allPairs.length; i++) {
                const pair    = allPairs[i];
                const lastMsg = pair?.messages?.[pair.messages.length - 1];
                if (!lastMsg?.extra?.cnz_chunk_header) continue;
                const pairStart = prevPairEnd;
                const pairEnd   = i + 1;
                const content   = formatPairsAsTranscript(allPairs.slice(pairStart, pairEnd));
                combinedChunks.push({
                    chunkIndex: combinedChunks.length,
                    header:     lastMsg.extra.cnz_chunk_header,
                    turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${pairStart + 1}–${pairEnd}`,
                    content,
                    pairStart,
                    pairEnd,
                    status:     'complete',
                });
                prevPairEnd = pairEnd;
            }
        }

        if (combinedChunks.length === 0) {
            toastr.warning('CNZ: No classified chunks found in chain — run a sync first.');
            return;
        }

        // ── 2. Assign chunks to anchor groups ─────────────────────────────────
        const avatarKey = cnzAvatarKey(char.avatar);
        const chatFile  = ctx.getCurrentChatFile?.() ?? null;
        const total     = combinedChunks.length;

        const boundaries = chain.anchors
            .map(({ anchor }) => ({
                uuid:       anchor.uuid,
                maxPairEnd: (anchor.ragHeaders ?? []).reduce((m, rh) => Math.max(m, rh.pairEnd ?? 0), 0),
            }))
            .filter(b => b.maxPairEnd > 0)
            .sort((a, b) => a.maxPairEnd - b.maxPairEnd);

        const byAnchor = new Map();
        for (const chunk of combinedChunks) {
            let uuid = chain.lkg.uuid;
            for (const b of boundaries) {
                if (chunk.pairStart < b.maxPairEnd) { uuid = b.uuid; break; }
            }
            if (!byAnchor.has(uuid)) byAnchor.set(uuid, []);
            byAnchor.get(uuid).push(chunk);
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
                        await insertSyncChunks(avatarKey, uuid, chatFile, chunks, 0);
                        inserted += chunks.length;
                        succeeded = true;
                        break;
                    } catch {
                        // Ping /health to verify — the tunnel may have dropped the
                        // response even though the server committed the insert.
                        try {
                            const { chunksForAnchor } = await anchorChunkCount(avatarKey, uuid);
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
            log('Maintenance', 'rebuildRag: no lorebook loaded — skipping lb rebuild');
        } else {
            const lbEntries = Object.values(state._draftLorebook.entries);
            await insertLorebookEntries(avatarKey, chain.lkg.uuid, state._lorebookName, lbEntries);
        }

        // ── 5. Rebuild plot lorebook file and re-index plot entry vectors ─────
        const anchorChunks = chain.anchors
            .map(ref => ({ uuid: ref.anchor.uuid, entries: ref.anchor.plotEntries ?? [] }))
            .filter(c => c.entries.length > 0);

        if (anchorChunks.length) {
            const plotLbName = state._plotLorebookName ?? cnzPlotLbName(char.avatar);
            state._plotLorebookName = plotLbName;
            await rebuildPlotLorebook(plotLbName, anchorChunks);
            for (const { uuid, entries } of anchorChunks) {
                await insertLorebookEntries(avatarKey, uuid, plotLbName, entries);
            }
            log('Maintenance', `rebuildRag: plot lorebook rebuilt (${anchorChunks.reduce((n, c) => n + c.entries.length, 0)} entries)`);
        }

    } catch (err) {
        error('Maintenance', 'rebuildRag:', err);
        toastr.error(`CNZ: Rebuild failed: ${err.message}`);
    }
}

