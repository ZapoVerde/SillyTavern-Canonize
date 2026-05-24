/**
 * @file data/default-user/extensions/canonize/executor.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * LLM call executor. Subscribes to `CONTRACT_DISPATCHED` on import, fires the
 * LLM call described by the contract, and emits `JOB_COMPLETED` or `JOB_FAILED`.
 *
 * Contains no CNZ business logic. The executor does not know what a hookseeker
 * is. It receives a prompt string, a profile key, a token limit, and a retry
 * count — and executes what it is told.
 *
 * Call routing when no dedicated profile is configured:
 *   1. CM shadow path — ConnectionManagerRequestService with the currently-selected
 *      CM profile. Independent HTTP lifecycle; ST's Stop button cannot cancel CNZ
 *      calls and local-backend queue contention is avoided.
 *   2. Serial generateRaw — falls back if CM is unavailable or the selected
 *      profile is not CM-compatible (kobold, novelai, etc.).
 *
 * Retry policy is carried on the contract payload (set by the dispatcher).
 * The executor does not decide retry policy; it only acts on it.
 *
 * @api-declaration
 * (no exports — self-registers its CONTRACT_DISPATCHED handler on import)
 *
 * @contract
 *   assertions:
 *     purity: IO
 *     state_ownership: []
 *     external_io: [generateRaw, ConnectionManagerRequestService]
 */
// ─── CNZ LLM Executor ─────────────────────────────────────────────────────────
// Listens for CONTRACT_DISPATCHED. Fires the LLM call. Emits JOB_COMPLETED or
// JOB_FAILED. No CNZ knowledge. No business logic beyond retry.

import { emit, on, BUS_EVENTS }             from './bus.js';
import { log, warn }                         from './log.js';
import { Recipes }                           from './recipes.js';
import { generateRaw }                       from '../../../../script.js';
import { ConnectionManagerRequestService }   from '../../shared.js';

// CNZ prompts are self-contained — skip preset and instruct wrapping on shadow calls.
const _CM_SHADOW_OPTS = { stream: false, signal: null, extractData: true, includePreset: false, includeInstruct: false };

// generateRaw uses shared global ST state and is not safe for concurrent calls.
let _generateRawQueue = Promise.resolve();
function _serialGenerateRaw(args) {
    const next = _generateRawQueue.then(() => generateRaw(args));
    _generateRawQueue = next.catch(() => {});
    return next;
}

on(BUS_EVENTS.CONTRACT_DISPATCHED, async (payload) => {
    const { jobId, cycleId, recipeId, maxRetries = 1 } = payload;

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await _fireCall(payload);
            emit(BUS_EVENTS.JOB_COMPLETED, { jobId, cycleId, recipeId, result, inputs: payload.inputs });
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    emit(BUS_EVENTS.JOB_FAILED, { jobId, cycleId, recipeId, error: lastErr, inputs: payload.inputs });
});

async function _fireCall({ recipeId, inputs, settings, maxTokens }) {
    const profileId = settings[Recipes[recipeId].profileKey] ?? null;
    const tokens    = maxTokens ?? null;

    if (profileId) {
        let profileLabel = profileId;
        try {
            const profile = ConnectionManagerRequestService.getProfile(profileId);
            profileLabel  = `${profile.name ?? profileId} (model: ${profile.model ?? 'unknown'}, api: ${profile.api ?? 'unknown'})`;
        } catch { /* profile lookup is best-effort */ }

        try {
            const result = await ConnectionManagerRequestService.sendRequest(
                profileId, inputs._prompt, tokens
            );
            return result.content;
        } catch (err) {
            const cause   = err.cause?.message ?? err.cause ?? null;
            const detail  = cause ? `${err.message} — ${cause}` : err.message;
            throw Object.assign(new Error(detail), { cause: err.cause, _profile: profileLabel });
        }
    }

    // No dedicated profile — try the CM shadow path first.
    // Uses the currently-selected CM profile as a side lane: independent HTTP
    // lifecycle, no GENERATION_STOPPED subscription, no backend queue contention
    // with the main chat. Falls through to generateRaw if CM is unavailable or
    // the active profile uses an unsupported API type (kobold, novelai, etc.).
    const shadowId = _cmShadowProfileId();
    if (shadowId) {
        try {
            log('Executor', `no profileId set — using CM shadow path (profile ${shadowId})`);
            const result = await ConnectionManagerRequestService.sendRequest(
                shadowId, inputs._prompt, tokens, _CM_SHADOW_OPTS,
            );
            return result.content;
        } catch (err) {
            warn('Executor', `CM shadow path failed (${shadowId}): ${err.message} — falling back to generateRaw`);
        }
    }

    return _serialGenerateRaw({ prompt: inputs._prompt, trimNames: false, responseLength: tokens });
}

// Returns the currently-selected Connection Manager profile ID, or null if CM
// is disabled or no profile is selected.
function _cmShadowProfileId() {
    try {
        const ctx = SillyTavern.getContext();
        if (ctx.extensionSettings.disabledExtensions.includes('connection-manager')) return null;
        return ctx.extensionSettings.connectionManager?.selectedProfile ?? null;
    } catch { return null; }
}
