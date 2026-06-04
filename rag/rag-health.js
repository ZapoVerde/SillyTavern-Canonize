/**
 * @file data/default-user/extensions/canonize/rag/rag-health.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role IO Wrapper — RAG health telemetry CSV writer
 * @description
 * Appends one row per channel per turn to cnz_rag_health.csv. The CSV is loaded
 * into memory on first write, rows are pushed, and the whole file is flushed back.
 * Failures are logged and swallowed so health tracking never interrupts generation.
 *
 * Columns:
 *   timestamp     — ISO 8601 UTC
 *   character     — avatarKey (truncated to 24 chars for readability)
 *   channel       — chat | lb | plot
 *   provider      — embedding source (openrouter, voyageai, etc.)
 *   model         — embedding model name
 *   candidates    — total items before distributional cutoff
 *   max_score     — highest cosine in candidate set
 *   min_score     — lowest cosine in candidate set
 *   mean_score    — μ (the mean cutoff threshold)
 *   slope         — (max - min) / candidates — average drop per rank
 *   signal_str    — (max - min) / max — normalised spread
 *   signal_pass   — whether signal_str ≥ threshold (mean cutoff ran)
 *   returned      — items after cutoff
 *   clamped       — true if returned === max (ceiling hit; consider raising max)
 *
 * @api-declaration
 * appendHealthRows(rows: HealthRow[]) → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [_lines (in-memory CSV buffer)]
 *     external_io:     [GET /user/files/cnz_rag_health.csv,
 *                       POST /api/files/upload]
 */

import { readRawFile, writeRawFile } from './file-io.js';
import { log, error } from '../log.js';

const FILE    = 'cnz_rag_health.csv';
const HEADER  = 'timestamp,character,channel,provider,model,candidates,max_score,min_score,mean_score,slope,signal_str,signal_pass,returned,clamped';

// In-memory line buffer. Null until first write initialises from disk.
let _lines = null;

async function _ensureLoaded() {
    if (_lines !== null) return;
    const existing = await readRawFile(FILE);
    if (existing) {
        _lines = existing.split('\n').filter(l => l.trim());
        // Strip stale header if present so we always re-emit a fresh one at top.
        if (_lines[0]?.startsWith('timestamp')) _lines.shift();
    } else {
        _lines = [];
    }
}

function _fmt(n) { return Number.isFinite(n) ? n.toFixed(4) : ''; }

/**
 * @typedef {{
 *   character:    string,
 *   channel:      'chat'|'lb'|'plot',
 *   provider:     string,
 *   model:        string,
 *   candidates:   number,
 *   maxScore:     number,
 *   minScore:     number,
 *   meanScore:    number,
 *   signalThresh: number,
 *   returned:     number,
 *   max:          number,
 * }} HealthRow
 */

/**
 * Appends one CSV row per entry in rows.
 * Skips entries where candidates === 0.
 * @param {HealthRow[]} rows
 */
export async function appendHealthRows(rows) {
    const active = rows.filter(r => r.candidates > 0);
    if (!active.length) return;

    try {
        await _ensureLoaded();

        const ts = new Date().toISOString();

        for (const r of active) {
            const slope       = r.candidates > 0 ? (r.maxScore - r.minScore) / r.candidates : 0;
            const signalStr   = r.maxScore > 0 ? (r.maxScore - r.minScore) / r.maxScore : 0;
            const signalPass  = signalStr >= r.signalThresh;
            const clamped     = r.returned === r.max && r.candidates > r.max;
            const char        = r.character.slice(0, 24).replace(/,/g, '_');

            _lines.push([
                ts,
                char,
                r.channel,
                r.provider,
                r.model,
                r.candidates,
                _fmt(r.maxScore),
                _fmt(r.minScore),
                _fmt(r.meanScore),
                _fmt(slope),
                _fmt(signalStr),
                signalPass,
                r.returned,
                clamped,
            ].join(','));
        }

        await writeRawFile(FILE, [HEADER, ..._lines].join('\n'));
        log('RagHealth', `CSV updated (${_lines.length} rows)`);
    } catch (err) {
        error('RagHealth', 'failed to write health row:', err);
    }
}
