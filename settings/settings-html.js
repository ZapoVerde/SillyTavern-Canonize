/**
 * @file data/default-user/extensions/canonize/settings/settings-html.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @version 2.0.0
 * @architectural-role Pure Functions
 * @description
 * Assembles the full HTML string for the Canonize extension settings panel by
 * composing the three section builders. Owns only the outer shell (drawer
 * wrapper and master enable toggle); all section content is delegated.
 *
 * @api-declaration
 * buildSettingsHTML(settings, escapeHtml, profileNames, currentProfile,
 *                  verboseLogging, enableCnz) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

import { buildSyncSectionHTML  } from './html-sync.js';
import { buildRagSectionHTML   } from './html-rag.js';
import { buildPlotSectionHTML  } from './html-plot.js';
import { buildAdminSectionHTML } from './html-admin.js';

export function buildSettingsHTML(
    settings,
    escapeHtml,
    profileNames   = ['Default'],
    currentProfile = 'Default',
    verboseLogging = false,
    enableCnz      = true,
) {
    const profileOptions = profileNames
        .map(n => `<option value="${escapeHtml(n)}"${n === currentProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`)
        .join('');

    return `
<div id="cnz-settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Canonize</b>
      <a href="https://github.com/ZapoVerde/SillyTavern-Canonize/blob/main/docs/settings.md" target="_blank" rel="noopener" class="cnz-docs-link" title="Settings documentation" onclick="event.stopPropagation()">docs</a>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">

      <div class="cnz-settings-row cnz-enable-row">
        <label class="cnz-checkbox-label">
          <input id="cnz-set-enable-cnz" type="checkbox" ${enableCnz ? 'checked' : ''}>
          <span>Enable Canonize</span>
        </label>
      </div>

      <div id="cnz-main-settings"${enableCnz ? '' : ' class="cnz-disabled"'}>
        ${buildSyncSectionHTML(settings, escapeHtml, profileOptions)}
        ${buildRagSectionHTML(settings, escapeHtml)}
        ${buildPlotSectionHTML(settings, escapeHtml)}
        ${buildAdminSectionHTML(escapeHtml, verboseLogging)}
      </div>

    </div>
  </div>
</div>`;
}
