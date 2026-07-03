/**
 * @file data/default-user/extensions/canonize/core/sync-catchup.js
 * @stamp {"utc":"2026-07-02T00:00:00.000Z"}
 * @architectural-role Orchestrator — sequences repeated window-sized syncs to close a large gap.
 * @description
 * Drives the "auto-process in steps" option offered on the large-gap toast.
 * Instead of one coverAll pass over the whole uncommitted gap, this repeatedly
 * runs standard window-sized syncs and rechecks the remaining gap after each,
 * so a large backlog is closed via the same per-window analysis as manual
 * one-at-a-time syncing — just without the user re-invoking it each step.
 *
 * Emits SYNC_CATCHUP_PROGRESS after every step ({ step, totalSteps, done })
 * so a UI layer can show "sync 2/5" style status — this module has no DOM
 * knowledge of its own, matching the EMBED_PROGRESS pattern in lifecycle.js.
 *
 * @api-declaration
 * runCnzSyncCatchUp(char, messages) — loop window-sized syncs until the gap is closed
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [runCnzSync, scheduler.getGap, bus]
 */

import { emit, BUS_EVENTS } from '../bus.js';
import { getGap } from '../scheduler.js';
import { getSettings } from './settings.js';
import { runCnzSync } from './sync.js';

export async function runCnzSyncCatchUp(char, messages) {
    const settings   = getSettings();
    const every      = settings.chunkEveryN ?? 20;
    const totalSteps = Math.max(1, Math.ceil(getGap(settings) / every));

    // Bounded by the gap measured at start — the loop cannot outrun a backlog
    // that isn't shrinking, e.g. if a sync aborts with no uncommitted pairs.
    const maxSteps = totalSteps + 1;

    emit(BUS_EVENTS.SYNC_CATCHUP_PROGRESS, { step: 0, totalSteps, done: false });

    let completed = 0;
    for (let i = 0; i < maxSteps && getGap(settings) >= every; i++) {
        await runCnzSync(char, messages, { coverAll: false });
        completed++;
        emit(BUS_EVENTS.SYNC_CATCHUP_PROGRESS, { step: completed, totalSteps, done: false });
    }

    emit(BUS_EVENTS.SYNC_CATCHUP_PROGRESS, { step: completed, totalSteps, done: true });
}
