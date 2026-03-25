/**
 * @file data/default-user/extensions/canonize/scheduler.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Stateful Owner
 * @description
 * Scheduler — owns snooze state and the sync-in-progress flag, and drives
 * trigger evaluation. Registers event listeners (ST and bus) for every trigger
 * supplied at init time, evaluates conditions, and emits the declared bus event
 * when a condition is satisfied.
 *
 * No business logic lives here. All decision logic is in trigger conditions
 * declared in recipes.js. The scheduler gathers runtime state (context, messages,
 * DNA chain) and passes it to each condition as a plain object.
 *
 * @api-declaration
 * initScheduler(triggers, getSettings)  — register trigger listeners; must be called once at init.
 * setSyncInProgress(bool)               — set the sync-in-progress flag.
 * isSyncInProgress()                    — read the sync-in-progress flag.
 * snooze(turns, currentCount)           — advance snooze boundary by `turns` from `currentCount`.
 * resetScheduler()                      — clear snooze and sync-in-progress (on char switch).
 * setDnaChain(chain)                    — update the scheduler's copy of the DNA chain.
 * getGap(settings)                      — compute uncommitted gap from current context + DNA chain.
 *
 * @contract
 *   assertions:
 *     purity: stateful
 *     state_ownership: [_snoozeUntilCount, _syncInProgress, _dnaChain, _getSettings, _triggers]
 *     external_io: [SillyTavern.getContext, eventSource]
 */
// ─── CNZ Scheduler ────────────────────────────────────────────────────────────
// Owns snooze/sync-in-progress state and drives trigger evaluation.
// No business logic — all conditions live in Triggers (recipes.js).

import { emit, on } from './bus.js';
import { eventSource } from '../../../../script.js';

// ── Module State ──────────────────────────────────────────────────────────────

let _snoozeUntilCount = 0;
let _syncInProgress   = false;
let _dnaChain         = null;
let _getSettings      = () => ({});
let _triggers         = [];

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Registers event listeners for every trigger. Must be called once at init.
 * @param {object}   triggers    Triggers map (from recipes.js).
 * @param {Function} getSettings Returns current profile settings.
 */
export function initScheduler(triggers, getSettings) {
    _triggers    = Object.values(triggers);
    _getSettings = getSettings;

    for (const trigger of _triggers) {
        if (trigger.source === 'st') {
            eventSource.on(trigger.watchEvent, (eventData) => _evaluate(trigger, eventData));
        } else if (trigger.source === 'bus') {
            on(trigger.watchEvent, (eventData) => _evaluate(trigger, eventData));
        }
    }
}

/**
 * Sets the sync-in-progress flag. Call at the start and end of runCnzSync.
 * @param {boolean} inProgress
 */
export function setSyncInProgress(inProgress) {
    _syncInProgress = inProgress;
}

/**
 * Returns true if a sync cycle is currently running.
 * @returns {boolean}
 */
export function isSyncInProgress() {
    return _syncInProgress;
}

/**
 * Advances the snooze boundary. The auto_sync trigger will not fire until
 * non-system message count exceeds the stored boundary.
 * @param {number} turns        Number of turns to snooze.
 * @param {number} currentCount Current non-system message count.
 */
export function snooze(turns, currentCount) {
    _snoozeUntilCount = currentCount + turns;
    console.log(`[CNZ] Scheduler: snooze until turn ${_snoozeUntilCount}.`);
}

/**
 * Clears snooze and sync-in-progress state. Call on character switch.
 */
export function resetScheduler() {
    _snoozeUntilCount = 0;
    _syncInProgress   = false;
}

/**
 * Updates the scheduler's copy of the DNA chain. Call after every readDnaChain().
 * @param {object|null} chain
 */
export function setDnaChain(chain) {
    _dnaChain = chain;
}

/**
 * Computes the uncommitted gap (turns past the committed boundary that fall
 * outside the live context buffer). Uses current SillyTavern context.
 * @param   {object} settings  Active profile settings.
 * @returns {number}           Gap in non-system message count.
 */
export function getGap(settings) {
    const context = SillyTavern.getContext();
    if (!context) return 0;
    const messages = context.chat ?? [];
    const count    = messages.filter(m => !m.is_system).length;
    const lkgIdx   = _dnaChain?.lkgMsgIdx ?? -1;
    const priorSeq = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system).length
        : 0;
    const lcb = settings.liveContextBuffer ?? 5;
    return Math.max(0, count - lcb) - priorSeq;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _evaluate(trigger, eventData) {
    const context  = SillyTavern.getContext();
    const settings = _getSettings();
    const messages = context?.chat ?? [];
    const count    = messages.filter(m => !m.is_system).length;

    const state = {
        dnaChain:         _dnaChain,
        syncInProgress:   _syncInProgress,
        snoozeUntilCount: _snoozeUntilCount,
        context,
        messages,
        count,
        eventData,
    };

    const payload = trigger.condition(state, settings);
    if (payload != null) emit(trigger.emits, payload);
}
