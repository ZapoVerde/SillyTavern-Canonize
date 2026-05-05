/**
 * @file data/default-user/extensions/canonize/lorebook/api.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Thin HTTP wrapper around the ST worldinfo server endpoints. Covers lorebook
 * list, fetch, save, and ensure-exists operations. No business logic — each
 * function corresponds to exactly one server endpoint or operation.
 *
 * @api-declaration
 * lbListLorebooks, lbGetLorebook, lbSaveLorebook, lbEnsureLorebook
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/worldinfo/*]
 */

import { getRequestHeaders, eventSource, event_types } from '../../../../../script.js';
import { updateWorldInfoList } from '../../../../../scripts/world-info.js';

// ─── Lorebook API ─────────────────────────────────────────────────────────────

export async function lbListLorebooks() {
    const res = await fetch('/api/worldinfo/list', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Lorebook list failed (HTTP ${res.status})`);
    return res.json();
}

export async function lbGetLorebook(name) {
    const res = await fetch('/api/worldinfo/get', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Lorebook fetch failed (HTTP ${res.status})`);
    return res.json();
}

export async function lbSaveLorebook(name, data) {
    const res = await fetch('/api/worldinfo/edit', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`Lorebook save failed (HTTP ${res.status})`);
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}

/**
 * Ensures a lorebook named `name` exists, then returns its data.
 */
export async function lbEnsureLorebook(name) {
    let list;
    try {
        list = await lbListLorebooks();
    } catch (_) {
        list = [];
    }
    const exists = list.some(item => item.name === name);
    if (!exists) {
        await lbSaveLorebook(name, { entries: {} });
        await updateWorldInfoList();
    }
    return lbGetLorebook(name);
}
