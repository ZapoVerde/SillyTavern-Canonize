/**
 * @file data/default-user/extensions/canonize/core/window.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Pure logic for calculating sync windows and uncommitted gaps. Owns the 
 * math behind determining which prose pairs fall between the DNA chain 
 * head and the live context buffer.
 *
 * @api-declaration
 * computeSyncWindow, deriveLastCommittedPairs
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: [none]
 *     external_io: [none]
 */

/**
 * Computes the pair slice for a sync cycle, anchored to the DNA chain head.
 * 
 * Standard mode: first chunkEveryN uncommitted pairs after the LKG anchor.
 * CoverAll mode: all uncommitted pairs from the LKG anchor to the live context 
 *                buffer boundary.
 *
 * "Uncommitted" means validIdx >= priorSeq (after the LKG anchor) AND
 * validIdx < tbb (before the live context buffer).
 *
 * @param {object[]} allPairs   Full pair array from buildProsePairs(messages).
 * @param {object[]} messages   Full chat message array.
 * @param {object}   settings   Active profile settings.
 * @param {boolean}  coverAll   true = full gap, false = standard window.
 * @param {object}   dnaChain   Current _dnaChain value (may be null).
 * @returns {{ syncPairs: object[], syncPairOffset: number }}
 */
export function computeSyncWindow(allPairs, messages, settings, coverAll, dnaChain) {
    const lcb   = settings.liveContextBuffer ?? 5;
    const every = settings.chunkEveryN ?? 20;
    const tbb   = Math.max(0, allPairs.length - lcb);   // trailing buffer boundary in pairs

    // Non-system turns committed up to and including the LKG anchor message.
    const lkgIdx   = dnaChain?.lkgMsgIdx ?? -1;
    const priorSeq = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system).length
        : 0;

    // Pairs that lie in the uncommitted gap (after committed boundary, before live buffer).
    const uncommitted = allPairs.filter((p, i) => p.validIdx >= priorSeq && i < tbb);

    const syncPairs = coverAll ? uncommitted : uncommitted.slice(0, every);

    const firstPair      = syncPairs[0];
    const syncPairOffset = firstPair ? allPairs.indexOf(firstPair) : 0;

    return { syncPairs, syncPairOffset };
}

/**
 * Derives the prose-pair slice that was committed in the most recent sync cycle.
 * Inverse of computeSyncWindow — returns the pairs between the parent anchor and 
 * the head anchor rather than the uncommitted pairs after the head.
 *
 * @param {object[]} allPairs   Full pair array from buildProsePairs(messages).
 * @param {object[]} messages   Full chat message array.
 * @param {object}   dnaChain   Current _dnaChain value (may be null).
 * @returns {{ pairs: object[], pairOffset: number }}
 */
export function deriveLastCommittedPairs(allPairs, messages, dnaChain) {
    const anchors = dnaChain?.anchors ?? [];
    if (anchors.length === 0) return { pairs: [], pairOffset: 0 };

    const headRef   = anchors[anchors.length - 1];
    const parentRef = anchors.length >= 2 ? anchors[anchors.length - 2] : null;

    const headPriorSeq   = messages.slice(0, headRef.msgIdx + 1).filter(m => !m.is_system).length;
    const parentPriorSeq = parentRef
        ? messages.slice(0, parentRef.msgIdx + 1).filter(m => !m.is_system).length
        : 0;

    const pairs      = allPairs.filter(p => p.validIdx >= parentPriorSeq && p.validIdx < headPriorSeq);
    const pairOffset = pairs.length > 0 ? allPairs.indexOf(pairs[0]) : 0;

    return { pairs, pairOffset };
}