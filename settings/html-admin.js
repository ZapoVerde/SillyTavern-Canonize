/**
 * @file data/default-user/extensions/canonize/settings/html-admin.js
 * @stamp {"utc":"2026-05-25T01:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the admin section of the CNZ settings panel:
 * plugin symlink setup button and the danger-zone controls.
 *
 * @api-declaration
 * buildAdminSectionHTML(escapeHtml, verboseLogging, pluginLinked) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildAdminSectionHTML(escapeHtml, verboseLogging, pluginLinked) {
    const tip = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;

    return `
      <div class="cnz-settings-group">
        <div class="cnz-settings-row">
          <button id="cnz-setup-symlink-btn" class="cnz-btn cnz-btn-secondary cnz-btn-sm"${pluginLinked ? ' disabled' : ''}>${pluginLinked ? 'Plugin Linked' : 'Setup Symlink'}</button>
          ${tip('Replace the deployed plugin folder with a symlink so it stays in sync with the extension automatically.')}
        </div>
      </div>
      <div class="cnz-settings-group">
        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-verbose-logging" type="checkbox" ${verboseLogging ? 'checked' : ''}>
            <span>Verbose logging ${tip('When enabled, informational log messages are printed to the browser console.')}</span>
          </label>
        </div>
        <div class="cnz-settings-row">
          <button id="cnz-inspect-chain" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Inspect Chain</button>
          <button id="cnz-rebuild-rag"   class="cnz-btn cnz-btn-secondary cnz-btn-sm">Rebuild RAG</button>
          <button id="cnz-purge-files"   class="cnz-btn cnz-btn-danger cnz-btn-sm">Purge RAG</button>
        </div>
      </div>`;
}
