/**
 * @file data/default-user/extensions/canonize/settings/html-admin.js
 * @stamp {"utc":"2026-06-03T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the admin section of the CNZ settings panel:
 * large-gap catch-up default, verbose logging toggle, and the danger-zone
 * controls (inspect chain, rebuild RAG, purge RAG).
 *
 * @api-declaration
 * buildAdminSectionHTML(escapeHtml, verboseLogging, gapCatchupDefault) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildAdminSectionHTML(escapeHtml, verboseLogging, gapCatchupDefault) {
    const tip = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;
    const mode = gapCatchupDefault ?? 'onestep';

    return `
      <div class="cnz-settings-group">
        <div class="cnz-settings-row">
          <label for="cnz-set-gap-catchup-default">Large gap catch-up default ${tip('When a large gap is detected (a new chat, or one resumed after time away), CNZ offers a choice of three ways to close it: Full gap, one shot (one pass over everything), Individual step and stop (process one window, ask again next message), or Auto step and continue (loop windows automatically). This sets which one starts pre-selected on that offer.')}</label>
          <select id="cnz-set-gap-catchup-default">
            <option value="single"  ${mode === 'single'  ? 'selected' : ''}>Full gap, one shot</option>
            <option value="onestep" ${mode === 'onestep' ? 'selected' : ''}>Individual step and stop</option>
            <option value="auto"    ${mode === 'auto'    ? 'selected' : ''}>Auto step and continue</option>
          </select>
        </div>
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
