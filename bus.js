/**
 * @file data/default-user/extensions/canonize/bus.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Executor
 * @description
 * CNZ event bus — thin wrapper around a plain handler map. No CNZ knowledge.
 * No payload inspection. No routing decisions. Emits and subscribes; that is all.
 *
 * In development mode (`enableDevMode()`), every event is logged to the console
 * as `[BUS] EVENT_NAME payload`. A single console observer shows the entire life
 * of the application. This is a requirement, not a nice-to-have.
 *
 * @api-declaration
 * emit(eventName, payload)  — fire all registered handlers for eventName.
 * on(eventName, handler)    — register a handler.
 * off(eventName, handler)   — deregister a handler.
 * enableDevMode()           — activate console logging for all events.
 *
 * @contract
 *   assertions:
 *     purity: stateful
 *     state_ownership: [_handlers, _devMode]
 *     external_io: []
 */
// ─── CNZ Event Bus ────────────────────────────────────────────────────────────
// Thin event emitter. No CNZ knowledge. No payload inspection. No routing.

const _handlers = {};

export function emit(eventName, payload = {}) {
    if (_devMode) console.log(`[BUS] ${eventName}`, payload);
    const handlers = _handlers[eventName] ?? [];
    for (const handler of handlers) {
        try {
            handler(payload);
        } catch (err) {
            console.error(`[BUS] Handler error on ${eventName}:`, err);
        }
    }
}

export function on(eventName, handler) {
    if (!_handlers[eventName]) _handlers[eventName] = [];
    _handlers[eventName].push(handler);
}

export function off(eventName, handler) {
    if (!_handlers[eventName]) return;
    _handlers[eventName] = _handlers[eventName].filter(h => h !== handler);
}

let _devMode = false;
export function enableDevMode() { _devMode = true; }

// ─── Event Name Reference ─────────────────────────────────────────────────────
// All events used by CNZ. Screaming snake case. Read as plain English facts.
//
// CYCLE_STARTED               { cycleId, seeds }
// CONTRACT_DISPATCHED         { jobId, cycleId, recipeId, inputs, settings, maxTokens, maxRetries }
// JOB_COMPLETED               { jobId, cycleId, recipeId, result, inputs }
// JOB_FAILED                  { jobId, cycleId, recipeId, error, inputs }
// CYCLE_STORE_UPDATED         { cycleId, key, value, error? }
// SYNC_COMPLETED              { cycleId, outcomes }
// MODAL_OPENED                { cycleId }
// CORRECTION_SUBMITTED        { cycleId, corrections }
// DNA_WRITE_REQUESTED         { cycleId, payload }
