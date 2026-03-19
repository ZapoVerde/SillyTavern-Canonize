/**
 * @file data/default-user/extensions/STNE/ui.js
 * @architectural-role HTML Builder
 * @description
 * Builds and returns HTML strings for the STNE wizard modal.
 * All runtime values are received as parameters so this module carries no
 * imports and remains a pure HTML factory with no side effects.
 * @core-principles
 * 1. OWNS only the static structure of the modal; contains no logic.
 * 2. MUST NOT import from index.js or any ST module — caller passes all
 *    runtime values as arguments.
 * 3. IS NOT responsible for injecting the HTML into the DOM; that is done
 *    by injectModal() in index.js.
 * @api-declaration
 * Exported symbols:
 *   buildModalHTML() → string
 * @contract
 *   assertions:
 *     purity: pure # No side effects; same inputs always produce same output.
 *     state_ownership: [] # No module-level state.
 *     external_io: none
 */

/**
 * Returns the full modal HTML for the STNE review wizard (4 steps).
 * Step 1: Narrative Hooks editor (pre-populated from committed state; refresh button).
 * Step 2: Lorebook Workshop (ingester + freeform tabs).
 * Step 3: Narrative Memory Workshop (RAG cards + raw view).
 * Step 4: Review & Commit.
 * @returns {string}
 */
export function buildModalHTML() {
    return `
<div id="stne-overlay" class="stne-overlay stne-hidden">
  <div id="stne-modal" class="stne-modal" role="dialog" aria-modal="true">

    <!-- ── Step 1: Narrative Hooks ── -->
    <div id="stne-step-1" class="stne-step stne-hidden">
      <h3 class="stne-title">Narrative Hooks</h3>

      <div class="stne-section-header">
        <span class="stne-label">Active Hooks Block</span>
        <span id="stne-spin-hooks" class="stne-section-spin fa-solid fa-spinner fa-spin stne-hidden"></span>
        <button id="stne-regen-hooks" class="stne-btn stne-btn-secondary stne-btn-sm" title="Regenerate hooks from current transcript">&#x21bb;</button>
      </div>
      <textarea id="stne-situation-text" class="stne-textarea stne-textarea-tall" spellcheck="false"
                placeholder="Hooks block content. Populated from last committed sync. Edit freely or use ↻ to regenerate."></textarea>

      <div id="stne-error-1" class="stne-error-banner stne-hidden"></div>
    </div>

    <!-- ── Step 2: Lorebook Workshop ── -->
    <div id="stne-step-2" class="stne-step stne-hidden">
      <div class="stne-section-header">
        <h3 id="stne-lb-title" class="stne-title">Lorebook</h3>
        <span id="stne-lb-spinner" class="stne-section-spin fa-solid fa-spinner fa-spin stne-hidden"></span>
        <button id="stne-lb-regen" class="stne-btn stne-btn-secondary stne-btn-sm">&#x21bb;</button>
      </div>

      <div class="stne-tab-bar" id="stne-lb-tab-bar">
        <button id="stne-lb-tab-btn-ingester" class="stne-tab-btn stne-tab-active" data-tab="ingester">Update</button>
        <button id="stne-lb-tab-btn-freeform" class="stne-tab-btn" data-tab="freeform">Freeform</button>
      </div>

      <div id="stne-lb-tab-freeform" class="stne-tab-panel stne-hidden">
        <textarea id="stne-lb-freeform" class="stne-textarea stne-textarea-tall" spellcheck="false"
                  placeholder="AI suggestions appear here. Edit freely before switching to Update."></textarea>
      </div>

      <div id="stne-lb-tab-ingester" class="stne-tab-panel">
        <div class="stne-settings-row">
          <label for="stne-lb-suggestion-select">Suggestion</label>
          <div class="stne-select-with-nav">
            <select id="stne-lb-suggestion-select" class="stne-select"></select>
            <button id="stne-lb-ingester-next" class="stne-btn stne-btn-secondary stne-btn-sm"
                    title="Jump to next unresolved suggestion">&#x27A1;</button>
          </div>
        </div>

        <span class="stne-label">Diff (draft &#x2192; edit)</span>
        <div id="stne-lb-ingester-diff" class="stne-ingester-diff"></div>

        <div class="stne-settings-row">
          <label for="stne-lb-editor-name">Name</label>
          <input id="stne-lb-editor-name" class="stne-input" type="text" spellcheck="false">
        </div>

        <div class="stne-settings-row">
          <label for="stne-lb-editor-keys">Keys (comma-separated)</label>
          <input id="stne-lb-editor-keys" class="stne-input" type="text" spellcheck="false">
        </div>

        <span class="stne-label">Content</span>
        <textarea id="stne-lb-editor-content" class="stne-textarea" spellcheck="false"></textarea>

        <div id="stne-lb-error-ingester" class="stne-error-banner stne-hidden"></div>

        <div class="stne-buttons stne-buttons-split">
          <div class="stne-btn-group">
            <button id="stne-lb-revert-ai"    class="stne-btn stne-btn-secondary">Revert to AI</button>
            <button id="stne-lb-revert-draft" class="stne-btn stne-btn-secondary">Revert to Draft</button>
          </div>
          <div class="stne-btn-group">
            <button id="stne-lb-reject-one" class="stne-btn stne-btn-danger">Reject</button>
            <button id="stne-lb-apply-one"  class="stne-btn stne-btn-success">Apply</button>
          </div>
        </div>
        <div class="stne-buttons">
          <button id="stne-lb-apply-all-unresolved" class="stne-btn stne-btn-secondary">Apply All Unresolved</button>
        </div>
      </div>

      <div id="stne-lb-error" class="stne-error-banner stne-hidden"></div>
    </div>

    <!-- ── Step 3: Narrative Memory Workshop ── -->
    <div id="stne-step-3" class="stne-step stne-hidden">
      <h3 class="stne-title">Narrative Memory Workshop</h3>

      <div id="stne-rag-mode-note" class="stne-mode-note stne-hidden"></div>

      <div id="stne-rag-no-summary" class="stne-warn stne-hidden">
        A Hooks Block is required to generate semantic headers. Return to Step 1 and complete the hooks text.</div>

      <div id="stne-rag-disabled" class="stne-warn stne-hidden">
        Narrative Memory (RAG) is disabled. Enable it in settings to generate semantic headers for each memory chunk.</div>

      <div id="stne-rag-detached-warn" class="stne-warn stne-warn-amber stne-hidden">
        Raw view has been edited. Per-card edits are disabled.</div>
      <div id="stne-rag-detached-revert" class="stne-buttons stne-buttons-left stne-hidden">
        <button id="stne-rag-revert-raw-btn" class="stne-btn stne-btn-secondary stne-btn-sm">Revert Raw</button>
      </div>

      <div class="stne-tab-bar" id="stne-rag-tab-bar">
        <button class="stne-tab-btn stne-tab-active" data-tab="sectioned">Sectioned</button>
        <button class="stne-tab-btn" data-tab="raw">Combined Raw</button>
      </div>

      <div id="stne-rag-tab-sectioned" class="stne-tab-panel">
        <div id="stne-rag-cards" class="stne-rag-cards"></div>
      </div>

      <div id="stne-rag-tab-raw" class="stne-tab-panel stne-hidden">
        <div id="stne-rag-raw-detached-label" class="stne-warn stne-warn-amber stne-hidden">Raw (edited — sections frozen)</div>
        <textarea id="stne-rag-raw" class="stne-textarea stne-textarea-tall" spellcheck="false"></textarea>
      </div>
    </div>

    <!-- ── Step 4: Review & Commit ── -->
    <div id="stne-step-4" class="stne-step stne-hidden">
      <h3 class="stne-title">Review &amp; Commit</h3>

      <div id="stne-step4-summary" class="stne-step4-summary">
        <div id="stne-step4-hooks" class="stne-step4-row"></div>
        <div id="stne-step4-lore"  class="stne-step4-row"></div>
        <div id="stne-step4-rag" class="stne-rag-panel stne-hidden">
          <span class="stne-label">Narrative Memory (RAG)</span>
          <div id="stne-rag-timeline" class="stne-rag-timeline"></div>
          <div id="stne-rag-warning" class="stne-warn stne-hidden"></div>
        </div>
      </div>

      <div id="stne-receipts" class="stne-receipts stne-hidden">
        <div class="stne-receipts-title">Commit Receipts</div>
        <div id="stne-receipts-content" class="stne-receipts-content"></div>
      </div>

      <div id="stne-recovery-guide" class="stne-warn stne-recovery-guide stne-hidden">
        <strong>STNE Commit Interrupted</strong>
        <ol>
          <li>Check which steps above failed.</li>
          <li>Verify your connection profile in <strong>Settings &rarr; STNE</strong>.</li>
          <li>Click <strong>Finalize</strong> again to retry only the failed steps.</li>
          <li>You can safely close — lorebook changes are preserved until next sync.</li>
        </ol>
      </div>

      <div id="stne-error-4" class="stne-error-banner stne-hidden"></div>
    </div>

    <!-- ── Shared Wizard Footer ── -->
    <div class="stne-buttons stne-wizard-footer">
      <button id="stne-cancel"    class="stne-btn stne-btn-danger">Cancel</button>
      <button id="stne-move-back" class="stne-btn stne-btn-secondary stne-hidden">&lt; Back</button>
      <button id="stne-move-next" class="stne-btn stne-btn-secondary">Next &gt;</button>
      <button id="stne-confirm"   class="stne-btn stne-btn-success stne-hidden">Finalize</button>
    </div>

  </div>
</div>`;
}

