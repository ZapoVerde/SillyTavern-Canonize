/**
 * @file data/default-user/extensions/canonize/ui/prompt-editor.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role UI Builder
 * @description
 * Logic for the prompt-editor modal. Handles reading/writing multi-line AI 
 * prompts from the settings panel, including template variable badges 
 * and reset-to-default functionality.
 *
 * @api-declaration
 * openPromptModal(settingsKey, title, defaultValue, vars)
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [saveSettingsDebounced]
 */

import { saveSettingsDebounced } from '../../../../../script.js';
import { getSettings } from '../settings/data.js';

/**
 * Opens the prompt-editor popup for a given settings key.
 * Changes are saved live on input; the modal is closed with the Close button
 * or by clicking the overlay backdrop.
 * 
 * Note: Depends on updateDirtyIndicator being exported from the settings panel logic.
 * 
 * @param {string}      settingsKey        Key in extension_settings[EXT_NAME] to read/write.
 * @param {string}      title              Title displayed in the modal header.
 * @param {string}      defaultValue       Value used by the "Reset to Default" button.
 * @param {string[]}    vars               Template variable names to display as badges.
 */
export async function openPromptModal(settingsKey, title, defaultValue, vars = []) {
    const { updateDirtyIndicator } = await import('../settings/panel.js');

    const $overlay  = $('#cnz-pm-overlay');
    const $textarea = $('#cnz-pm-textarea');
    const $titleEl  = $('#cnz-pm-title');
    const $reset    = $('#cnz-pm-reset');
    const $close    = $('#cnz-pm-close');
    const $vars     = $('#cnz-pm-vars');

    $titleEl.text(title);
    $textarea.val(getSettings()[settingsKey] ?? defaultValue);
    $vars.html(vars.map(v => `<code class="cnz-pm-var">{{${v}}}</code>`).join(' '));

    // Unbind any previous open's handlers before re-binding
    $textarea.off('input.pm');
    $reset.off('click.pm');
    $close.off('click.pm');
    $overlay.off('mousedown.pm click.pm');
    $('#cnz-pm-modal').off('mousedown.pm click.pm').on('mousedown.pm click.pm', e => e.stopPropagation());

    $textarea.on('input.pm', function () {
        getSettings()[settingsKey] = $(this).val();
        saveSettingsDebounced(); 
        updateDirtyIndicator();
    });

    $reset.on('click.pm', function () {
        getSettings()[settingsKey] = defaultValue;
        $textarea.val(defaultValue);
        saveSettingsDebounced(); 
        updateDirtyIndicator();
    });

    const closePromptModal = (e) => {
        e?.stopPropagation();
        $overlay.addClass('cnz-hidden');
    };

    $close.on('click.pm', closePromptModal);
    $overlay.on('click.pm', function (e) {
        if (e.target === this) closePromptModal(e);
    }).on('mousedown.pm', function (e) {
        if (e.target === this) e.stopPropagation();
    });

    $overlay.removeClass('cnz-hidden');
    requestAnimationFrame(() => $textarea[0]?.focus());
}