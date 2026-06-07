/**
 * @file data/default-user/extensions/canonize/rag/rag-health.js
 * @stamp {"utc":"2026-06-07T00:00:00.000Z"}
 * @architectural-role IO Wrapper — RAG health telemetry CSV writer
 * @description
 * Appends one row per channel per turn to cnz_rag_health.csv. The CSV is loaded
 * into memory on first write, rows are pushed, and the whole file is flushed back.
 * Failures are logged and swallowed so health tracking never interrupts generation.
 *
 * Columns:
 *   timestamp          — ISO 8601 UTC
 *   character          — avatarKey (truncated to 24 chars for readability)
 *   channel            — chat | lb | plot
 *   provider           — embedding source (openrouter, voyageai, etc.)
 *   model              — embedding model name
 *   candidates         — total items in raw result set (database size proxy)
 *   max_score          — highest cosine in raw result set
 *   min_score          — lowest cosine in raw result set
 *   pool_size          — N_C (candidate pool actually analysed)
 *   local_mean         — μ of the candidate pool
 *   local_median       — median of the candidate pool
 *   local_std_dev      — σ of the candidate pool (floor 0.01)
 *   pearson_skewness   — Sk = 3(μ - median) / σ  [display only, not used for cutoff]
 *   threshold          — score value used as the cutoff line
 *   cutoff_mode        — mean | mean+1sd | mean+2sd
 *   returned           — final items injected
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

const FILE   = 'cnz_rag_health.csv';
const HEADER = 'timestamp,character,channel,provider,model,candidates,max_score,min_score,pool_size,local_mean,local_median,local_std_dev,pearson_skewness,threshold,cutoff_mode,returned';

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
 *   character:       string,
 *   channel:         'chat'|'lb'|'plot',
 *   provider:        string,
 *   model:           string,
 *   candidates:      number,
 *   maxScore:        number,
 *   minScore:        number,
 *   returned:        number,
 *   poolSize:        number|null,
 *   localMean:       number|null,
 *   localMedian:     number|null,
 *   localStdDev:     number|null,
 *   pearsonSkewness: number|null,
 *   threshold:       number|null,
 *   cutoffMode:      string|null,
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
            const char = r.character.slice(0, 24).replace(/,/g, '_');

            _lines.push([
                ts,
                char,
                r.channel,
                r.provider,
                r.model,
                r.candidates,
                _fmt(r.maxScore),
                _fmt(r.minScore),
                r.poolSize     ?? '',
                _fmt(r.localMean),
                _fmt(r.localMedian),
                _fmt(r.localStdDev),
                _fmt(r.pearsonSkewness),
                _fmt(r.threshold),
                r.cutoffMode   ?? '',
                r.returned,
            ].join(','));
        }

        await writeRawFile(FILE, [HEADER, ..._lines].join('\n'));
        log('RagHealth', `CSV updated (${_lines.length} rows)`);
    } catch (err) {
        error('RagHealth', 'failed to write health row:', err);
    }
}
