/**
 * @file data/default-user/extensions/canonize/cycleStore.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role Stateful Owner
 * @description
 * Per-cycle scratchpad and dependency resolver. The only "smart" component in
 * the bus architecture — and its intelligence is limited to graph resolution.
 *
 * Owns the cycle store (`_store`), the active job counter (`_jobCounter`),
 * the staleness map (`_activeJobByKey`), and the fan-out tracking state
 * (`_activeJobsByKey`, `_fanOutResults`, `_inFlightByKey`, `_fanOutQueue`).
 *
 * Fan-out recipes declare a `fanOut(inputs, settings)` function that returns
 * an array of per-chunk input sets. `dispatchContract` detects this and
 * delegates to `_dispatchFanOut`, which emits one `CONTRACT_DISPATCHED` per
 * chunk (respecting `maxConcurrent`). When all chunk jobs settle, a single
 * `CYCLE_STORE_UPDATED` fires for the recipe's `produces` key.
 *
 * Staleness for single-job recipes: `_activeJobByKey[stalenessKey]` holds the
 * current authoritative jobId. Any result arriving with a different jobId is
 * discarded in O(1).
 *
 * Staleness for fan-out recipes: `_activeJobsByKey[stalenessKey]` holds a Set
 * of active jobIds. Any result with a jobId not in the set is discarded.
 *
 * @api-declaration
 * startCycle(cycleId, seeds)                  — open a new cycle, seed initial values.
 * getCycleValue(cycleId, key)                 — read a value from the current cycle store.
 * dispatchContract(recipeId, extra, settings) — assemble and emit a contract; returns jobId(s).
 * setCurrentSettings(settings)               — set settings used by dependency resolution.
 * invalidateAllJobs()                        — mark all in-flight jobs stale (modal close, char switch).
 *
 * @contract
 *   assertions:
 *     purity: stateful
 *     state_ownership: [_store, _currentCycle, _jobCounter,
 *                       _activeJobByKey, _activeJobsByKey,
 *                       _fanOutResults, _inFlightByKey, _fanOutQueue, _maxConcurrentByKey,
 *                       _currentSettings]
 *     external_io: []
 */
// ─── CNZ Cycle Store ──────────────────────────────────────────────────────────
// Owns the per-cycle scratchpad. Handles dispatch, result routing, and
// dependency resolution. The only "smart" component — intelligence limited to
// graph resolution.

import { emit, on, BUS_EVENTS } from './bus.js';
import { error as logError } from './log.js';
import { Recipes }  from './recipes.js';

const DEFAULT_CONCURRENCY = 3;

// ── Module State ──────────────────────────────────────────────────────────────

const _store          = {};   // cycleId → { key: value }
let   _currentCycle   = null; // active cycleId
let   _jobCounter     = 0;    // global monotonic counter
const _activeJobByKey = {};   // stalenessKey → current jobId  (single-job recipes)
let   _currentSettings = {};  // set once per cycle by the caller

// Fan-out tracking
const _activeJobsByKey   = {};  // stalenessKey → Set<jobId>
const _fanOutResults     = {};  // cycleId → { stalenessKey → { results: [] } }
const _inFlightByKey     = {};  // stalenessKey → number
const _fanOutQueue       = {};  // stalenessKey → [contract]
const _maxConcurrentByKey = {}; // stalenessKey → maxConcurrent (stored for drain)

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Opens a new cycle and seeds the store with initial values.
 * @param {string} cycleId
 * @param {Record<string,*>} seeds  Pre-resolved inputs (transcript, lorebook_entries, etc.)
 */
export function startCycle(cycleId, seeds) {
    _store[cycleId] = { ...seeds };
    _currentCycle   = cycleId;
    emit(BUS_EVENTS.CYCLE_STARTED, { cycleId, seeds });
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
 * If the recipe declares `fanOut`, delegates to _dispatchFanOut and returns
 * an array of jobIds. Otherwise returns a single jobId.
 * @param {string} recipeId
 * @param {Record<string,*>} extraInputs  Caller-supplied overrides for cycle store values.
 * @param {object} settings               Active profile settings.
 * @returns {number|number[]}
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

    // Fan-out path — recipe provides a fanOut function
    if (recipe.fanOut) {
        const inputSets = recipe.fanOut(inputs, settings);
        return _dispatchFanOut(inputSets, recipe, settings, cycleId);
    }

    // Single-job path
    inputs._prompt = recipe.buildPrompt(inputs, settings);

    const jobId = ++_jobCounter;
    _activeJobByKey[recipe.stalenessKey] = jobId;

    const maxTokens = typeof recipe.maxTokens === 'string'
        ? settings[recipe.maxTokens]
        : recipe.maxTokens;

    emit(BUS_EVENTS.CONTRACT_DISPATCHED, {
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
    for (const key of Object.keys(_activeJobsByKey)) {
        delete _activeJobsByKey[key];
    }
    for (const key of Object.keys(_fanOutResults)) {
        delete _fanOutResults[key];
    }
    for (const key of Object.keys(_inFlightByKey)) {
        delete _inFlightByKey[key];
    }
    for (const key of Object.keys(_fanOutQueue)) {
        delete _fanOutQueue[key];
    }
    for (const key of Object.keys(_maxConcurrentByKey)) {
        delete _maxConcurrentByKey[key];
    }
}

// ── Fan-out Internals ─────────────────────────────────────────────────────────

/**
 * Dispatches one CONTRACT_DISPATCHED per input set, respecting maxConcurrent.
 * Returns an array of all jobIds (including queued ones).
 * @param {object[]} inputSets  Per-chunk input objects from recipe.fanOut().
 * @param {object}   recipe
 * @param {object}   settings
 * @param {*}        cycleId
 * @returns {number[]}
 */
function _dispatchFanOut(inputSets, recipe, settings, cycleId) {
    const key = recipe.stalenessKey;

    const maxConcurrent = typeof recipe.maxConcurrent === 'string'
        ? (settings[recipe.maxConcurrent] ?? DEFAULT_CONCURRENCY)
        : (recipe.maxConcurrent ?? DEFAULT_CONCURRENCY);

    const maxTokens = typeof recipe.maxTokens === 'string'
        ? settings[recipe.maxTokens]
        : recipe.maxTokens;

    // Reset fan-out state for this key
    _activeJobsByKey[key]    = new Set();
    _inFlightByKey[key]      = 0;
    _fanOutQueue[key]        = [];
    _maxConcurrentByKey[key] = maxConcurrent;
    if (!_fanOutResults[cycleId]) _fanOutResults[cycleId] = {};
    _fanOutResults[cycleId][key] = { results: [] };

    const jobIds = [];
    for (const inputSet of inputSets) {
        const jobId  = ++_jobCounter;
        const inputs = { ...inputSet, _prompt: recipe.buildPrompt(inputSet, settings) };
        const contract = {
            jobId,
            cycleId,
            recipeId:   recipe.id,
            inputs,
            settings,
            maxTokens,
            maxRetries: settings.maxRetries ?? 1,
        };

        _activeJobsByKey[key].add(jobId);
        jobIds.push(jobId);

        if (_inFlightByKey[key] < maxConcurrent) {
            _inFlightByKey[key]++;
            emit(BUS_EVENTS.CONTRACT_DISPATCHED, contract);
        } else {
            _fanOutQueue[key].push(contract);
        }
    }
    return jobIds;
}

/**
 * Drains queued fan-out contracts up to maxConcurrent.
 * @param {string} key  stalenessKey
 */
function _drainFanOutQueue(key) {
    const queue         = _fanOutQueue[key];
    const maxConcurrent = _maxConcurrentByKey[key] ?? DEFAULT_CONCURRENCY;
    if (!queue?.length) return;
    while (_inFlightByKey[key] < maxConcurrent && queue.length > 0) {
        const contract = queue.shift();
        _inFlightByKey[key]++;
        emit(BUS_EVENTS.CONTRACT_DISPATCHED, contract);
    }
}

// ── Result Routing ────────────────────────────────────────────────────────────

on(BUS_EVENTS.JOB_COMPLETED, ({ jobId, cycleId, recipeId, result, inputs }) => {
    const recipe = Recipes[recipeId];
    if (!recipe) return;

    // Fan-out path
    if (recipe.fanOut) {
        const key = recipe.stalenessKey;
        if (!_activeJobsByKey[key]?.has(jobId)) return;  // stale

        _activeJobsByKey[key].delete(jobId);
        _inFlightByKey[key] = Math.max(0, (_inFlightByKey[key] ?? 0) - 1);

        const fanOutState = _fanOutResults[cycleId]?.[key];
        if (fanOutState) {
            fanOutState.results.push({ chunkIndex: inputs?.chunkIndex, header: result });
        }

        _drainFanOutQueue(key);

        // All jobs settled — write results and fire CYCLE_STORE_UPDATED
        if (_activeJobsByKey[key].size === 0 && !_fanOutQueue[key]?.length) {
            if (!_store[cycleId]) _store[cycleId] = {};
            const results = fanOutState?.results ?? [];
            _store[cycleId][recipe.produces] = results;
            emit(BUS_EVENTS.CYCLE_STORE_UPDATED, { cycleId, key: recipe.produces, value: results });
        }
        return;
    }

    // Single-job path
    if (_activeJobByKey[recipe.stalenessKey] !== jobId) return;
    if (!_store[cycleId]) return;
    _store[cycleId][recipe.produces] = result;
    emit(BUS_EVENTS.CYCLE_STORE_UPDATED, { cycleId, key: recipe.produces, value: result });
});

on(BUS_EVENTS.JOB_FAILED, ({ jobId, cycleId, recipeId, error, inputs }) => {
    const recipe = Recipes[recipeId];
    if (!recipe) return;

    // Fan-out path
    if (recipe.fanOut) {
        const key = recipe.stalenessKey;
        if (!_activeJobsByKey[key]?.has(jobId)) return;

        _activeJobsByKey[key].delete(jobId);
        _inFlightByKey[key] = Math.max(0, (_inFlightByKey[key] ?? 0) - 1);

        const _profileLabel = error?._profile ? ` [profile: ${error._profile}]` : '';
        logError('CycleStore', `Fan-out job failed: ${recipeId} chunk ${inputs?.chunkIndex} (job ${jobId})${_profileLabel}`, error);

        const fanOutState = _fanOutResults[cycleId]?.[key];
        if (fanOutState) {
            // null header marks a failed chunk — CYCLE_STORE_UPDATED handler skips it
            fanOutState.results.push({ chunkIndex: inputs?.chunkIndex, header: null });
        }

        _drainFanOutQueue(key);

        if (_activeJobsByKey[key].size === 0 && !_fanOutQueue[key]?.length) {
            if (!_store[cycleId]) _store[cycleId] = {};
            const results = fanOutState?.results ?? [];
            _store[cycleId][recipe.produces] = results;
            emit(BUS_EVENTS.CYCLE_STORE_UPDATED, { cycleId, key: recipe.produces, value: results, error: error?.message });
        }
        return;
    }

    // Single-job path
    if (_activeJobByKey[recipe.stalenessKey] !== jobId) return;
    const _profileLabel = error?._profile ? ` [profile: ${error._profile}]` : '';
    logError('CycleStore', `Job failed: ${recipeId} (job ${jobId})${_profileLabel}`, error);
    emit(BUS_EVENTS.CYCLE_STORE_UPDATED, {
        cycleId,
        key:   recipe.produces,
        value: null,
        error: error.message,
    });
});

// ── Dependency Resolution ─────────────────────────────────────────────────────

on(BUS_EVENTS.CYCLE_STORE_UPDATED, ({ cycleId, key }) => {
    if (cycleId !== _currentCycle) return;
    const stored = _store[cycleId];
    if (!stored) return;

    for (const recipe of Object.values(Recipes)) {
        // Fan-out recipes are never auto-triggered by dependency resolution
        if (recipe.fanOut) continue;

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
