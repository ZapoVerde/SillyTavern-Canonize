/**
 * @file data/default-user/extensions/canonize/settings/data.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Stateful Owner
 * @description
 * Owns CNZ extension settings: reading the active profile, bootstrapping the
 * initial settings structure (including one-time migration from the legacy flat
 * layout), and profile CRUD helpers. All writes go through
 * `extension_settings[EXT_NAME]` and are persisted via `saveSettingsDebounced`.
 *
 * @api-declaration
 * getSettings, getMetaSettings, initSettings
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz]
 *     external_io: [none]
 */

import { extension_settings } from '../../../../extensions.js';
import { EXT_NAME, PROFILE_DEFAULTS } from '../state.js';
import { warn } from '../log.js';
import {
    DEFAULT_LOREBOOK_SYNC_PROMPT,
} from '../defaults.js';

// ─── Settings Accessors ───────────────────────────────────────────────────────

/** Returns the active profile configuration. The engine always reads from here. */
export function getSettings() {
    return extension_settings[EXT_NAME].activeState;
}

/** Returns the root settings object (profiles dict, meta-state). */
export function getMetaSettings() {
    return extension_settings[EXT_NAME];
}

// ─── Settings Init ────────────────────────────────────────────────────────────

export function initSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const root = extension_settings[EXT_NAME];

    if (!root.profiles) {
        // ── One-time migration: flat structure → profile-based ────────────
        // First, apply old key renames in-place so they are collected correctly.
        // factFinderPrompt → lorebookSyncPrompt
        if (root.factFinderPrompt !== undefined) {
            if (root.lorebookSyncPrompt === undefined || root.lorebookSyncPrompt === DEFAULT_LOREBOOK_SYNC_PROMPT) {
                root.lorebookSyncPrompt = root.factFinderPrompt;
            }
            delete root.factFinderPrompt;
        }
        // ragSummaryOnly + useQvink → ragContents + ragSummarySource
        if (root.ragSummaryOnly !== undefined || root.useQvink !== undefined) {
            const wasSummaryOnly = root.ragSummaryOnly ?? false;
            const wasQvink       = root.useQvink       ?? false;
            if (wasSummaryOnly) root.ragContents = 'summary';
            else if (!root.ragContents) root.ragContents = 'summary+full';
            if (wasQvink && (root.ragSummarySource ?? 'defined') === 'defined') root.ragSummarySource = 'qvink';
            delete root.ragSummaryOnly;
            delete root.useQvink;
        }

        // syncFromTurn → liveContextBuffer (semantics inverted; discard old value, reset to default)
        if (root.syncFromTurn !== undefined) {
            warn('Settings', 'syncFromTurn renamed to liveContextBuffer — semantics inverted, resetting to default of 5');
            delete root.syncFromTurn;
            root.liveContextBuffer = 5;
        }
        // pruneOnSync → autoAdvanceMask (boolean migrates directly)
        if (root.pruneOnSync !== undefined) {
            root.autoAdvanceMask = root.pruneOnSync;
            delete root.pruneOnSync;
        }

        // Harvest profile-config keys from the flat root into a legacy object.
        // Meta-state keys (lastLorebookSyncAt) are not in
        // PROFILE_DEFAULTS, so they are left untouched at root.
        const legacyConfig = {};
        for (const key of Object.keys(PROFILE_DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(root, key)) {
                legacyConfig[key] = root[key];
                delete root[key];
            }
        }

        const defaultProfile    = Object.assign({}, PROFILE_DEFAULTS, legacyConfig);
        root.profiles           = { Default: defaultProfile };
        root.currentProfileName = 'Default';
        root.activeState        = structuredClone(defaultProfile);
    } else {
        // Existing profile structure — fill in any keys added by newer versions.
        root.activeState = Object.assign({}, PROFILE_DEFAULTS, root.activeState);
    }

    // (no meta-state keys require initialisation at this time)
}
