/**
 * @file data/default-user/extensions/canonize/log.js
 * @stamp {"utc":"2026-04-08T00:00:00.000Z"}
 * @architectural-role Utility / Central Logger
 * @description
 * Centralised logging wrapper for CNZ.
 *
 * All console output in the extension must go through this module.
 * Raw console.log / console.warn / console.error calls are forbidden
 * outside this file.
 *
 * Behaviour:
 *   - Every message is prefixed with [CNZ:Tag].
 *   - log() and warn() are gated behind the verbose flag (off by default).
 *   - error() always fires regardless of the flag.
 *   - Calls with extra arguments render as a collapsed console group
 *     so the label stays on a single line.
 *
 * Usage:
 *   import { log, warn, error } from './log.js';
 *   log('Sync', 'SYNC START char=Aria');      // → [CNZ:Sync] SYNC START char=Aria
 *   warn('Scheduler', 'Snoozed until pair 5'); // → [CNZ:Scheduler] Snoozed until pair 5
 *   error('DnaChain', 'Write failed:', err);   // → [CNZ:DnaChain] Write failed: (collapsed)
 *
 * @api-declaration
 * log(tag, ...args)        — verbose-gated informational output.
 * warn(tag, ...args)       — verbose-gated warning output.
 * error(tag, ...args)      — always-on error output.
 * setVerbose(enabled)      — enable or disable verbose output at runtime.
 * isVerbose()              — returns the current verbose state.
 */

/** Verbose output is off by default. Enable via the settings panel. */
let _verbose = false;

/**
 * Emits a single labelled line, collapsing any extra arguments into a group.
 * @param {Function} consoleFn  Bound console method (log / warn / error).
 * @param {string}   tag        Module identifier, e.g. 'Sync'.
 * @param {any[]}    args       [message, ...extras]
 */
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

/**
 * Verbose-gated informational log.
 * @param {string} tag
 * @param {...*}   args
 */
export function log(tag, ...args) {
    if (!_verbose) return;
    _output(console.log.bind(console), tag, args);
}

/**
 * Verbose-gated warning.
 * @param {string} tag
 * @param {...*}   args
 */
export function warn(tag, ...args) {
    if (!_verbose) return;
    _output(console.warn.bind(console), tag, args);
}

/**
 * Always-on error output. Not gated by the verbose flag.
 * @param {string} tag
 * @param {...*}   args
 */
export function error(tag, ...args) {
    _output(console.error.bind(console), tag, args);
}

/**
 * Enables or disables verbose (log/warn) output at runtime.
 * Called by the settings panel when the user toggles the verbose checkbox,
 * and on init after settings are loaded.
 * @param {boolean} enabled
 */
export function setVerbose(enabled) {
    _verbose = !!enabled;
}

/**
 * Returns the current verbose state.
 * @returns {boolean}
 */
export function isVerbose() {
    return _verbose;
}
