/**
 * @file data/default-user/extensions/canonize/lorebook/plot-lorebook.js
 * @stamp {"utc":"2026-05-28T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Owns the append-only plot lorebook. Hookseeker is the sole writer.
 * Each sync cycle adds new entries representing narrative events from that
 * window — entries are never updated or deleted here. Healing is handled
 * by the RAG layer (queries are scoped to valid anchor UUIDs) rather than
 * by restoring a file snapshot.
 *
 * @api-declaration
 * ensurePlotLorebook(name) → Promise<object>
 * appendPlotEntries(name, entries) → Promise<object[]>  entries with UIDs assigned
 *
 * @contract
 *   assertions:
 *     purity:          mutates
 *     state_ownership: [none]
 *     external_io:     [/api/worldinfo/*]
 */

import { lbEnsureLorebook, lbGetLorebook, lbSaveLorebook } from './api.js';

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Ensures the plot lorebook file exists and returns its current data.
 * @param {string} name  Plot lorebook filename (from cnzPlotLbName).
 * @returns {Promise<object>}
 */
export async function ensurePlotLorebook(name) {
    return lbEnsureLorebook(name);
}

/**
 * Appends new plot entries to the lorebook file. Assigns UIDs by extending
 * the highest existing UID. Returns the written entries with UIDs attached.
 * @param {string}   name     Plot lorebook filename.
 * @param {{ name: string, keys: string[], content: string }[]} entries
 * @returns {Promise<{ uid: number, content: string, keys: string[], comment: string }[]>}
 */
export async function appendPlotEntries(name, entries) {
    if (!entries.length) return [];

    const lorebook = await ensurePlotLorebook(name);
    const existing = lorebook.entries ?? {};

    const maxUid = Object.keys(existing).length
        ? Math.max(...Object.keys(existing).map(Number))
        : -1;

    const written = [];
    let nextUid = maxUid + 1;

    for (const e of entries) {
        const uid = nextUid++;
        existing[String(uid)] = _buildPlotEntry(uid, e.name, e.keys, e.content);
        written.push({ uid, content: e.content, keys: e.keys, comment: e.name });
    }

    lorebook.entries = existing;
    await lbSaveLorebook(name, lorebook, { silent: true });

    return written;
}

/**
 * Rebuilds the plot lorebook file from anchor chain data. Called by the healer
 * when the file is missing or the session is loaded on a new machine.
 * Preserves original UIDs. Idempotent — safe to call when the file already exists.
 *
 * @param {string} name  Plot lorebook filename.
 * @param {{ uuid: string, entries: { uid: number, content: string, keys: string[], comment: string }[] }[]} anchorChunks
 *   Ordered list of { uuid, entries } from chain.anchors.
 * @returns {Promise<void>}
 */
export async function rebuildPlotLorebook(name, anchorChunks) {
    const allEntries = anchorChunks.flatMap(c => c.entries ?? []);
    if (!allEntries.length) return;
    const entries = {};
    for (const e of allEntries) {
        entries[String(e.uid)] = _buildPlotEntry(e.uid, e.comment, e.keys, e.content);
    }
    await lbSaveLorebook(name, { entries }, { silent: true });
}

// ─── Internal ─────────────────────────────────────────────────────────────────

/**
 * Builds a minimal ST worldinfo entry for a plot event.
 * No keyword-based activation — plot entries surface exclusively via RAG.
 * @param {number}   uid
 * @param {string}   name
 * @param {string[]} keys
 * @param {string}   content
 * @returns {object}
 */
function _buildPlotEntry(uid, name, keys, content) {
    return {
        uid,
        key:              keys,
        keysecondary:     [],
        comment:          name,
        content,
        constant:         false,
        vectorized:       false,
        selective:        false,
        selectiveLogic:   0,
        addMemo:          true,
        order:            100,
        position:         0,
        disable:          false,
        ignoreBudget:     false,
        excludeRecursion: false,
        preventRecursion: false,
        probability:      100,
        useProbability:   false,
        depth:            4,
        group:            'cnz_plot',
        displayIndex:     uid,
    };
}
