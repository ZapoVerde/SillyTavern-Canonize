/**
 * @file data/default-user/extensions/canonize/ui/common-modals-html.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role HTML Builder
 * @description
 * Pure HTML factory for secondary Canonize modals (Prompt Editor, 
 * Orphan Review, DNA Chain Inspector).
 *
 * @api-declaration
 * buildPromptModalHTML(), buildOrphanModalHTML(), buildDnaChainInspectorHTML()
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: none
 */

/**
 * Returns the HTML for the prompt-editor popup overlay.
 * @returns {string}
 */
export function buildPromptModalHTML() {
    return `
<div id="cnz-pm-overlay" class="cnz-overlay cnz-pm-overlay cnz-hidden">
  <div id="cnz-pm-modal" class="cnz-modal cnz-pm-modal" role="dialog" aria-modal="true">
    <div class="cnz-section-header">
      <h3 id="cnz-pm-title" class="cnz-title"></h3>
      <button id="cnz-pm-reset" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Reset to Default</button>
    </div>
    <div id="cnz-pm-vars" class="cnz-pm-vars"></div>
    <textarea id="cnz-pm-textarea" class="cnz-textarea cnz-pm-textarea" spellcheck="false"></textarea>
    <div class="cnz-buttons cnz-wizard-footer">
      <button id="cnz-pm-close" class="cnz-btn cnz-btn-secondary">Close</button>
    </div>
  </div>
</div>`;
}

/**
 * Returns the HTML for the Orphan Review modal.
 * @returns {string}
 */
export function buildOrphanModalHTML() {
    return `
<div id="cnz-orphan-overlay" class="cnz-overlay cnz-hidden">
  <div id="cnz-orphan-modal" class="cnz-modal cnz-li-modal" role="dialog" aria-modal="true">
    <div class="cnz-section-header">
      <h3 id="cnz-orphan-title" class="cnz-title">Orphaned Files</h3>
      <button id="cnz-orphan-close" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Close</button>
    </div>
    <div id="cnz-orphan-body" class="cnz-li-body"></div>
    <div class="cnz-orphan-footer">
      <button id="cnz-orphan-delete-all" class="cnz-btn cnz-btn-danger">Delete All</button>
    </div>
  </div>
</div>`;
}

/**
 * Returns the HTML for the DNA Chain Inspector modal.
 * @returns {string}
 */
export function buildDnaChainInspectorHTML() {
    return `
<div id="cnz-li-overlay" class="cnz-overlay cnz-hidden">
  <div id="cnz-li-modal" class="cnz-modal cnz-li-modal" role="dialog" aria-modal="true">
    <div class="cnz-section-header">
      <h3 id="cnz-li-title" class="cnz-title">DNA Chain Inspector</h3>
      <button id="cnz-li-close" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Close</button>
    </div>
    <div id="cnz-li-body" class="cnz-li-body"></div>
  </div>
</div>`;
}