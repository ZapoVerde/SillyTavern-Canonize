/**
 * @file data/default-user/extensions/canonize/core/scene-tracker.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.17
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
 * Pure derivation (buildSceneSlices) lives in core/transcript.js.
 *
 * @api-declaration
 * initSceneTracker
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [saveChat]
 */

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
