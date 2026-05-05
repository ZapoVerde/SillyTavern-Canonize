/**
 * @file data/default-user/extensions/canonize/core/dna-chain.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role Stateful Owner
 * @description
 * Owns the DNA chain read/write lifecycle: scanning chat messages to build the
 * chain, looking up the last-known-good anchor, constructing anchor payloads,
 * and writing anchors and back-pointer links into chat messages. Also owns
 * the `readCnzSummaryPromptState` helper and `sanitizeDnaChain` stubs retained
 * for API continuity.
 *
 * @api-declaration
 * readDnaChain, getLkgAnchor, buildAnchorPayload, writeDnaAnchor, writeDnaLinks,
 * findLastAiMessageInPair, buildNodeFileFromAnchor, findLkgAnchorByPosition,
 * sanitizeDnaChain
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/chats/saveChat]
 */

import { warn, error } from '../log.js';

// ─── Types (JSDoc only — no runtime impact) ───────────────────────────────────

/**
 * @typedef {object} CnzAnchor
 * @property {'anchor'}        type        - discriminant
 * @property {string}          uuid        - crypto.randomUUID() at commit time
 * @property {string}          committedAt - ISO timestamp
 * @property {string}          hooks       - hookseeker text committed this cycle
 * @property {object}          lorebook    - full lorebook snapshot { name, entries }
 * @property {string|null}     ragUrl      - Data Bank URL of the RAG file, or null
 * @property {RagHeaderEntry[]} ragHeaders - chunk headers committed this cycle
 * @property {string|null}     parentUuid  - uuid of previous anchor, or null
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
        if (!cnz.type) {
            warn('DnaChain', 'readDnaChain: message at index', i, 'has malformed cnz object (missing type)');
            continue;
        }
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
 * @param {string}            params.uuid         - crypto.randomUUID() from the caller
 * @param {string}            params.committedAt  - ISO timestamp from the caller
 * @param {string}            params.hooks        - hookseeker text committed this cycle
 * @param {object}            params.lorebook     - full lorebook snapshot { name, entries }
 * @param {string|null}       params.ragUrl       - uploaded RAG file URL, or null
 * @param {RagHeaderEntry[]}  params.ragHeaders   - chunk headers committed this cycle
 * @param {string|null}       params.parentUuid   - uuid of previous anchor, or null
 * @returns {CnzAnchor}
 */
export function buildAnchorPayload({ uuid, committedAt, hooks, lorebook, ragUrl, ragHeaders, parentUuid }) {
    return {
        type: 'anchor',
        uuid,
        committedAt,
        hooks,
        lorebook:    structuredClone(lorebook),
        ragUrl:      ragUrl ?? null,
        ragHeaders:  ragHeaders ?? [],
        parentUuid:  parentUuid ?? null,
    };
}

/**
 * Writes a CnzAnchor payload into the last AI message of the given pair,
 * then saves the chat. The message becomes the Anchor for this sync cycle.
 *
 * If the pair has no AI message, logs a warning and returns without writing.
 *
 * @param {object} pair       - prose pair object (from buildProsePairs)
 * @param {CnzAnchor} anchor  - payload from buildAnchorPayload
 * @returns {Promise<void>}
 */
export async function writeDnaAnchor(pair, anchor) {
    const msg = findLastAiMessageInPair(pair);
    if (!msg) {
        warn('DnaChain', 'writeDnaAnchor: no AI message in pair — skipping');
        return;
    }
    msg.extra ??= {};
    msg.extra.cnz = anchor;
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        error('DnaChain', 'writeDnaAnchor: saveChat failed:', err);
    }
}

/**
 * Writes a CnzLink back-pointer into the last AI message of each pair in
 * the given range, then saves the chat once. Skips the anchor pair itself
 * (it already carries the full CnzAnchor). Skips pairs with no AI message.
 *
 * @param {object[]} pairs      - all prose pairs in the sync block
 * @param {number}   anchorIdx  - index of the anchor pair within `pairs`; that pair is skipped
 * @param {string}   uuid       - the sync block's uuid (same as the anchor's uuid)
 * @param {number}   pairOffset - absolute pair index of pairs[0] in the full chat
 * @returns {Promise<void>}
 */
export async function writeDnaLinks(pairs, anchorIdx, uuid, pairOffset) {
    let wrote = false;
    for (let i = 0; i < pairs.length; i++) {
        if (i === anchorIdx) continue;
        const msg = findLastAiMessageInPair(pairs[i]);
        if (!msg) continue;
        msg.extra ??= {};
        msg.extra.cnz = {
            type: 'link',
            uuid,
            seq: pairOffset + i,
        };
        wrote = true;
    }
    if (!wrote) return;
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        error('DnaChain', 'writeDnaLinks: saveChat failed:', err);
    }
}

/**
 * Builds a nodeFile-shaped object from a CnzAnchor so the existing restore
 * functions (restoreLorebookToNode, restoreHooksToNode, restoreRagToNode) can
 * consume DNA-chain anchors without modification.
 * Pure function — no state reads, no IO.
 * @param {CnzAnchor} anchor
 * @returns {{ state: { uuid: string|null, hooks: string, lorebook: object, ragFiles: string[] } }}
 */
export function buildNodeFileFromAnchor(anchor) {
    let ragFiles = [];
    if (anchor.ragUrl) {
        const fileName = anchor.ragUrl.split('/').pop();
        if (fileName) ragFiles = [fileName];
    }
    return {
        state: {
            uuid:     anchor.uuid ?? null,
            hooks:    anchor.hooks ?? '',
            lorebook: anchor.lorebook ?? { entries: {} },
            ragFiles,
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
