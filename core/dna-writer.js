/**
 * @file data/default-user/extensions/canonize/core/dna-writer.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Writes CNZ anchor and link payloads into SillyTavern chat messages and
 * persists via saveChat. Contains no derivation logic — callers build the
 * payloads (via dna-chain.js) and pass them in.
 *
 * @api-declaration
 * writeDnaAnchor(pair, anchor) — embeds a CnzAnchor into the last AI message of a pair and saves.
 * writeDnaLinks(pairs, anchorIdx, uuid, pairOffset) — stamps CnzLink back-pointers and saves once.
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/chats/saveChat]
 */

import { warn, error } from '../log.js';
import { findLastAiMessageInPair } from './dna-chain.js';

// ── Additional-lorebook stash ─────────────────────────────────────────────────
// Persists the additional-LB list on the very first chat message (messages[0]).
// That position is stable across all timeline operations — branches, restores,
// and anchor commits never touch messages[0].extra.cnz_addlb.

export function readAddLbStash(messages) {
    return structuredClone(messages?.[0]?.extra?.cnz_addlb ?? []);
}

export async function writeAddLbStash(messages, list) {
    const msg = messages?.[0];
    if (!msg) return;
    msg.extra ??= {};
    msg.extra.cnz_addlb = structuredClone(list);
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        error('DnaChain', 'writeAddLbStash: saveChat failed:', err);
    }
}

/**
 * Writes a CnzAnchor payload into the last AI message of the given pair,
 * then saves the chat.
 * @param {object} pair
 * @param {import('./dna-chain.js').CnzAnchor} anchor
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
 * Writes CnzLink back-pointers into every pair in the range except the anchor
 * pair, then saves the chat once.
 * @param {object[]} pairs
 * @param {number}   anchorIdx
 * @param {string}   uuid
 * @param {number}   pairOffset
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
