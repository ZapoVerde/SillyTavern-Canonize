/**
 * @file data/default-user/extensions/canonize/core/scene-tracker.js
 * @architectural-role IO Wrapper
 * @description
 * Listens for `vistalyze:location-changed` DOM events fired by the
 * SillyTavern-Vistalyze extension and stamps the boundary message with
 * `extra.cnz_scene_boundary = true`. These stamps are later read by the
 * VectFox sync pipeline to split transcript text at scene boundaries rather
 * than fixed turn-pair windows.
 *
 * Boundary pairs are included in both the closing and opening slice so that
 * queries spanning a scene transition retrieve it from either side. Max-pairs
 * splits (positional fallback) do not get this overlap.
 *
 * When Vistalyze is not installed or disabled, no events fire and the stamps
 * are never written — the VectFox pipeline falls back to max-pairs splitting.
 *
 * @api-declaration
 * initSceneTracker, buildSceneSlices
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [saveChat]
 */

import { formatPairsAsTranscript } from './transcript.js';

let _initialized = false;

/**
 * Registers the Vistalyze DOM event listener. Safe to call multiple times.
 */
export function initSceneTracker() {
    if (_initialized) return;
    _initialized = true;
    document.addEventListener('vistalyze:location-changed', _handleLocationChanged);
}

async function _handleLocationChanged({ detail }) {
    const messageId = detail?.messageId;
    if (messageId == null) return;
    try {
        const chat = SillyTavern.getContext().chat ?? [];
        const msg = chat[messageId];
        if (!msg) return;
        if (!msg.extra) msg.extra = {};
        msg.extra.cnz_scene_boundary = true;
        await SillyTavern.getContext().saveChat();
    } catch (_) {}
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
