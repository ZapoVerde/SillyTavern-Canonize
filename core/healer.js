/**
 * @file data/default-user/extensions/canonize/core/healer.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @version 2.2.3
 * @architectural-role Orchestrator
 * @description
 * Branch detection and state restoration. Walks the DNA chain to find the
 * deepest still-valid anchor, then sequences the restore calls to bring
 * lorebook and hooks back into coherence with the current chat position.
 * Also reconciles world state silently when the timeline is intact but external
 * storage has drifted (e.g. left behind by a different chat). Includes auto
 * RAG DB rebuild from chat stamp data when the vector DB is empty.
 *
 * Restore IO lives in healer-restore.js. User-initiated maintenance operations
 * live in maintenance.js (rebuildRag) and maintenance-cleanup.js
 * (runNewChatCleanup, purgeCnzFiles).
 *
 * @api-declaration
 * runHealer(char, chatFileName)
 *
 * Re-exports (from healer-restore.js, for backward compat):
 * restoreLorebookToNode, restoreHooksToNode
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._dnaChain, state._lorebookName]
 *     external_io: [callPopup, toastr, lorebook via healer-restore.js,
 *                   healer-restore.js, scheduler.setDnaChain,
 *                   file-store.js, file-store-lb.js]
 */

import { callPopup, getCurrentChatId } from '../../../../../script.js';
import { state } from '../state.js';
import { readDnaChain, findLkgAnchorByPosition, buildNodeFileFromAnchor, buildAnchorChunkMap } from './dna-chain.js';
import { setDnaChain } from '../scheduler.js';
import { lbGetLorebook } from '../lorebook/api.js';
import { error, log, warn } from '../log.js';
import { restoreLorebookToNode, restoreHooksToNode } from './healer-restore.js';
import { buildProsePairs } from './transcript.js';
import { getStringHash } from '../../../../utils.js';
import { embedCfg, reportEmbedUsage } from '../rag/embed-client.js';
import { embedBatch } from '../rag/embed-direct.js';
import { encodeVec } from '../rag/vec-math.js';
import { insertSyncChunks, listAnchorUuids, deleteAnchor } from '../rag/file-store.js';
import { cnzChatKey, cnzPlotLbName, cnzGetActiveChatKey } from '../rag/api.js';
import { getAnchor, getLbVecMap, loadChatStore, flushChatStore, invalidateVecCache } from '../rag/chat-store.js';
import { rebuildPlotLorebook } from '../lorebook/plot-lorebook.js';
import { lbSetCharacterLorebook } from '../lorebook/api.js';
import { getSettings } from './settings.js';
import { readAddLbStash, writeAddLbStash } from './dna-writer.js';

// Re-export restore ops — callers that import from healer.js keep working.
export { restoreLorebookToNode, restoreHooksToNode } from './healer-restore.js';

// ─── Plot Lorebook Reconciliation ─────────────────────────────────────────────

/**
 * Walks the full DNA chain to rebuild the plot lorebook file and ensure all
 * plot entries are vectorized. Safe to call when the file already exists —
 * the lorebook write is idempotent and insertLorebookEntries uses upsert.
 * No-op if the chain carries no plot entries.
 */
export async function reconcilePlotLorebook(char, chain, chatKey) {
    const anchors = chain?.anchors ?? [];
    const anchorChunks = anchors
        .map(ref => ({ uuid: ref.anchor.uuid, entries: ref.anchor.plotEntries ?? [] }))
        .filter(c => c.entries.length > 0);
    if (!anchorChunks.length) return;

    const plotLbName = chain.lkg?.plotLorebookName ?? cnzPlotLbName(char.avatar);
    state._plotLorebookName = plotLbName;

    try {
        await rebuildPlotLorebook(plotLbName, anchorChunks);
        log('Healer', `Plot lorebook rebuilt: "${plotLbName}" (${anchorChunks.reduce((n, c) => n + c.entries.length, 0)} entries)`);
    } catch (err) {
        error('Healer', 'Plot lorebook rebuild failed:', err);
        return;
    }

    if (!chatKey || chatKey === 'null' || chatKey === 'undefined') return;

    // ── Batch: collect all entries needing vectors across all anchors ──────────
    const store    = await loadChatStore(chatKey);
    const toEmbed  = [];

    for (const { uuid, entries } of anchorChunks) {
        const anchor = store.anchors[uuid] ?? { chunks: [], vecChunks: { content: {}, header: {} }, lbEntries: [], vecLb: { content: {} }, plotHistory: {} };
        store.anchors[uuid] = anchor;
        const vecMap = await getLbVecMap(chatKey, uuid);
        const seen   = new Set(anchor.lbEntries.filter(e => vecMap.has(e.hash)).map(e => e.hash));
        for (const e of entries.filter(e => !e.disable && e.content?.trim())) {
            const hash = getStringHash(e.content);
            if (!seen.has(hash))
                toEmbed.push({ uuid, hash, uid: e.uid, content: e.content, keys: e.key ?? [] });
        }
    }

    if (toEmbed.length) {
        const cfg        = embedCfg();
        const totalChars = toEmbed.reduce((s, t) => s + t.content.length, 0);
        const vecs       = await embedBatch(toEmbed.map(t => t.content), cfg, false);
        reportEmbedUsage(totalChars, cfg.model);

        for (const [i, t] of toEmbed.entries()) {
            const anchor = store.anchors[t.uuid];
            anchor.lbEntries.push({ hash: t.hash, anchorUuid: t.uuid, lorebookName: plotLbName, entryUid: t.uid, entryKeys: t.keys, content: t.content });
            anchor.vecLb.content[t.hash] = encodeVec(vecs[i]);
            invalidateVecCache(chatKey, t.uuid);
        }
        await flushChatStore(chatKey, store);
    }
    log('Healer', `Plot entry vectorization complete: ${toEmbed.length} entries`);
}

// ─── RAG Auto-Reconciliation ──────────────────────────────────────────────────

/**
 * Silently rebuilds the vector DB from cnz_chunk_header stamps already written
 * to chat messages, when RAG is enabled but the DB is empty for this character.
 * No-ops if no stamps are found.
 */
async function _reconcileRagChunks(char, headAnchor, chatKey) {
    if (!chatKey || chatKey === 'null' || chatKey === 'undefined') return;
    try {
        const ctx        = SillyTavern.getContext();
        const allPairs   = buildProsePairs(ctx.chat ?? []);
        const chatFile   = ctx.chatId ?? getCurrentChatId() ?? ctx.characters?.[ctx.characterId]?.chat ?? null;
        const validUuids = new Set(state._dnaChain.anchors.map(r => r.anchor.uuid));

        // ── 1. Purge anchors in store but not in chain ────────────────────────
        const storedUuids = await listAnchorUuids(chatKey);
        for (const uuid of storedUuids) {
            if (!validUuids.has(uuid)) {
                await deleteAnchor(chatKey, uuid);
                log('Healer', `RAG reconcile: purged orphan anchor ${uuid.slice(0, 8)}`);
            }
        }

        // ── 2. Rebuild any anchor where expected chunk hashes are missing or unvectored
        // Full hash comparison: derive content from stamps → hash → check vs store+vecs.
        const byAnchor = buildAnchorChunkMap(state._dnaChain, allPairs, headAnchor.uuid);

        let rebuilt = 0;
        for (const [uuid, chunks] of byAnchor) {
            if (!validUuids.has(uuid)) continue;
            const anchor         = await getAnchor(chatKey, uuid);
            const vecKeys        = new Set(Object.keys(anchor?.vecChunks?.content ?? {}));
            const storedWithVec  = new Set((anchor?.chunks ?? []).filter(c => vecKeys.has(String(c.hash))).map(c => String(c.hash)));
            const expectedHashes = chunks.map(c => String(getStringHash(c.content)));
            if (expectedHashes.length > 0 && expectedHashes.every(h => storedWithVec.has(h))) continue;
            const { inserted } = await insertSyncChunks(chatKey, uuid, chatFile, chunks, 0);
            rebuilt += inserted;
        }
        if (rebuilt > 0) {
            log('Healer', `RAG reconcile: rebuilt ${rebuilt} chunks`);
            toastr.info(`CNZ: Auto-indexed ${rebuilt} chunks from chat history.`);
        }

        // ── 3. Lorebook entries — full check across all anchors ───────────────
        // Collect every lb entry missing a vector, then embed in one batch.
        const store      = await loadChatStore(chatKey);
        const toEmbedLb  = [];

        for (const { anchor } of state._dnaChain.anchors) {
            if (!validUuids.has(anchor.uuid)) continue;
            const lbSnapshot = anchor.lorebook ?? {};
            const lbName     = lbSnapshot.name ?? char?.data?.extensions?.world ?? char?.name;
            if (!lbName) continue;
            const entries = Object.values(lbSnapshot.entries ?? {})
                .filter(e => e.disable !== true && e.content?.trim());
            if (!entries.length) continue;

            const anchorData = store.anchors[anchor.uuid] ??
                { chunks: [], vecChunks: { content: {}, header: {} }, lbEntries: [], vecLb: { content: {} }, plotHistory: {} };
            store.anchors[anchor.uuid] = anchorData;
            const vecMap     = await getLbVecMap(chatKey, anchor.uuid);
            const seenHashes = new Set(anchorData.lbEntries.filter(e => vecMap.has(e.hash)).map(e => e.hash));

            for (const e of entries) {
                const hash = getStringHash(e.content);
                if (!seenHashes.has(hash))
                    toEmbedLb.push({ uuid: anchor.uuid, lbName, hash, uid: e.uid, content: e.content, keys: e.key ?? [] });
            }
        }

        if (toEmbedLb.length) {
            const cfg  = embedCfg();
            const vecs = await embedBatch(toEmbedLb.map(t => t.content), cfg, false);
            reportEmbedUsage(toEmbedLb.reduce((s, t) => s + t.content.length, 0), cfg.model);
            for (const [i, t] of toEmbedLb.entries()) {
                const anchorData = store.anchors[t.uuid];
                anchorData.lbEntries.push({ hash: t.hash, anchorUuid: t.uuid, lorebookName: t.lbName, entryUid: t.uid, entryKeys: t.keys, content: t.content });
                anchorData.vecLb.content[t.hash] = encodeVec(vecs[i]);
                invalidateVecCache(chatKey, t.uuid);
            }
            flushChatStore(chatKey, store);
            log('Healer', `RAG reconcile: indexed ${toEmbedLb.length} lorebook entries across all anchors`);
            toastr.info(`CNZ: Auto-indexed ${toEmbedLb.length} lorebook entries.`);
        }

        // ── 4. Additional lorebook entries — head anchor only ─────────────────
        // state._additionalLorebooks is populated by _restoreAddLbs earlier in runHealer.
        // The JIT path in generation-hook.js skips re-indexing when the content hash
        // matches — so after a purge or rebuild the entries can be absent even though
        // the hash is correct. Check here unconditionally and index anything missing.
        const additionalLbs = state._additionalLorebooks ?? [];
        if (additionalLbs.length) {
            const headAnchorData = store.anchors[headAnchor.uuid] ??
                { chunks: [], vecChunks: { content: {}, header: {} }, lbEntries: [], vecLb: { content: {} }, plotHistory: {} };
            store.anchors[headAnchor.uuid] = headAnchorData;

            const toEmbedAdd = [];
            for (const lb of additionalLbs) {
                try {
                    const disk    = await lbGetLorebook(lb.name);
                    const entries = Object.values(disk?.entries ?? {}).filter(e => !e.disable && e.content?.trim());
                    const vecKeys = new Set(Object.keys(headAnchorData.vecLb.content ?? {}));
                    const indexed = new Set(
                        headAnchorData.lbEntries
                            .filter(e => e.lorebookName === lb.name && vecKeys.has(e.hash))
                            .map(e => e.hash),
                    );
                    for (const e of entries) {
                        const hash = getStringHash(e.content);
                        if (!indexed.has(hash))
                            toEmbedAdd.push({ lbName: lb.name, hash, uid: e.uid, content: e.content, keys: e.key ?? [] });
                    }
                } catch (_) { /* lorebook unreachable — skip */ }
            }

            if (toEmbedAdd.length) {
                const cfg  = embedCfg();
                const vecs = await embedBatch(toEmbedAdd.map(t => t.content), cfg, false);
                reportEmbedUsage(toEmbedAdd.reduce((s, t) => s + t.content.length, 0), cfg.model);
                for (const [i, t] of toEmbedAdd.entries()) {
                    headAnchorData.lbEntries.push({ hash: t.hash, anchorUuid: headAnchor.uuid, lorebookName: t.lbName, entryUid: t.uid, entryKeys: t.keys, content: t.content });
                    headAnchorData.vecLb.content[t.hash] = encodeVec(vecs[i]);
                    invalidateVecCache(chatKey, headAnchor.uuid);
                }
                flushChatStore(chatKey, store);
                log('Healer', `RAG reconcile: indexed ${toEmbedAdd.length} additional lorebook entries`);
                toastr.info(`CNZ: Auto-indexed ${toEmbedAdd.length} additional lorebook entries.`);
            } else {
                log('Healer', `RAG reconcile: additional lorebooks OK (${additionalLbs.length} LB(s), all entries present)`);
            }
        }

    } catch (err) {
        error('Healer', 'RAG reconcile failed:', err);
    }
}

// ─── Silent Reconciliation ────────────────────────────────────────────────────

/**
 * Called when the timeline is intact (head hash matches). Checks whether the
 * lorebook on disk matches the head anchor, and whether the RAG vector DB has
 * chunks for this character. Restores/rebuilds silently if either has drifted.
 * @param {object} char        Current character object from context.
 * @param {object} headAnchor  The head CnzAnchor from the DNA chain.
 */
async function reconcileWorldState(char, headAnchor, chatKey) {
    let lorebookStale = false;
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (lorebookName) {
        try {
            const lbData  = await lbGetLorebook(lorebookName);
            lorebookStale = lbData?.extensions?.cnz_anchor_uuid !== headAnchor.uuid;
        } catch (_) { /* unreachable lorebook — skip */ }
    }

    if (lorebookStale) {
        try {
            const nodeFile  = buildNodeFileFromAnchor(headAnchor);
            const nodeDummy = { nodeId: headAnchor.uuid };

            await restoreLorebookToNode(char, nodeDummy, nodeFile);
            restoreHooksToNode(char, nodeDummy, nodeFile);
            toastr.info('CNZ: World state corrected to match current chat.');
        } catch (err) {
            error('Healer', 'reconcileWorldState failed:', err);
            toastr.warning('CNZ: World state may not match current chat — use Purge & Rebuild if needed.');
        }
    }

    await _reconcileRagChunks(char, headAnchor, chatKey);
    await reconcilePlotLorebook(char, state._dnaChain, chatKey);
}

// ─── Additional-LB stash restore ─────────────────────────────────────────────

/**
 * Sets state._additionalLorebooks from messages[0].extra.cnz_addlb (the stash).
 * If the stash is absent, falls back to the first anchor's additionalLorebooks
 * (one-time migration for chats created before the stash was introduced) and
 * writes it to the stash so future sessions don't need the anchor fallback.
 */
async function _restoreAddLbs(messages) {
    const stash = readAddLbStash(messages);
    if (stash.length) {
        state._additionalLorebooks = stash;
        return;
    }
    const firstAnchor = state._dnaChain.anchors[0]?.anchor;
    const legacy      = firstAnchor?.additionalLorebooks ?? [];
    state._additionalLorebooks = structuredClone(legacy);
    if (legacy.length) {
        await writeAddLbStash(messages, state._additionalLorebooks);
        log('Healer', `Migrated ${legacy.length} additional lorebook(s) from anchor to first-turn stash`);
    }
}

// ─── New Chat Guard ───────────────────────────────────────────────────────────

/**
 * Checks whether the lorebook on disk carries a CNZ anchor UUID that does not
 * match the current (anchor-free) chat, then delegates to runNewChatCleanup.
 * @param {object} char  Current character object from context.
 */
async function maybePromptLorebookCleanup(char) {
    const lorebookName = char?.data?.extensions?.world || char?.name;
    if (!lorebookName) return;
    let lbData;
    try { lbData = await lbGetLorebook(lorebookName); }
    catch (_) { return; }
    if (!lbData?.extensions?.cnz_anchor_uuid) return;
    state._lorebookName = lorebookName;
    const { runNewChatCleanup } = await import('./maintenance-cleanup.js');
    await runNewChatCleanup(char);
}

// ─── Chat Summary ─────────────────────────────────────────────────────────────

function _logChatSummary(messages, chain) {
    const anchorCount = chain.anchors.length;
    const chunkCount  = messages.filter(m => m?.extra?.cnz_chunk_header).length;
    const plotCount   = chain.anchors.reduce((n, r) => n + (r.anchor.plotEntries?.length ?? 0), 0);
    const lkgIdx      = chain.lkgMsgIdx ?? -1;
    const tail        = lkgIdx >= 0 ? messages.slice(lkgIdx + 1) : messages;
    const uncommitted = tail.filter(m => !m.is_system && m.is_user).length;
    log('Healer', `Chat: ${anchorCount} anchor(s) | ${chunkCount} chunk header(s) | ${plotCount} plot entr(ies) | ${uncommitted} uncommitted pair(s) since last anchor`);
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the DNA chain against the current chat history to detect branches.
 * Outcomes:
 *   - Same timeline (head hash matches) → reconcile silently.
 *   - No matching node (pre-CNZ or unrelated chat) → silent return.
 *   - Branch detected → confirm → restore + toastr.warning.
 *   - Restoration failure → toastr.error.
 *
 * @param {object} char           Current character object from context.
 * @param {string} chatFileName  ST chat filename — used to derive the per-chat store key.
 */
export async function runHealer(char, chatFileName) {
    const context  = SillyTavern.getContext();
    const messages = context.chat ?? [];

    state._dnaChain = readDnaChain(messages);
    setDnaChain(state._dnaChain);
    _logChatSummary(messages, state._dnaChain);

    if (state._dnaChain.anchors.length === 0) {
        state._additionalLorebooks = readAddLbStash(messages);
        await maybePromptLorebookCleanup(char);
        return;
    }

    if (!messages.length) return;

    const headRef = state._dnaChain.anchors[state._dnaChain.anchors.length - 1];
    if (messages[headRef.msgIdx]?.extra?.cnz?.uuid === headRef.anchor.uuid) {
        state._lorebookName        = headRef.anchor.lorebook?.name || char?.data?.extensions?.world || char?.name || '';
        state._plotLorebookName    = headRef.anchor.plotLorebookName ?? cnzPlotLbName(char.avatar);
        await _restoreAddLbs(messages);

        // Sync lorebook attachment to match bypass setting.
        if (state._lorebookName) {
            const bypass = getSettings().lbRagOnly ?? false;
            const current = char?.data?.extensions?.world ?? '';
            const want    = bypass ? '' : state._lorebookName;
            if (current !== want) {
                lbSetCharacterLorebook(want).catch(err =>
                    warn('Healer', 'Could not sync lorebook attachment:', err));
            }
        }
        const activeChatKey     = cnzChatKey(chatFileName) ?? cnzGetActiveChatKey();

        if (!activeChatKey || activeChatKey === 'null' || activeChatKey === 'undefined') {
            warn('Healer', 'runHealer: activeChatKey resolved to null/empty — skipping reconciliation');
            return;
        }

        await reconcileWorldState(char, headRef.anchor, activeChatKey);
        return;
    }

    const lkgRef = findLkgAnchorByPosition(state._dnaChain.anchors, messages);
    if (!lkgRef) return;

    const restorePoint = lkgRef.msgIdx + 1;
    const confirmed = await callPopup(
        `<h3>CNZ: Timeline Branch Detected</h3>
        <p>The current chat diverges from the last committed sync point at
        <strong>message ${restorePoint}</strong>.</p>
        <p>CNZ will restore world state to that point:</p>
        <ul>
            <li>Lorebook entries rolled back</li>
            <li>Narrative hooks rolled back</li>
        </ul>
        <p>This cannot be undone.</p>`,
        'confirm',
    );

    if (!confirmed) {
        toastr.warning(
            'CNZ: Timeline branch detected but restoration was cancelled — ' +
            'world state may not match the current chat.',
            '', { timeOut: 0, extendedTimeOut: 0, closeButton: true },
        );
        return;
    }

    try {
        const nodeFile  = buildNodeFileFromAnchor(lkgRef.anchor);
        const nodeDummy = { nodeId: lkgRef.anchor.uuid };

        await restoreLorebookToNode(char, nodeDummy, nodeFile);
        restoreHooksToNode(char, nodeDummy, nodeFile);
        await _restoreAddLbs(messages);

        state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(state._dnaChain);

        toastr.warning(`CNZ: Branch detected — restored to message ${restorePoint}.`);
    } catch (err) {
        error('Healer', 'Healer: restoration failed:', err);
        toastr.error('CNZ: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}