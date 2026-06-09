/**
 * @file data/default-user/extensions/canonize/rag/rag-timing.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Formats and logs the per-generation RAG timing breakdown. Receives the
 * timing snapshot from generation-hook.js; owns no state.
 *
 * @api-declaration
 * ms(t) → string
 * printTimingSummary(timing, tEnd) → void
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

import { log } from '../log.js';

export function ms(t) { return t != null ? `${Math.round(t)}ms` : '?'; }

/**
 * Logs the full timing breakdown for one generation cycle.
 * @param {{ tSend, tInterceptor, tRagDone, tFirstToken, prefetchHit }} timing
 * @param {number} tEnd  performance.now() at generation end
 */
export function printTimingSummary(timing, tEnd) {
    if (!timing) return;
    const t = timing;

    const prefetchWindow = t.tSend != null && t.tInterceptor != null
        ? t.tInterceptor - t.tSend : null;
    const ragCost = t.tInterceptor != null && t.tRagDone != null
        ? t.tRagDone - t.tInterceptor : null;
    const ttft = t.tRagDone != null && t.tFirstToken != null
        ? t.tFirstToken - t.tRagDone : null;
    const streaming = t.tFirstToken != null
        ? tEnd - t.tFirstToken : null;
    const total = t.tSend != null ? tEnd - t.tSend : null;

    const prefetchLabel = t.tSend == null
        ? 'no prefetch (swipe/regen)'
        : t.prefetchHit
            ? 'HIT — embed pre-settled, ~0ms blocking'
            : 'MISS — embed ran in interceptor';

    const lines = [
        '── CNZ Generation Timing ──────────────────────────────',
        `  prefetch window  send→interceptor: ${prefetchWindow != null ? ms(prefetchWindow) : 'n/a (swipe/regen)'}  [concurrent with ST pipeline]`,
        `  RAG interceptor  (blocking):       ${ms(ragCost)}  [prefetch: ${prefetchLabel}]`,
        `  prompt build + TTFT:               ${ttft != null ? ms(ttft) : 'n/a (non-streaming)'}`,
        `  streaming        1st→last token:   ${streaming != null ? ms(streaming) : 'n/a'}`,
        '  ────────────────────────────────────────────────────',
        `  total            send→last token:  ${total != null ? ms(total) : ms(ragCost != null ? tEnd - t.tInterceptor : null) + ' (interceptor→end)'}`,
    ];
    log('Perf', lines.join('\n'));
}
