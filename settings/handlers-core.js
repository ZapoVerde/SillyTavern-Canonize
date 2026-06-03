/**
 * @file data/default-user/extensions/canonize/settings/handlers-core.js
 * @stamp {"utc":"2026-05-25T01:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Binds summary, lorebook, profile management, and utility settings panel
 * handlers. Exported as a single function called by panel.js during init.
 * Receives shared utilities as parameters to avoid circular imports.
 *
 * @api-declaration
 * bindCoreHandlers({ updateDirtyIndicator, openPromptModal, refreshProfileDropdown,
 *                    refreshSettingsUI, getMetaSettings })
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz (via getSettings/getMetaSettings)]
 *     external_io: [DOM, saveSettingsDebounced, callPopup]
 */

import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { escapeHtml } from '../state.js';
import { DEFAULT_LOREBOOK_SYNC_PROMPT, DEFAULT_PEOPLE_SYNC_PROMPT,
         DEFAULT_HOOKSEEKER_PROMPT,
         DEFAULT_TARGETED_UPDATE_PROMPT, DEFAULT_TARGETED_NEW_PROMPT } from '../defaults.js';
import { getSettings, getMetaSettings } from './data.js';
import { log, setVerbose } from '../log.js';
import { openDnaChainInspector } from '../modal/dna-inspector.js';
import { rebuildRag } from '../core/maintenance.js';
import { purgeCnzFiles } from '../core/maintenance-cleanup.js';
import { mountCnz, unmountCnz } from '../lifecycle.js';

export function bindCoreHandlers({ updateDirtyIndicator, openPromptModal, refreshProfileDropdown, refreshSettingsUI }) {

    // ── Master enable toggle ──────────────────────────────────────────────────
    $('#cnz-set-enable-cnz').on('change', function () {
        const enabled = $(this).prop('checked');
        log('Settings', `Enable Canonize toggled ${enabled ? 'ON' : 'OFF'}.`);
        getMetaSettings().enableCnz = enabled;
        saveSettingsDebounced();
        $('#cnz-main-settings').toggleClass('cnz-disabled', !enabled);
        if (enabled) { mountCnz(); } else { unmountCnz(); }
    });

    // ── Summary / Lorebook ────────────────────────────────────────────────────
    $('#cnz-set-live-context-buffer').on('input', function () {
        getSettings().liveContextBuffer = Math.max(0, parseInt($(this).val()) || 5);
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-set-chunk-every-n').on('input', function () {
        getSettings().chunkEveryN = Math.max(1, parseInt($(this).val()) || 20);
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-set-hookseeker-horizon').on('input', function () {
        getSettings().hookseekerHorizon = Math.max(1, parseInt($(this).val()) || 40);
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-set-lorebook-sync-start').on('change', function () {
        getSettings().lorebookSyncStart = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-set-enable-people-sync').on('change', function () {
        getSettings().enablePeopleSync = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-edit-summary-prompt').on('click', () =>
        openPromptModal('hookseekerPrompt', 'Edit Summary Prompt', DEFAULT_HOOKSEEKER_PROMPT,
            ['transcript', 'prev_scene', 'existing_threads']));
    $('#cnz-edit-lorebook-prompt').on('click', () =>
        openPromptModal('lorebookSyncPrompt', 'Edit Lorebook Sync Prompt', DEFAULT_LOREBOOK_SYNC_PROMPT,
            ['lorebook_entries', 'transcript']));
    $('#cnz-edit-people-prompt').on('click', () =>
        openPromptModal('peopleSyncPrompt', 'Edit People Sync Prompt', DEFAULT_PEOPLE_SYNC_PROMPT,
            ['lorebook_entries', 'transcript']));
    $('#cnz-edit-targeted-update-prompt').on('click', () =>
        openPromptModal('targetedUpdatePrompt', 'Edit Targeted Update Prompt',
            DEFAULT_TARGETED_UPDATE_PROMPT, ['entry_name', 'entry_keys', 'entry_content', 'transcript']));
    $('#cnz-edit-targeted-new-prompt').on('click', () =>
        openPromptModal('targetedNewPrompt', 'Edit Targeted New Entry Prompt',
            DEFAULT_TARGETED_NEW_PROMPT, ['entry_name', 'transcript']));

    // ── Profile management ────────────────────────────────────────────────────
    $('#cnz-profile-select').on('change', function () {
        const meta = getMetaSettings();
        const newName = $(this).val();
        if (!meta.profiles[newName]) return;
        meta.currentProfileName = newName;
        meta.activeState        = structuredClone(meta.profiles[newName]);
        saveSettingsDebounced();
        refreshSettingsUI();
    });
    $('#cnz-profile-save').on('click', function () {
        const meta = getMetaSettings();
        meta.profiles[meta.currentProfileName] = structuredClone(meta.activeState);
        saveSettingsDebounced(); updateDirtyIndicator();
    });
    $('#cnz-profile-add').on('click', async function () {
        const rawName = await callPopup('<h3>New profile name</h3>', 'input', '');
        const name    = (rawName ?? '').trim();
        if (!name) return;
        const meta = getMetaSettings();
        if (meta.profiles[name]) { toastr.warning(`Profile "${name}" already exists.`); return; }
        meta.profiles[name]     = structuredClone(meta.activeState);
        meta.currentProfileName = name;
        saveSettingsDebounced(); refreshProfileDropdown();
    });
    $('#cnz-profile-rename').on('click', async function () {
        const meta    = getMetaSettings();
        const rawName = await callPopup('<h3>Rename profile</h3>', 'input', meta.currentProfileName);
        const newName = (rawName ?? '').trim();
        if (!newName || newName === meta.currentProfileName) return;
        if (meta.profiles[newName]) { toastr.warning(`Profile "${newName}" already exists.`); return; }
        meta.profiles[newName] = meta.profiles[meta.currentProfileName];
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = newName;
        saveSettingsDebounced(); refreshProfileDropdown();
    });
    $('#cnz-profile-delete').on('click', async function () {
        const meta = getMetaSettings();
        if (Object.keys(meta.profiles).length <= 1) { toastr.warning('Cannot delete the only profile.'); return; }
        const confirmed = await callPopup(
            `<h3>Delete profile "${escapeHtml(meta.currentProfileName)}"?</h3>This cannot be undone.`, 'confirm');
        if (!confirmed) return;
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = Object.keys(meta.profiles)[0];
        meta.activeState        = structuredClone(meta.profiles[meta.currentProfileName]);
        saveSettingsDebounced(); refreshProfileDropdown(); refreshSettingsUI();
    });

    // ── Verbose / tools ───────────────────────────────────────────────────────
    $('#cnz-set-verbose-logging').on('change', function () {
        const enabled = $(this).prop('checked');
        getMetaSettings().verboseLogging = enabled;
        setVerbose(enabled); saveSettingsDebounced();
    });
    $('#cnz-inspect-chain').on('click', () => openDnaChainInspector());
    $('#cnz-rebuild-rag').on('click', () => rebuildRag());
    $('#cnz-purge-files').on('click', () => purgeCnzFiles());
}
