/**
 * @file data/default-user/extensions/canonize/core/transcript.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.17
 * @architectural-role Pure Functions
 * @description
 * Pure functions for building transcript strings and prose-pair arrays from
 * raw SillyTavern chat message arrays. No state reads, no IO. Also owns the
 * pair-slicing helpers used by the sync window and modal transcript builders,
 * and the scene-slice builder (moved here from scene-tracker.js).
 *
 * @api-declaration
 * buildProsePairs, buildTranscript, buildProsePairsSlice, slicePairsByBytes,
 * formatPairsAsTranscript, buildSceneSlices
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: [none]
 *     external_io: [none]
 */

// ─── Transcript ───────────────────────────────────────────────────────────────

/**
 * Builds a plain-text transcript from a message array.
 * @param {object[]} messages
 * @returns {string}
 */
export function buildTranscript(messages) {
    return messages
        .filter(m => !m.is_system)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');
}

/**
 * Pairs user+AI messages from a chat into turn objects.
 * Skips system messages. Each pair accumulates all consecutive AI messages
 * following a user message into `messages`.
 * @param {object[]} messages
 * @returns {{user: object, messages: object[], validIdx: number}[]}
 */
export function buildProsePairs(messages) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const pairs = [];
    let current = null;

    for (let i = 0; i < valid.length; i++) {
        const msg = valid[i];
        if (msg.is_user) {
            // Standard: Start a new pair on User message
            if (current) pairs.push(current);
            current = { user: msg, messages: [], validIdx: i };
        } else {
            // If the chat starts with an AI message (no user yet),
            // create a dummy 'System' user so the greeting isn't lost.
            if (!current) {
                current = { user: { name: 'System', mes: 'Story Start' }, messages: [], validIdx: i };
            }
            current.messages.push(msg);
        }
    }
    if (current) pairs.push(current);
    return pairs;
}

/**
 * Returns a slice of `pairs` by pair index range.
 * @param {object[]} pairs
 * @param {number}   start  inclusive
 * @param {number}   end    exclusive
 * @returns {object[]}
 */
export function buildProsePairsSlice(pairs, start, end) {
    return pairs.slice(start, end);
}

/**
 * Formats an array of prose pairs as a bracketed transcript string.
 * Each turn is rendered as `[NAME]\ntext`, turns separated by double newlines.
 * @param {object[]} pairs
 * @returns {string}
 */
export function formatPairsAsTranscript(pairs) {
    return pairs
        .map(p => {
            const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
            for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
            return parts.join('\n\n');
        })
        .join('\n\n');
}

/**
 * Slices `pairs` so the total UTF-8 byte size of all message text stays under
 * `maxBytes`. Counts from the end (most recent pairs kept).
 * @param {object[]} pairs
 * @param {number}   maxBytes
 * @returns {object[]}
 */
export function slicePairsByBytes(pairs, maxBytes) {
    let total = 0;
    const enc = new TextEncoder();
    for (let i = pairs.length - 1; i >= 0; i--) {
        const p    = pairs[i];
        const text = [p.user, ...p.messages].map(m => m.mes ?? '').join('\n');
        total += enc.encode(text).length;
        if (total > maxBytes) {
            return pairs.slice(i + 1);
        }
    }
    return pairs;
}

/**
 * Splits an array of prose pairs into scene slices, using cnz_scene_boundary
 * stamps as split points. Also enforces a hard cap of maxPairs per slice.
 *
 * Scene boundary at pair[i]: the previous slice closes at i (inclusive) and
 * the new slice opens at i — so the boundary pair appears in both chunks.
 *
 * Max-pairs split at pair[i]: previous slice closes at i (exclusive), new
 * slice opens at i. No overlap — the split is positional, not semantic.
 *
 * @param {object[]} pairs    Prose pairs from buildProsePairs.
 * @param {number}   maxPairs Maximum pairs per slice before forcing a split.
 * @returns {{ text: string, pairStart: number, pairEnd: number }[]}
 */
export function buildSceneSlices(pairs, maxPairs) {
    const slices = [];
    let sliceStart = 0;

    for (let i = 1; i < pairs.length; i++) {
        const accumulated = i - sliceStart;
        const pair = pairs[i];

        const isBoundary =
            pair.user?.extra?.cnz_scene_boundary ||
            pair.messages?.some(m => m?.extra?.cnz_scene_boundary);

        if (isBoundary) {
            // Include boundary pair in the closing slice, then start the next from it too.
            const text = formatPairsAsTranscript(pairs.slice(sliceStart, i + 1));
            if (text.trim()) slices.push({ text, pairStart: sliceStart, pairEnd: i + 1 });
            sliceStart = i;
        } else if (accumulated >= maxPairs) {
            // Positional split — no overlap.
            const text = formatPairsAsTranscript(pairs.slice(sliceStart, i));
            if (text.trim()) slices.push({ text, pairStart: sliceStart, pairEnd: i });
            sliceStart = i;
        }
    }

    // Final (possibly open) slice
    if (sliceStart < pairs.length) {
        const text = formatPairsAsTranscript(pairs.slice(sliceStart));
        if (text.trim()) slices.push({ text, pairStart: sliceStart, pairEnd: pairs.length });
    }

    return slices;
}
