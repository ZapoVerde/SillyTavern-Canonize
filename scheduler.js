/**
 * @file data/default-user/extensions/canonize/scheduler.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Stateful Owner
 * @description
 * Scheduler — owns snooze state and the sync-in-progress flag, and drives
 * trigger evaluation. Registers event listeners (ST and bus) for every trigger
 * supplied at init time.
 *
 * @api-declaration
 * initScheduler(triggers, getSettings)  — register trigger listeners.
 * setSyncInProgress(bool)               — set the sync-in-progress flag.
 * isSyncInProgress()                    — read the sync-in-progress flag.
 * snooze(pairs, currentPairCount)       — advance snooze boundary.
 * resetScheduler()                      — clear snooze and sync-in-progress.
 * setDnaChain(chain)                    — update the scheduler's copy of the DNA chain.
 * getGap(settings)                      — compute uncommitted gap.
 *
 * @contract
 *   assertions:
 *     purity: stateful
 *     state_ownership: [_snoozeUntilCount, _syncInProgress, _dnaChain, _getSettings, _triggers]
 *     external_io: [SillyTavern.getContext, eventSource]
 */

import { emit, on, BUS_EVENTS } from './bus.js';
import { log } from './log.js';
import { eventSource } from '../../../../script.js';
import { isExtensionEnabled } from './core/settings.js';

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
 * Advances the snooze boundary.
 * @param {number} pairs            Number of pairs to snooze.
 * @param {number} currentPairCount Current pair count.
 */
export function snooze(pairs, currentPairCount) {
    _snoozeUntilCount = currentPairCount + pairs;
    log('Scheduler', `snooze until pair ${_snoozeUntilCount}`);
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
 * Computes the uncommitted gap in pairs.
 * @param   {object} settings  Active profile settings.
 * @returns {number}           Gap in prose pairs.
 */
export function getGap(settings) {
    const context = SillyTavern.getContext();
    if (!context) return 0;
    const messages   = context.chat ?? [];
    const pairCount  = messages.filter(m => !m.is_system && m.is_user).length;
    const lkgIdx     = _dnaChain?.lkgMsgIdx ?? -1;
    const priorPairs = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system && m.is_user).length
        : 0;
    const lcb = settings.liveContextBuffer ?? 5;
    return Math.max(0, pairCount - lcb) - priorPairs;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function _evaluate(trigger, eventData) {
    // Master Bypass: If the engine is disabled, do not evaluate triggers.
    if (!isExtensionEnabled()) return;

    const context  = SillyTavern.getContext();
    const settings = _getSettings();
    const messages = context?.chat ?? [];
    const count     = messages.filter(m => !m.is_system).length;
    const pairCount = messages.filter(m => !m.is_system && m.is_user).length;

    const state = {
        dnaChain:         _dnaChain,
        syncInProgress:   _syncInProgress,
        snoozeUntilCount: _snoozeUntilCount,
        context,
        messages,
        count,
        pairCount,
        eventData,
    };

    // Per-turn status — fires on every MESSAGE_RECEIVED
    if (trigger.id === 'auto_sync') {
        _logTurnStatus(state, settings);
    }

    const payload = trigger.condition(state, settings);
    if (payload != null) emit(trigger.emits, payload);
}

function _logTurnStatus(state, settings) {
    const { dnaChain, messages, pairCount, syncInProgress, snoozeUntilCount } = state;
    const every = settings.chunkEveryN ?? 20;
    const lcb   = settings.liveContextBuffer ?? 5;
    const lkgIdx     = dnaChain?.lkgMsgIdx ?? -1;
    const priorPairs = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system && m.is_user).length
        : 0;
    const trailingBoundary = Math.max(0, pairCount - lcb);
    const gap              = trailingBoundary - priorPairs;

    const anchorPart = lkgIdx >= 0
        ? `anchor @msg${lkgIdx} | committed=${priorPairs} pairs | +${pairCount - priorPairs} since anchor`
        : `no anchor | ${pairCount} pair(s) from start`;

    let syncStatus;
    if (!settings.autoSync)              syncStatus = 'auto-sync off';
    else if (syncInProgress)             syncStatus = 'sync in progress';
    else if (pairCount <= snoozeUntilCount) syncStatus = `snoozed until pair ${snoozeUntilCount}`;
    else if (gap < every)                syncStatus = `gap=${gap}/${every} — waiting`;
    else                                 syncStatus = `gap=${gap}/${every} — TRIGGERING`;

    log('Scheduler', `▸ turn | pairs=${pairCount} | ${anchorPart} | ${syncStatus}`);
}