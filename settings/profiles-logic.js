/**
 * @file data/default-user/extensions/canonize/settings/profiles-logic.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role Stateful Owner / UI Builder
 * @description
 * Manages profile CRUD operations (Save, Add, Rename, Delete) and dirty-state 
 * tracking for the settings panel.
 *
 * @api-declaration
 * isStateDirty, updateDirtyIndicator, refreshProfileDropdown, bindProfileHandlers
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [extension_settings.cnz]
 *     external_io: [saveSettingsDebounced, callPopup]
 */

import { saveSettingsDebounced, callPopup } from '../../../../../script.js';
import { getSettings, getMetaSettings } from './data.js';
import { escapeHtml } from '../state.js';

/** 
 * True if activeState differs from the saved profile snapshot. 
 * @returns {boolean}
 */
export function isStateDirty() {
    const meta = getMetaSettings();
    return JSON.stringify(meta.activeState) !== JSON.stringify(meta.profiles[meta.currentProfileName]);
}

/** 
 * Updates the profile dropdown label to append '*' when state is dirty. 
 */
export function updateDirtyIndicator() {
    const meta  = getMetaSettings();
    const label = meta.currentProfileName + (isStateDirty() ? ' *' : '');
    const $sel  = $('#cnz-profile-select');
    $sel.find(`option[value="${CSS.escape(meta.currentProfileName)}"]`).text(label);
    $sel.val(meta.currentProfileName);
}

/** 
 * Rebuilds the profile <select> options from the current profiles dict. 
 */
export function refreshProfileDropdown() {
    const meta = getMetaSettings();
    const $sel = $('#cnz-profile-select');
    if (!$sel.length) return;
    $sel.empty();
    for (const name of Object.keys(meta.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateDirtyIndicator();
}

/**
 * Binds click and change handlers for the profile management UI.
 * @param {Function} refreshUI  Callback to refresh the main settings form.
 */
export function bindProfileHandlers(refreshUI) {
    $('#cnz-profile-select').on('change', function () {
        const newName = $(this).val();
        const meta    = getMetaSettings();
        if (!meta.profiles[newName]) return;
        meta.currentProfileName = newName;
        meta.activeState        = structuredClone(meta.profiles[newName]);
        saveSettingsDebounced();
        refreshUI();
    });

    $('#cnz-profile-save').on('click', function () {
        const meta = getMetaSettings();
        meta.profiles[meta.currentProfileName] = structuredClone(meta.activeState);
        saveSettingsDebounced();
        updateDirtyIndicator();
    });

    $('#cnz-profile-add').on('click', async function () {
        const rawName = await callPopup('<h3>New profile name</h3>', 'input', '');
        const name    = (rawName ?? '').trim();
        if (!name) return;
        const meta = getMetaSettings();
        if (meta.profiles[name]) {
            toastr.warning(`Profile "${name}" already exists.`);
            return;
        }
        meta.profiles[name]     = structuredClone(meta.activeState);
        meta.currentProfileName = name;
        saveSettingsDebounced();
        refreshProfileDropdown();
        refreshUI();
    });

    $('#cnz-profile-rename').on('click', async function () {
        const meta    = getMetaSettings();
        const rawName = await callPopup('<h3>Rename profile</h3>', 'input', meta.currentProfileName);
        const newName = (rawName ?? '').trim();
        if (!newName || newName === meta.currentProfileName) return;
        if (meta.profiles[newName]) {
            toastr.warning(`Profile "${newName}" already exists.`);
            return;
        }
        meta.profiles[newName] = meta.profiles[meta.currentProfileName];
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = newName;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#cnz-profile-delete').on('click', async function () {
        const meta = getMetaSettings();
        if (Object.keys(meta.profiles).length <= 1) {
            toastr.warning('Cannot delete the only profile.');
            return;
        }
        const confirmed = await callPopup(
            `<h3>Delete profile "${escapeHtml(meta.currentProfileName)}"?</h3>This cannot be undone.`,
            'confirm',
        );
        if (!confirmed) return;
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = Object.keys(meta.profiles)[0];
        meta.activeState        = structuredClone(meta.profiles[meta.currentProfileName]);
        saveSettingsDebounced();
        refreshProfileDropdown();
        refreshUI();
    });
}