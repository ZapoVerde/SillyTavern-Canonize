/**
 * @file data/default-user/extensions/canonize/core/gap-mode.js
 * @stamp {"utc":"2026-07-02T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the shared radio-list markup for the three large-gap catch-up modes
 * (single / onestep / auto). Used by both the auto-sync toast (index.js) and
 * the wand button's manual dialog (wand.js) so the two surfaces render and
 * read identically — bold label on its own line, explanation stacked below —
 * instead of drifting into two different layouts.
 *
 * @api-declaration
 * buildGapModeRadiosHtml(modes) — modes: {value, label, desc, checked}[] → HTML string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildGapModeRadiosHtml(modes) {
    const options = modes.map(m => `
        <label class="cnz-gap-mode-option">
            <input type="radio" name="cnz-gap-mode" value="${m.value}"${m.checked ? ' checked' : ''}>
            <span class="cnz-gap-mode-text">
                <span class="cnz-gap-mode-label">${m.label}</span>
                <span class="cnz-gap-mode-desc">${m.desc}</span>
            </span>
        </label>`).join('');
    return `<div class="cnz-gap-mode-list">${options}</div>`;
}
