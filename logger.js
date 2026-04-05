/**
 * @file data/default-user/extensions/canonize/logger.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Observer
 * @description
 * Console logger for LLM call lifecycle. Sits on the event bus and emits one
 * line per LLM call: dispatch, completion, and failure. No business logic.
 *
 * @api-declaration
 * (no exports — self-registers on import)
 *
 * @contract
 *   assertions:
 *     purity: IO
 *     state_ownership: []
 *     external_io: [console]
 */
// ─── CNZ LLM Logger ───────────────────────────────────────────────────────────
// One line per LLM call event. No payload inspection beyond identity fields.

import { on, BUS_EVENTS } from './bus.js';

on(BUS_EVENTS.CONTRACT_DISPATCHED, ({ jobId, cycleId, recipeId, maxRetries = 1 }) => {
    console.log(`[CNZ] LLM dispatch  ${recipeId}  job=${jobId}  cycle=${cycleId}  maxRetries=${maxRetries}`);
});

on(BUS_EVENTS.JOB_COMPLETED, ({ jobId, cycleId, recipeId }) => {
    console.log(`[CNZ] LLM completed ${recipeId}  job=${jobId}  cycle=${cycleId}`);
});

on(BUS_EVENTS.JOB_FAILED, ({ jobId, cycleId, recipeId, error }) => {
    console.error(`[CNZ] LLM failed    ${recipeId}  job=${jobId}  cycle=${cycleId}  reason=${error?.message ?? error}`);
});
