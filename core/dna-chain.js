/**
 * @file data/default-user/extensions/canonize/core/dna-chain.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role Pure Functions
 * @description
 * Pure derivation functions for the DNA chain: scanning chat messages to build
 * the chain, looking up the last-known-good anchor, constructing anchor payloads,
 * and deriving chunk maps for the healer and rebuild pipeline.
 * No IO — callers pass all inputs; writers live in dna-writer.js.
 *
 * @api-declaration
 * readDnaChain, getLkgAnchor, buildAnchorPayload, findLastAiMessageInPair,
 * buildNodeFileFromAnchor, findLkgAnchorByPosition, sanitizeDnaChain,
 * buildAnchorBoundaries, buildAnchorChunkMap
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: [none]
 *     external_io: [none]
 */

import { formatPairsAsTranscript } from './transcript.js';

// ─── Types (JSDoc only — no runtime impact) ───────────────────────────────────

/**
 * @typedef {object} AdditionalLorebook
 * @property {string}  name    - lorebook filename
 * @property {number}  hash    - getStringHash of enabled entry content at last vectorisation
 * @property {number}  min     - distributional cutoff lower bound
 * @property {number}  max     - distributional cutoff upper bound
 * @property {boolean} bypass  - true → inject directly into prompt; false → WORLDINFO_FORCE_ACTIVATE
 */

/**
 * @typedef {object} CnzAnchor
 * @property {'anchor'}           type               - discriminant
 * @property {string}             uuid               - crypto.randomUUID() at commit time
 * @property {string}             committedAt        - ISO timestamp
 * @property {string}             hooks              - hookseeker text committed this cycle
 * @property {object}             lorebook           - full lorebook snapshot { name, entries }
 * @property {RagHeaderEntry[]}   ragHeaders         - chunk headers committed this cycle
 * @property {string|null}        parentUuid         - uuid of previous anchor, or null
 * @property {AdditionalLorebook[]} additionalLorebooks - read-only reference lorebooks active this session
 */

/**
 * @typedef {object} CnzLink
 * @property {'link'}  type
 * @property {string}  uuid         - same uuid as the Anchor for this block
 * @property {number}  seq          - this pair's non-system position
 */

/**
 * @typedef {object} RagHeaderEntry
 * @property {number} chunkIndex
 * @property {string} header
 * @property {string} turnRange  - human-readable range string, e.g. "turns 1–12"
 * @property {number} pairStart  - absolute pair index of chunk start (inclusive)
 * @property {number} pairEnd    - absolute pair index of chunk end (exclusive)
 */

/**
 * @typedef {object} AnchorRef
 * @property {CnzAnchor} anchor
 * @property {number}    msgIdx  - index of this anchor's message in messages[]
 */

/**
 * @typedef {object} DnaChain
 * @property {CnzAnchor|null} lkg         - most recent valid anchor
 * @property {number}         lkgMsgIdx   - index of lkg in messages[], -1 if none
 * @property {object|null}    lkgAnchorMsg - the full message object carrying lkg
 * @property {AnchorRef[]}    anchors      - all anchors, chronological order
 */

// ─── DNA Chain ────────────────────────────────────────────────────────────────

/**
 * Returns the last AI (non-user, non-system) message in a prose pair.
 * @param {{user: object, messages: object[], validIdx: number}} pair
 * @returns {object|null}
 */
export function findLastAiMessageInPair(pair) {
    for (let i = pair.messages.length - 1; i >= 0; i--) {
        const msg = pair.messages[i];
        if (!msg.is_user && !msg.is_system) return msg;
    }
    return null;
}

/**
 * Walks the full messages array and builds the DnaChain from embedded anchor data.
 * @param {object[]} messages - SillyTavern.getContext().chat
 * @returns {DnaChain}
 */
export function readDnaChain(messages) {
    const result = { lkg: null, lkgMsgIdx: -1, lkgAnchorMsg: null, anchors: [] };
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.extra) continue;
        if (!msg.extra.cnz) continue;
        const cnz = msg.extra.cnz;
        if (!cnz.type) continue;
        if (cnz.type === 'anchor') {
            result.anchors.push({ anchor: cnz, msgIdx: i });
        }
        // links are ignored — not needed by current consumers
    }
    if (result.anchors.length > 0) {
        const last = result.anchors[result.anchors.length - 1];
        result.lkg         = last.anchor;
        result.lkgMsgIdx   = last.msgIdx;
        result.lkgAnchorMsg = messages[last.msgIdx];
    }
    return result;
}

/**
 * Convenience wrapper — returns { anchor, msgIdx } for the most recent anchor, or null.
 * @param {object[]} messages
 * @returns {{ anchor: CnzAnchor, msgIdx: number }|null}
 */
export function getLkgAnchor(messages) {
    const chain = readDnaChain(messages);
    return chain.lkg ? { anchor: chain.lkg, msgIdx: chain.lkgMsgIdx } : null;
}

/**
 * Builds the CnzAnchor payload for embedding in message.extra.cnz.
 * Pure function — all inputs passed explicitly.
 * @param {object} params
 * @param {string}            params.uuid              - crypto.randomUUID() from the caller
 * @param {string}            params.committedAt       - ISO timestamp from the caller
 * @param {string}               params.scene                - SCENE prose from the hookseeker this cycle
 * @param {string}               params.hooks                - legacy alias for scene; kept for backward compat
 * @param {string|null}          params.plotLorebookName     - plot lorebook filename, or null
 * @param {object}               params.lorebook             - full lorebook snapshot { name, entries }
 * @param {RagHeaderEntry[]}     params.ragHeaders           - chunk headers committed this cycle
 * @param {string|null}          params.parentUuid           - uuid of previous anchor, or null
 * @param {AdditionalLorebook[]} params.additionalLorebooks  - active read-only lorebook references
 * @returns {CnzAnchor}
 */
export function buildAnchorPayload({ uuid, committedAt, scene, hooks, plotLorebookName, plotEntries, lorebook, ragHeaders, parentUuid, additionalLorebooks }) {
    return {
        type: 'anchor',
        uuid,
        committedAt,
        scene:               scene ?? hooks ?? '',
        plotLorebookName:    plotLorebookName ?? null,
        plotEntries:         plotEntries ?? [],
        lorebook:            structuredClone(lorebook),
        ragHeaders:          ragHeaders ?? [],
        parentUuid:          parentUuid ?? null,
        additionalLorebooks: structuredClone(additionalLorebooks ?? []),
    };
}

/**
 * Builds a nodeFile-shaped object from a CnzAnchor so the existing restore
 * functions (restoreLorebookToNode, restoreHooksToNode) can consume DNA-chain
 * anchors without modification.
 * Pure function — no state reads, no IO.
 * @param {CnzAnchor} anchor
 * @returns {{ state: { uuid: string|null, scene: string, lorebook: object, plotLorebookName: string|null } }}
 */
export function buildNodeFileFromAnchor(anchor) {
    return {
        state: {
            uuid:                anchor.uuid                ?? null,
            scene:               anchor.scene               ?? anchor.hooks ?? '',
            plotLorebookName:    anchor.plotLorebookName    ?? null,
            plotEntries:         anchor.plotEntries         ?? [],
            lorebook:            anchor.lorebook            ?? { entries: {} },
            additionalLorebooks: anchor.additionalLorebooks ?? [],
        },
    };
}

/**
 * Walks anchors newest-first and returns the first AnchorRef whose message
 * still sits at its original index in the current chat with the same UUID.
 * This is the branch-detection primitive — an anchor is valid if the chat
 * has not been modified at or after that point.
 * Pure function — no state reads, no IO.
 * @param {{ anchor: CnzAnchor, msgIdx: number }[]} anchors  From _dnaChain.anchors (chronological).
 * @param {object[]} messages  Current chat array.
 * @returns {{ anchor: CnzAnchor, msgIdx: number }|null}
 */
export function findLkgAnchorByPosition(anchors, messages) {
    for (let i = anchors.length - 1; i >= 0; i--) {
        const ref = anchors[i];
        if (messages[ref.msgIdx]?.extra?.cnz?.uuid === ref.anchor.uuid) {
            return ref;
        }
    }
    return null;
}

/**
 * No-op stub retained for API continuity.
 * @param {object} chain
 * @returns {object}
 */
export function sanitizeDnaChain(chain) {
    return chain;
}

// ─── Chunk Map Helpers ────────────────────────────────────────────────────────

/**
 * Derives the sorted pairEnd boundaries used to assign pair ranges to anchors.
 * @param {object} chain  DNA chain from readDnaChain.
 * @returns {{ uuid: string, maxPairEnd: number }[]}
 */
export function buildAnchorBoundaries(chain) {
    return chain.anchors
        .map(({ anchor }) => ({
            uuid:       anchor.uuid,
            maxPairEnd: (anchor.ragHeaders ?? []).reduce((m, rh) => Math.max(m, rh.pairEnd ?? 0), 0),
        }))
        .filter(b => b.maxPairEnd > 0)
        .sort((a, b) => a.maxPairEnd - b.maxPairEnd);
}

/**
 * Single-pass scan: finds cnz_chunk_header stamps in allPairs, derives chunk
 * content and metadata, and groups chunks by anchor UUID using pairEnd boundaries.
 * Returns a Map<uuid, chunk[]> ready for insertSyncChunks.
 * @param {object}   chain           DNA chain from readDnaChain.
 * @param {object[]} allPairs        Full pair list from buildProsePairs.
 * @param {string}   headAnchorUuid  Fallback UUID for un-boundaried stamps.
 * @returns {Map<string, object[]>}
 */
export function buildAnchorChunkMap(chain, allPairs, headAnchorUuid) {
    const boundaries = buildAnchorBoundaries(chain);
    const byAnchor   = new Map();
    let prevEnd      = 0;
    for (let i = 0; i < allPairs.length; i++) {
        const pair    = allPairs[i];
        const lastMsg = pair?.messages?.[pair.messages.length - 1];
        if (!lastMsg?.extra?.cnz_chunk_header) continue;
        const content = formatPairsAsTranscript(allPairs.slice(prevEnd, i + 1));
        let uuid = headAnchorUuid;
        for (const b of boundaries) { if (prevEnd < b.maxPairEnd) { uuid = b.uuid; break; } }
        if (!byAnchor.has(uuid)) byAnchor.set(uuid, []);
        byAnchor.get(uuid).push({
            chunkIndex: byAnchor.get(uuid).length,
            header:     lastMsg.extra.cnz_chunk_header,
            turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${prevEnd + 1}–${i + 1}`,
            content, pairStart: prevEnd, pairEnd: i + 1, status: 'complete',
        });
        prevEnd = i + 1;
    }
    return byAnchor;
}
