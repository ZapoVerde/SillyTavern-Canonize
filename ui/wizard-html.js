/**
 * @file data/default-user/extensions/canonize/ui/wizard-html.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role HTML Builder
 * @description
 * Pure HTML factory for the 4-step Canonize Review Wizard.
 *
 * @api-declaration
 * buildModalHTML()
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: none
 */

/**
 * Returns the full modal HTML for the Canonize review wizard (4 steps).
 * @returns {string}
 */
export function buildModalHTML() {
    return `
<div id="cnz-overlay" class="cnz-overlay cnz-hidden">
  <div id="cnz-modal" class="cnz-modal" role="dialog" aria-modal="true">

    <!-- ── Step 1: Narrative Hooks ── -->
    <div id="cnz-step-1" class="cnz-step cnz-hidden">
      <h3 class="cnz-title">Narrative Hooks</h3>

      <div class="cnz-tab-bar" id="cnz-hooks-tab-bar">
        <button class="cnz-tab-btn cnz-tab-active" data-tab="workshop">Workshop</button>
        <button class="cnz-tab-btn" data-tab="new">New</button>
        <button class="cnz-tab-btn" data-tab="old">Old</button>
      </div>

      <!-- Workshop tab: live diff (read-only) + editable textarea + revert buttons -->
      <div id="cnz-hooks-tab-workshop" class="cnz-tab-panel">
        <span class="cnz-label">Changes since last sync (vs Old)</span>
        <div id="cnz-hooks-diff" class="cnz-ingester-diff"></div>
        <textarea id="cnz-situation-text" class="cnz-textarea cnz-textarea-tall" spellcheck="false"
                  placeholder="Hooks block content. Edit freely."></textarea>
        <div class="cnz-buttons cnz-buttons-left">
          <button id="cnz-hooks-revert-old" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Revert to Old</button>
          <button id="cnz-hooks-revert-new" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Revert to New</button>
        </div>
      </div>

      <!-- New tab: read-only display of what the last sync wrote + Regen -->
      <div id="cnz-hooks-tab-new" class="cnz-tab-panel cnz-hidden">
        <span class="cnz-label">New (written by last sync)</span>
        <div id="cnz-hooks-new-display" class="cnz-ingester-diff"></div>
        <div class="cnz-section-header">
          <span id="cnz-spin-hooks" class="cnz-section-spin fa-solid fa-spinner fa-spin cnz-hidden"></span>
          <button id="cnz-regen-hooks" class="cnz-btn cnz-btn-secondary" title="Regenerate hooks from current transcript">&#x21bb; Regen</button>
        </div>
      </div>

      <!-- Old tab: read-only display of hooks before the last sync -->
      <div id="cnz-hooks-tab-old" class="cnz-tab-panel cnz-hidden">
        <span class="cnz-label">Old (before last sync)</span>
        <div id="cnz-hooks-old-display" class="cnz-ingester-diff"></div>
      </div>

      <div id="cnz-error-1" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Step 2: Lorebook Workshop ── -->
    <div id="cnz-step-2" class="cnz-step cnz-hidden">
      <div class="cnz-section-header">
        <h3 id="cnz-lb-title" class="cnz-title">Lorebook</h3>
        <span id="cnz-lb-spinner" class="cnz-section-spin fa-solid fa-spinner fa-spin cnz-hidden"></span>
      </div>

      <div class="cnz-tab-bar" id="cnz-lb-tab-bar">
        <button class="cnz-tab-btn cnz-tab-active" data-tab="ingester">Ingester</button>
        <button class="cnz-tab-btn" data-tab="freeform">Freeform</button>
        <label class="cnz-checkbox-label cnz-label-sm cnz-tab-bar-right"
               title="When checked, all workshop AI calls build their transcript from the full chat up to the current turn instead of the default sync window">
          <input id="cnz-lb-up-to-latest" type="checkbox"> Up to latest turn
        </label>
      </div>

      <div id="cnz-lb-tab-ingester" class="cnz-tab-panel">
        <div class="cnz-settings-row">
          <label for="cnz-lb-suggestion-select">Committed sync changes</label>
          <div class="cnz-select-with-nav">
            <select id="cnz-lb-suggestion-select" class="cnz-select"></select>
            <button id="cnz-lb-ingester-next" class="cnz-btn cnz-btn-secondary cnz-btn-sm"
                    title="Jump to next unresolved suggestion">&#x27A1; Next</button>
          </div>
        </div>

        <hr class="cnz-lane-divider" style="margin: 4px 0; border: none; border-top: 1px solid var(--cnz-modal-border); opacity: 0.5;" />

        <div class="cnz-lane-card" style="border: 1px solid var(--cnz-modal-border); border-radius: 4px; padding: 8px; background: rgba(255,255,255,0.02);">
          <span class="cnz-label">Lane 2: Generate new entry</span>
          <div class="cnz-select-with-nav">
            <input id="cnz-targeted-keyword" class="cnz-input" type="text" placeholder="New concept name…" />
            <button id="cnz-targeted-generate" class="cnz-btn cnz-btn-primary cnz-btn-sm">Generate</button>
            <span id="cnz-targeted-spinner" class="fa-solid fa-spinner fa-spin cnz-hidden" style="align-self: center; margin-left: 4px;"></span>
          </div>
          <div id="cnz-targeted-error" class="cnz-error-inline cnz-hidden"></div>
        </div>

        <hr class="cnz-lane-divider" style="margin: 4px 0; border: none; border-top: 1px solid var(--cnz-modal-border); opacity: 0.5;" />

        <div class="cnz-settings-row">
          <label for="cnz-targeted-entry-select">Lane 3: Load existing entry</label>
          <select id="cnz-targeted-entry-select" class="cnz-input"></select>
        </div>

        <hr class="cnz-lane-divider" style="margin: 4px 0; border: none; border-top: 1px solid var(--cnz-modal-border); opacity: 0.5;" />

        <span class="cnz-label">Diff (pre-sync &#x2192; current)</span>
        <div id="cnz-lb-ingester-diff" class="cnz-ingester-diff"></div>

        <div class="cnz-settings-row">
          <label for="cnz-lb-editor-name">Name</label>
          <input id="cnz-lb-editor-name" class="cnz-input" type="text" spellcheck="false">
        </div>

        <div class="cnz-settings-row">
          <label for="cnz-lb-editor-keys">Keys (comma-separated)</label>
          <input id="cnz-lb-editor-keys" class="cnz-input" type="text" spellcheck="false">
        </div>

        <span class="cnz-label">Content</span>
        <textarea id="cnz-lb-editor-content" class="cnz-textarea" spellcheck="false"></textarea>

        <div id="cnz-lb-error-ingester" class="cnz-error-banner cnz-hidden"></div>

        <div class="cnz-buttons cnz-buttons-split">
          <div class="cnz-btn-group">
            <button id="cnz-lb-btn-prev" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Load the pre-sync version">&#x2190; Prev</button>
            <button id="cnz-lb-btn-latest" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Load the most recent AI version">Latest &#x2192;</button>
            <button id="cnz-lb-btn-regen" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Fire fresh targeted AI call">&#x21bb; Regen</button>
          </div>
          <div class="cnz-btn-group">
            <button id="cnz-lb-reject-one" class="cnz-btn cnz-btn-danger" title="Revert to pre-sync state">Reject</button>
            <button id="cnz-lb-delete-one" class="cnz-btn cnz-btn-danger cnz-btn-sm" title="Delete entry entirely">Delete</button>
            <button id="cnz-lb-apply-one" class="cnz-btn cnz-btn-success" title="Mark as resolved">Apply</button>
          </div>
        </div>
        <div class="cnz-buttons">
          <button id="cnz-lb-apply-all-unresolved" class="cnz-btn cnz-btn-secondary">Apply All Unresolved</button>
        </div>
      </div>

      <div id="cnz-lb-tab-freeform" class="cnz-tab-panel cnz-hidden">
        <div class="cnz-buttons cnz-buttons-left">
          <button id="cnz-lb-freeform-regen" class="cnz-btn cnz-btn-secondary cnz-btn-sm">&#x21bb; Regen</button>
        </div>
        <textarea id="cnz-lb-freeform" class="cnz-textarea cnz-textarea-tall" readonly spellcheck="false"
                  placeholder="Overview of committed changes."></textarea>
      </div>
      <div id="cnz-lb-error" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Step 3: Narrative Memory Workshop ── -->
    <div id="cnz-step-3" class="cnz-step cnz-hidden">
      <h3 class="cnz-title">Narrative Memory Workshop</h3>
      <div id="cnz-rag-mode-note" class="cnz-mode-note cnz-hidden"></div>
      <div id="cnz-rag-disabled" class="cnz-warn cnz-hidden">Narrative Memory (RAG) is disabled.</div>
      <div id="cnz-rag-detached-warn" class="cnz-warn cnz-warn-amber cnz-hidden">Raw view edited. Sections frozen.</div>
      <div id="cnz-rag-detached-revert" class="cnz-buttons cnz-buttons-left cnz-hidden">
        <button id="cnz-rag-revert-raw-btn" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Revert Raw</button>
      </div>

      <div class="cnz-tab-bar" id="cnz-rag-tab-bar">
        <button class="cnz-tab-btn cnz-tab-active" data-tab="sectioned">Sectioned</button>
        <button class="cnz-tab-btn" data-tab="raw">Combined Raw</button>
      </div>

      <div id="cnz-rag-tab-sectioned" class="cnz-tab-panel">
        <div id="cnz-rag-cards" class="cnz-rag-cards"></div>
      </div>
      <div id="cnz-rag-tab-raw" class="cnz-tab-panel cnz-hidden">
        <textarea id="cnz-rag-raw" class="cnz-textarea cnz-textarea-tall" spellcheck="false"></textarea>
      </div>
    </div>

    <!-- ── Step 4: Review & Commit ── -->
    <div id="cnz-step-4" class="cnz-step cnz-hidden">
      <h3 class="cnz-title">Review &amp; Commit</h3>
      <div id="cnz-step4-summary" class="cnz-step4-summary">
        <div id="cnz-step4-hooks" class="cnz-step4-row" style="font-size: 0.85rem; padding: 4px 0; border-bottom: 1px solid var(--cnz-modal-border);"></div>
        <div id="cnz-step4-lore"  class="cnz-step4-row" style="font-size: 0.85rem; padding: 4px 0;"></div>
        <div id="cnz-step4-rag" class="cnz-rag-panel cnz-hidden">
          <span class="cnz-label">Narrative Memory (RAG)</span>
          <div id="cnz-rag-timeline" class="cnz-rag-timeline"></div>
          <div id="cnz-rag-warning" class="cnz-warn cnz-hidden"></div>
        </div>
      </div>

      <div id="cnz-receipts" class="cnz-receipts cnz-hidden">
        <div class="cnz-receipts-title">Commit Receipts</div>
        <div id="cnz-receipts-content" class="cnz-receipts-content"></div>
      </div>

      <div id="cnz-recovery-guide" class="cnz-warn cnz-recovery-guide cnz-hidden">
        <strong>Commit Interrupted</strong>
        <ol>
          <li>Check failed steps.</li>
          <li>Verify connection profile.</li>
          <li>Click Finalize to retry.</li>
        </ol>
      </div>
      <div id="cnz-error-4" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Shared Footer ── -->
    <div class="cnz-buttons cnz-wizard-footer">
      <button id="cnz-cancel" class="cnz-btn cnz-btn-danger">Cancel</button>
      <button id="cnz-move-back" class="cnz-btn cnz-btn-secondary cnz-hidden">&lt; Back</button>
      <button id="cnz-move-next" class="cnz-btn cnz-btn-secondary">Next &gt;</button>
      <button id="cnz-confirm" class="cnz-btn cnz-btn-success cnz-hidden">Finalize</button>
    </div>
  </div>
</div>`;
}