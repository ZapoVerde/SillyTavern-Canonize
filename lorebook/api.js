/**
 * @file data/default-user/extensions/canonize/lorebook/api.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Thin HTTP wrapper around the ST worldinfo server endpoints. Covers lorebook
 * list, fetch, save, and ensure-exists operations. No business logic — each
 * function corresponds to exactly one server endpoint or operation.
 *
 * @api-declaration
 * lbListLorebooks, lbGetLorebook, lbSaveLorebook, lbEnsureLorebook, lbSetCharacterLorebook
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

export async function lbSaveLorebook(name, data, { silent = false } = {}) {
    const res = await fetch('/api/worldinfo/edit', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`Lorebook save failed (HTTP ${res.status})`);
    if (!silent) await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}

/**
 * Sets or clears the active character's attached lorebook (data.extensions.world).
 * Pass a lorebook name to attach, or '' to detach entirely.
 * Updates the in-memory character object so the change is immediately visible to
 * ST's WI scanner without a page reload.
 */
export async function lbSetCharacterLorebook(name) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters?.[ctx.characterId];
    if (!char) throw new Error('No active character');
    const res = await fetch('/api/characters/merge-attributes', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ avatar: char.avatar, data: { extensions: { world: name } } }),
    });
    if (!res.ok) throw new Error(`Character world update failed (HTTP ${res.status})`);
    if (!char.data) char.data = {};
    if (!char.data.extensions) char.data.extensions = {};
    char.data.extensions.world = name;
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
        await lbSaveLorebook(name, { entries: {} }, { silent: true });
        await updateWorldInfoList();
    }
    return lbGetLorebook(name);
}
