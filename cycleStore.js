/**
 * @file data/default-user/extensions/canonize/cycleStore.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Stateful Owner
 * @description
 * Per-cycle scratchpad and dependency resolver. The only "smart" component in
 * the bus architecture — and its intelligence is limited to graph resolution.
 *
 * Owns the cycle store (`_store`), the active job counter (`_jobCounter`),
 * and the staleness map (`_activeJobByKey`). All other CNZ modules that need
 * to track or read cycle values go through this module's public API.
 *
 * Dependency resolution is mechanical: when a job completes and writes a value
 * to the store, the resolver checks every recipe whose inputs include that key.
 * If all inputs are satisfied and the recipe is not already running or complete,
 * it dispatches a new contract automatically. No special cases.
 *
 * Staleness is one counter and one lookup: `_activeJobByKey[stalenessKey]`
 * holds the jobId of the current authoritative job. Any result arriving with a
 * different jobId is discarded in O(1).
 *
 * @api-declaration
 * startCycle(cycleId, seeds)              — open a new cycle, seed initial values.
 * getCycleValue(cycleId, key)             — read a value from the current cycle store.
 * dispatchContract(recipeId, extra, settings) — assemble and emit a contract; returns jobId.
 * setCurrentSettings(settings)           — set settings used by dependency resolution.
 * invalidateAllJobs()                    — mark all in-flight jobs stale (modal close, char switch).
 *
 * @contract
 *   assertions:
 *     purity: stateful
 *     state_ownership: [_store, _currentCycle, _jobCounter, _activeJobByKey, _currentSettings]
 *     external_io: []
 */
// ─── CNZ Cycle Store ──────────────────────────────────────────────────────────
// Owns the per-cycle scratchpad. Handles dispatch, result routing, and
// dependency resolution. The only "smart" component — intelligence limited to
// graph resolution.

import { emit, on } from './bus.js';
import { Recipes }  from './recipes.js';

// ── Module State ──────────────────────────────────────────────────────────────

const _store          = {};   // cycleId → { key: value }
let   _currentCycle   = null; // active cycleId
let   _jobCounter     = 0;    // global monotonic counter
const _activeJobByKey = {};   // stalenessKey → current jobId
let   _currentSettings = {};  // set once per cycle by the caller

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Opens a new cycle and seeds the store with initial values.
 * @param {string} cycleId
 * @param {Record<string,*>} seeds  Pre-resolved inputs (transcript, lorebook_entries, etc.)
 */
export function startCycle(cycleId, seeds) {
    _store[cycleId] = { ...seeds };
    _currentCycle   = cycleId;
    emit('CYCLE_STARTED', { cycleId, seeds });
}

/**
 * @param {string} cycleId
 * @param {string} key
 * @returns {*}
 */
export function getCycleValue(cycleId, key) {
    return _store[cycleId]?.[key] ?? null;
}

/**
 * Assembles a contract for the named recipe and emits CONTRACT_DISPATCHED.
 * @param {string} recipeId
 * @param {Record<string,*>} extraInputs  Caller-supplied overrides for cycle store values.
 * @param {object} settings               Active profile settings.
 */
export function dispatchContract(recipeId, extraInputs = {}, settings) {
    const recipe = Recipes[recipeId];
    if (!recipe) throw new Error(`[CNZ] Unknown recipe: ${recipeId}`);

    const cycleId = _currentCycle;
    const stored  = _store[cycleId] ?? {};

    // Resolve inputs: caller overrides take precedence over cycle store
    const inputs = {};
    for (const key of recipe.inputs) {
        inputs[key] = extraInputs[key] ?? stored[key] ?? null;
    }

    // Build prompt — pure, no side effects
    inputs._prompt = recipe.buildPrompt(inputs, settings);

    const jobId = ++_jobCounter;
    _activeJobByKey[recipe.stalenessKey] = jobId;

    const maxTokens = typeof recipe.maxTokens === 'string'
        ? settings[recipe.maxTokens]  // resolve settings key (e.g. 'ragMaxTokens')
        : recipe.maxTokens;           // literal value or null

    emit('CONTRACT_DISPATCHED', {
        jobId,
        cycleId,
        recipeId,
        inputs,
        settings,
        maxTokens,
        maxRetries: settings.maxRetries ?? 1,
    });
    return jobId;
}

/**
 * Sets the settings object used by auto-triggered dependency resolution.
 * Must be called before the first dispatchContract in each cycle.
 * @param {object} settings
 */
export function setCurrentSettings(settings) {
    _currentSettings = settings;
}

/**
 * Marks all in-flight jobs stale. Call on character switch and modal close.
 * Any JOB_COMPLETED payloads that arrive after this call will be discarded.
 */
export function invalidateAllJobs() {
    for (const key of Object.keys(_activeJobByKey)) {
        delete _activeJobByKey[key];
    }
}

// ── Result Routing ────────────────────────────────────────────────────────────

on('JOB_COMPLETED', ({ jobId, cycleId, recipeId, result }) => {
    const recipe = Recipes[recipeId];
    if (!recipe) return;

    // Staleness check — one comparison
    if (_activeJobByKey[recipe.stalenessKey] !== jobId) return;

    if (!_store[cycleId]) return;
    _store[cycleId][recipe.produces] = result;

    emit('CYCLE_STORE_UPDATED', { cycleId, key: recipe.produces, value: result });
});

on('JOB_FAILED', ({ jobId, cycleId, recipeId, error }) => {
    const recipe = Recipes[recipeId];
    if (!recipe) return;
    if (_activeJobByKey[recipe.stalenessKey] !== jobId) return;

    console.error(`[CNZ] Job failed: ${recipeId} (job ${jobId})`, error);
    emit('CYCLE_STORE_UPDATED', {
        cycleId,
        key:   recipe.produces,
        value: null,
        error: error.message,
    });
});

// ── Dependency Resolution ─────────────────────────────────────────────────────

on('CYCLE_STORE_UPDATED', ({ cycleId, key }) => {
    if (cycleId !== _currentCycle) return;
    const stored = _store[cycleId];
    if (!stored) return;

    for (const recipe of Object.values(Recipes)) {
        // Only consider recipes that declare this key as an input
        if (!recipe.inputs.includes(key)) continue;

        // All inputs must be satisfied
        if (!recipe.inputs.every(k => stored[k] != null)) continue;

        // Must not already be running
        if (_activeJobByKey[recipe.stalenessKey] != null) continue;

        // Must not already be completed this cycle
        if (stored[recipe.produces] != null) continue;

        dispatchContract(recipe.id, {}, _currentSettings);
    }
});
