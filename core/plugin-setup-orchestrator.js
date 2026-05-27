/**
 * @file data/default-user/extensions/canonize/core/plugin-setup-orchestrator.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role Orchestrator
 * @description
 * Sequences the plugin health check, user notification, and symlink consent flow.
 *
 * runPluginSetup() — called once at extension init. Fires the unreachable toast
 * if the plugin is missing, then offers the symlink modal exactly once per install
 * (gated by the persistent symlinkOfferMade flag in meta-settings).
 *
 * triggerSetupFromSettings() — called by the settings panel button. Always runs
 * the full health check; skips the one-shot gate. Updates the button state on
 * completion so it greys out if the symlink is already in place.
 *
 * @api-declaration
 * runPluginSetup()            → Promise<void>
 * triggerSetupFromSettings()  → Promise<void>
 *
 * @contract
 *   assertions:
 *     purity:          mutates (DOM via toastr and modal, meta-settings)
 *     state_ownership: [none]
 *     external_io:     [plugin-health.js, plugin-setup-modal.js, toastr, saveSettingsDebounced]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { checkPluginHealth, requestInstallSymlink } from '../rag/plugin-health.js';
import {
    injectSetupModal, showSymlinkConsentModal, showPermissionDeniedModal,
} from '../modal/plugin-setup-modal.js';
import { getMetaSettings } from './settings.js';

const UNREACHABLE_TOAST = {
    message: 'CNZ plugin not found — RAG disabled. ' +
        'Set <code>enableServerPlugins: true</code> in <code>config.yaml</code> ' +
        '(or <code>SILLYTAVERN_ENABLESERVERPLUGINS=true</code> in Docker), ' +
        'copy the extension\'s <code>plugin/</code> folder as <code>[ST]/plugins/cnz/</code> ' +
        '(its contents should be directly inside <code>cnz/</code>), ' +
        'run <code>npm install</code> there, then restart ST.',
    opts: { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
};

function _updateSettingsButton(linked) {
    $('#cnz-setup-symlink-btn')
        .prop('disabled', linked)
        .text(linked ? 'Plugin Linked' : 'Setup Symlink');
}

function _showModal({ needsSymlink, extensionFound, canWrite, isDocker }) {
    if (!needsSymlink || !extensionFound) return;
    if (!canWrite) {
        showPermissionDeniedModal({ isDocker });
    } else {
        showSymlinkConsentModal({
            onConfirm: async () => {
                await requestInstallSymlink();
                _updateSettingsButton(true);
                toastr.success('CNZ: symlink created. Restart ST to activate.');
            },
        });
    }
}

export async function runPluginSetup() {
    injectSetupModal();

    const result = await checkPluginHealth();

    if (!result.reachable) {
        toastr.warning(UNREACHABLE_TOAST.message, 'CNZ Setup', UNREACHABLE_TOAST.opts);
        return;
    }

    if (!result.needsSymlink || !result.extensionFound) return;

    const meta = getMetaSettings();
    if (meta.symlinkOfferMade) return;
    meta.symlinkOfferMade = true;
    saveSettingsDebounced();

    _showModal(result);
}

export async function triggerSetupFromSettings() {
    const result = await checkPluginHealth();

    if (!result.reachable) {
        toastr.warning(UNREACHABLE_TOAST.message, 'CNZ Setup', UNREACHABLE_TOAST.opts);
        return;
    }

    if (!result.needsSymlink) {
        _updateSettingsButton(true);
        toastr.info('CNZ plugin is already linked to the extension.');
        return;
    }

    _showModal(result);
}
