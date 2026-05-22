/**
 * @file data/default-user/extensions/canonize/log.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Centralised logging wrapper for CNZ. All console output in the extension
 * must go through this module. Raw console.log/warn/error calls are forbidden
 * outside this file.
 *
 * Every message is prefixed with [CNZ:Tag] and added to a rolling in-memory
 * buffer (last 1000 lines). The buffer is flushed to
 * /user/files/cnz_debug.log on the ST server after every error() call
 * (debounced 2 s) and on explicit flushLog() calls. This file persists across
 * page loads and can be read from the filesystem for debugging.
 *
 * log() and warn() are gated behind the verbose flag (off by default).
 * error() always fires regardless of the flag.
 *
 * @api-declaration
 * log(tag, ...args)     — verbose-gated informational output
 * warn(tag, ...args)    — verbose-gated warning output
 * error(tag, ...args)   — always-on error output; flushes immediately
 * setVerbose(enabled)   — enable or disable verbose output at runtime
 * isVerbose()           — returns the current verbose state
 * flushLog()            — manually flush buffer to cnz_debug.log
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/files/upload (cnz_debug.log)]
 */

import { getRequestHeaders } from '../../../../script.js';

// ─── State ────────────────────────────────────────────────────────────────────

let _verbose     = false;
let _flushTimer  = null;
const _buffer    = [];
const BUFFER_MAX = 1000;
const LOG_FILE   = 'cnz_debug.log';

// ─── Buffer ───────────────────────────────────────────────────────────────────

function _formatLine(level, tag, args) {
    const ts  = new Date().toISOString();
    const msg = args.map(a => {
        if (a instanceof Error) return a.stack ?? a.toString();
        try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
        catch (_) { return String(a); }
    }).join(' ');
    return `[${ts}] [${level}:${tag}] ${msg}`;
}

function _addToBuffer(level, tag, args) {
    _buffer.push(_formatLine(level, tag, args));
    if (_buffer.length > BUFFER_MAX) _buffer.shift();
}

// ─── File flush ───────────────────────────────────────────────────────────────

async function _writeToFile() {
    if (_buffer.length === 0) return;
    try {
        const content  = _buffer.join('\n');
        const bytes    = new TextEncoder().encode(content);
        const binary   = Array.from(bytes, b => String.fromCharCode(b)).join('');
        const b64      = btoa(binary);
        await fetch('/api/files/upload', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({ name: LOG_FILE, data: b64 }),
        });
    } catch (_) {
        // Silently swallow — logging the log failure would recurse
    }
}

function _scheduleFlush() {
    if (_flushTimer) clearTimeout(_flushTimer);
    _flushTimer = setTimeout(() => { _flushTimer = null; _writeToFile(); }, 2000);
}

// ─── Console output ───────────────────────────────────────────────────────────

function _output(consoleFn, tag, args) {
    const label = `[CNZ:${tag}] ${String(args[0] ?? '')}`;
    if (args.length <= 1) {
        consoleFn(label);
        return;
    }
    console.groupCollapsed(label);
    args.slice(1).forEach(a => consoleFn(a));
    console.groupEnd();
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function log(tag, ...args) {
    _addToBuffer('LOG', tag, args);
    _scheduleFlush();
    if (!_verbose) return;
    _output(console.log.bind(console), tag, args);
}

export function warn(tag, ...args) {
    _addToBuffer('WARN', tag, args);
    _scheduleFlush();
    if (!_verbose) return;
    _output(console.warn.bind(console), tag, args);
}

export function error(tag, ...args) {
    _addToBuffer('ERROR', tag, args);
    _output(console.error.bind(console), tag, args);
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    _writeToFile();
}

export function setVerbose(enabled) {
    _verbose = !!enabled;
}

export function isVerbose() {
    return _verbose;
}

export function flushLog() {
    if (_flushTimer) { clearTimeout(_flushTimer); _flushTimer = null; }
    return _writeToFile();
}
