/**
 * @file data/default-user/extensions/canonize/executor.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Executor
 * @description
 * LLM call executor. Subscribes to `CONTRACT_DISPATCHED` on import, fires the
 * LLM call described by the contract, and emits `JOB_COMPLETED` or `JOB_FAILED`.
 *
 * Contains no CNZ business logic. The executor does not know what a hookseeker
 * is. It receives a prompt string, a profile key, a token limit, and a retry
 * count — and executes what it is told.
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

import { emit, on }   from './bus.js';
import { Recipes }    from './recipes.js';
import { generateRaw } from '../../../../script.js';
import { ConnectionManagerRequestService } from '../../shared.js';

on('CONTRACT_DISPATCHED', async (payload) => {
    const { jobId, cycleId, recipeId, maxRetries = 1 } = payload;

    let lastErr;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const result = await _fireCall(payload);
            emit('JOB_COMPLETED', { jobId, cycleId, recipeId, result, inputs: payload.inputs });
            return;
        } catch (err) {
            lastErr = err;
            if (attempt < maxRetries) {
                await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
            }
        }
    }

    emit('JOB_FAILED', { jobId, cycleId, recipeId, error: lastErr, inputs: payload.inputs });
});

async function _fireCall({ recipeId, inputs, settings, maxTokens }) {
    const profileId = settings[Recipes[recipeId].profileKey] ?? null;
    const tokens    = maxTokens ?? null;

    if (profileId) {
        const result = await ConnectionManagerRequestService.sendRequest(
            profileId, inputs._prompt, tokens
        );
        return result.content;
    }
    return generateRaw({ prompt: inputs._prompt, trimNames: false, responseLength: tokens });
}
