/**
 * @file data/default-user/extensions/canonize/settings/data.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @version 1.2.0
 * @architectural-role Stateful Owner
 * @description
 * Owns CNZ extension settings: reading the active profile, bootstrapping the
 * initial settings structure, and profile CRUD helpers.
 *
 * @api-declaration
 * getSettings, getMetaSettings, initSettings, isExtensionEnabled, setExtensionEnabled
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

/** 
 * Returns true if the master extension toggle is enabled.
 * @returns {boolean}
 */
export function isExtensionEnabled() {
    return extension_settings[EXT_NAME]?.extensionEnabled ?? true;
}

/**
 * Sets the master extension toggle state.
 * @param {boolean} bool 
 */
export function setExtensionEnabled(bool) {
    if (!extension_settings[EXT_NAME]) return;
    extension_settings[EXT_NAME].extensionEnabled = !!bool;
}

// ─── Settings Init ────────────────────────────────────────────────────────────

export function initSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const root = extension_settings[EXT_NAME];

    // Ensure master toggle is initialized
    if (root.extensionEnabled === undefined) {
        root.extensionEnabled = true;
    }

    if (!root.profiles) {
        // ── One-time migration: flat structure → profile-based ────────────
        if (root.factFinderPrompt !== undefined) {
            if (root.lorebookSyncPrompt === undefined || root.lorebookSyncPrompt === DEFAULT_LOREBOOK_SYNC_PROMPT) {
                root.lorebookSyncPrompt = root.factFinderPrompt;
            }
            delete root.factFinderPrompt;
        }
        if (root.ragSummaryOnly !== undefined || root.useQvink !== undefined) {
            const wasSummaryOnly = root.ragSummaryOnly ?? false;
            const wasQvink       = root.useQvink       ?? false;
            if (wasSummaryOnly) root.ragContents = 'summary';
            else if (!root.ragContents) root.ragContents = 'summary+full';
            if (wasQvink && (root.ragSummarySource ?? 'defined') === 'defined') root.ragSummarySource = 'qvink';
            delete root.ragSummaryOnly;
            delete root.useQvink;
        }

        if (root.syncFromTurn !== undefined) {
            warn('Settings', 'syncFromTurn renamed to liveContextBuffer — resetting to default');
            delete root.syncFromTurn;
        }
        if (root.pruneOnSync !== undefined) {
            root.autoAdvanceMask = root.pruneOnSync;
            delete root.pruneOnSync;
        }

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
        root.activeState = Object.assign({}, PROFILE_DEFAULTS, root.activeState);
    }

    delete root.activeState.enablePersonalyze;
    for (const profile of Object.values(root.profiles ?? {})) {
        delete profile.enablePersonalyze;
    }
}