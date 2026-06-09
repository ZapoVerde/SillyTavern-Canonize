/**
 * @file data/default-user/extensions/canonize/settings/html-additional-lb.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Renders the dynamic row list for the additional lorebooks panel section.
 * Called by handlers-additional-lb.js whenever the list changes; output is
 * injected into #cnz-additional-lb-list.
 *
 * @api-declaration
 * renderAdditionalLbRows(lbs, escapeHtml) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

/**
 * Returns the HTML for all current additional lorebook rows.
 * Each row shows the lorebook name, min/max inputs, bypass toggle, remove button.
 * @param {import('../state.js').AdditionalLorebook[]} lbs
 * @param {(s:string)=>string} escapeHtml
 * @returns {string}
 */
export function renderAdditionalLbRows(lbs, escapeHtml) {
    if (!lbs.length) {
        return `<div class="cnz-settings-muted" style="font-size:0.85rem;padding:4px 0">No additional lorebooks configured.</div>`;
    }

    return lbs.map((lb, idx) => `
      <div class="cnz-settings-inline-row cnz-additional-lb-row" data-idx="${idx}" style="gap:6px;flex-wrap:wrap;align-items:center">
        <span style="flex:1;font-size:0.88rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escapeHtml(lb.name)}">${escapeHtml(lb.name)}</span>
        <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Min</label>
        <input class="cnz-additional-lb-min" type="number" min="0" max="20" step="1" style="width:46px"
               value="${escapeHtml(String(lb.min ?? 1))}" data-idx="${idx}">
        <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Max</label>
        <input class="cnz-additional-lb-max" type="number" min="1" max="20" step="1" style="width:46px"
               value="${escapeHtml(String(lb.max ?? 3))}" data-idx="${idx}">
        <label class="cnz-checkbox-label" style="font-size:0.82rem;white-space:nowrap">
          <input class="cnz-additional-lb-bypass" type="checkbox" data-idx="${idx}" ${lb.bypass ? 'checked' : ''}>
          <span>Bypass WI</span>
        </label>
        <button class="cnz-btn cnz-btn-secondary cnz-btn-sm cnz-additional-lb-remove" data-idx="${idx}"
                style="padding:2px 7px;line-height:1.4" title="Remove">✕</button>
      </div>`).join('');
}
