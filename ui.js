/**
 * @file data/default-user/extensions/canonize/ui.js
 * @architectural-role HTML Builder
 * @description
 * Builds and returns HTML strings for the Canonize wizard modal, the
 * extensions settings panel, and the prompt-editor popup modal.
 * All runtime values are received as parameters so this module carries no
 * imports and remains a pure HTML factory with no side effects.
 * @core-principles
 * 1. OWNS only the static structure of the modal and settings panel; contains no logic.
 * 2. MUST NOT import from index.js or any ST module — caller passes all
 *    runtime values as arguments.
 * 3. IS NOT responsible for injecting the HTML into the DOM; that is done
 *    by injectModal() / injectSettingsPanel() in index.js.
 * @api-declaration
 * Exported symbols:
 *   buildModalHTML() → string
 *   buildPromptModalHTML() → string
 *   buildSettingsHTML(settings, escapeHtml) → string
 * @contract
 *   assertions:
 *     purity: pure # No side effects; same inputs always produce same output.
 *     state_ownership: [] # No module-level state.
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

      <div class="cnz-section-header">
        <span class="cnz-label">Active Hooks Block</span>
        <span id="cnz-spin-hooks" class="cnz-section-spin fa-solid fa-spinner fa-spin cnz-hidden"></span>
        <button id="cnz-regen-hooks" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Regenerate hooks from current transcript">&#x21bb;</button>
      </div>
      <textarea id="cnz-situation-text" class="cnz-textarea cnz-textarea-tall" spellcheck="false"
                placeholder="Hooks block content. Populated from last committed sync. Edit freely or use ↻ to regenerate."></textarea>

      <div id="cnz-error-1" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Step 2: Lorebook Workshop ── -->
    <div id="cnz-step-2" class="cnz-step cnz-hidden">
      <div class="cnz-section-header">
        <h3 id="cnz-lb-title" class="cnz-title">Lorebook</h3>
        <label class="cnz-checkbox-label cnz-label-sm" title="When checked, regen uses the full chat up to the latest turn instead of the sync window">
          <input id="cnz-lb-up-to-latest" type="checkbox"> Up to latest turn
        </label>
        <span id="cnz-lb-spinner" class="cnz-section-spin fa-solid fa-spinner fa-spin cnz-hidden"></span>
        <button id="cnz-lb-regen" class="cnz-btn cnz-btn-secondary cnz-btn-sm">&#x21bb;</button>
      </div>

      <div class="cnz-tab-bar" id="cnz-lb-tab-bar">
        <button id="cnz-lb-tab-btn-ingester" class="cnz-tab-btn cnz-tab-active" data-tab="ingester">Update</button>
        <button id="cnz-lb-tab-btn-freeform" class="cnz-tab-btn" data-tab="freeform">Freeform</button>
      </div>

      <div id="cnz-lb-tab-freeform" class="cnz-tab-panel cnz-hidden">
        <textarea id="cnz-lb-freeform" class="cnz-textarea cnz-textarea-tall" spellcheck="false"
                  placeholder="AI suggestions appear here. Edit freely before switching to Update."></textarea>
      </div>

      <div id="cnz-lb-tab-ingester" class="cnz-tab-panel">
        <div class="cnz-settings-row">
          <label for="cnz-lb-suggestion-select">Suggestion</label>
          <div class="cnz-select-with-nav">
            <select id="cnz-lb-suggestion-select" class="cnz-select"></select>
            <button id="cnz-lb-ingester-next" class="cnz-btn cnz-btn-secondary cnz-btn-sm"
                    title="Jump to next unresolved suggestion">&#x27A1;</button>
          </div>
        </div>

        <span class="cnz-label">Diff (draft &#x2192; edit)</span>
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
            <button id="cnz-lb-revert-ai"    class="cnz-btn cnz-btn-secondary">Revert to AI</button>
            <button id="cnz-lb-revert-draft" class="cnz-btn cnz-btn-secondary">Revert to Draft</button>
          </div>
          <div class="cnz-btn-group">
            <button id="cnz-lb-reject-one" class="cnz-btn cnz-btn-danger">Reject</button>
            <button id="cnz-lb-apply-one"  class="cnz-btn cnz-btn-success">Apply</button>
          </div>
        </div>
        <div class="cnz-buttons">
          <button id="cnz-lb-apply-all-unresolved" class="cnz-btn cnz-btn-secondary">Apply All Unresolved</button>
        </div>
      </div>

      <div id="cnz-lb-error" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Step 3: Narrative Memory Workshop ── -->
    <div id="cnz-step-3" class="cnz-step cnz-hidden">
      <h3 class="cnz-title">Narrative Memory Workshop</h3>

      <div id="cnz-rag-mode-note" class="cnz-mode-note cnz-hidden"></div>

      <div id="cnz-rag-no-summary" class="cnz-warn cnz-hidden">
        A Hooks Block is required to generate semantic headers. Return to Step 1 and complete the hooks text.</div>

      <div id="cnz-rag-disabled" class="cnz-warn cnz-hidden">
        Narrative Memory (RAG) is disabled. Enable it in settings to generate semantic headers for each memory chunk.</div>

      <div id="cnz-rag-detached-warn" class="cnz-warn cnz-warn-amber cnz-hidden">
        Raw view has been edited. Per-card edits are disabled.</div>
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
        <div id="cnz-rag-raw-detached-label" class="cnz-warn cnz-warn-amber cnz-hidden">Raw (edited — sections frozen)</div>
        <textarea id="cnz-rag-raw" class="cnz-textarea cnz-textarea-tall" spellcheck="false"></textarea>
      </div>
    </div>

    <!-- ── Step 4: Review & Commit ── -->
    <div id="cnz-step-4" class="cnz-step cnz-hidden">
      <h3 class="cnz-title">Review &amp; Commit</h3>

      <div id="cnz-step4-summary" class="cnz-step4-summary">
        <div id="cnz-step4-hooks" class="cnz-step4-row"></div>
        <div id="cnz-step4-lore"  class="cnz-step4-row"></div>
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
        <strong>Canonize Commit Interrupted</strong>
        <ol>
          <li>Check which steps above failed.</li>
          <li>Verify your connection profile in <strong>Settings &rarr; Canonize</strong>.</li>
          <li>Click <strong>Finalize</strong> again to retry only the failed steps.</li>
          <li>You can safely close — lorebook changes are preserved until next sync.</li>
        </ol>
      </div>

      <div id="cnz-error-4" class="cnz-error-banner cnz-hidden"></div>
    </div>

    <!-- ── Shared Wizard Footer ── -->
    <div class="cnz-buttons cnz-wizard-footer">
      <button id="cnz-cancel"    class="cnz-btn cnz-btn-danger">Cancel</button>
      <button id="cnz-move-back" class="cnz-btn cnz-btn-secondary cnz-hidden">&lt; Back</button>
      <button id="cnz-move-next" class="cnz-btn cnz-btn-secondary">Next &gt;</button>
      <button id="cnz-confirm"   class="cnz-btn cnz-btn-success cnz-hidden">Finalize</button>
    </div>

  </div>
</div>`;
}

/**
 * Returns the HTML for the prompt-editor popup overlay.
 * The caller populates #cnz-pm-title, #cnz-pm-textarea, and wires buttons.
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
    <div id="cnz-pm-trailing-section" class="cnz-pm-trailing-section cnz-hidden">
      <label class="cnz-label cnz-pm-trailing-label" for="cnz-pm-trailing-textarea">Trailing prompt</label>
      <textarea id="cnz-pm-trailing-textarea" class="cnz-textarea cnz-pm-trailing-textarea" spellcheck="false" placeholder="e.g. Pay special attention to …"></textarea>
    </div>
    <div class="cnz-buttons cnz-wizard-footer">
      <button id="cnz-pm-close" class="cnz-btn cnz-btn-secondary">Close</button>
    </div>
  </div>
</div>`;
}

/**
 * Returns the HTML for the Canonize extensions settings panel.
 * @param {object}   settings        activeState snapshot (read-only).
 * @param {Function} escapeHtml      HTML-escape utility passed from caller.
 * @param {string[]} profileNames    Ordered list of saved profile names.
 * @param {string}   currentProfile  Name of the currently active profile.
 * @returns {string}
 */
export function buildSettingsHTML(settings, escapeHtml, profileNames = ['Default'], currentProfile = 'Default') {
    const s = settings;
    const ragContents      = s.ragContents      ?? 'summary+full';
    const ragSummarySource = s.ragSummarySource ?? 'defined';
    const enableRag        = s.enableRag        ?? false;
    const hasSummary       = ragContents !== 'full';
    const isDefinedHere    = ragSummarySource === 'defined';

    // Shorthand for the info icon — keeps the template readable
    const tip = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;

    const profileOptions = profileNames
        .map(n => `<option value="${escapeHtml(n)}"${n === currentProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`)
        .join('');

    return `
<div id="cnz-settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Canonize</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="cnz-settings-group">

        <!-- ── Profile bar ── -->
        <div class="cnz-settings-row cnz-profile-bar">
          <select id="cnz-profile-select" class="cnz-select cnz-profile-select" title="Active settings profile">${profileOptions}</select>
          <button id="cnz-profile-save"   class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save current settings to this profile">&#x1F4BE;</button>
          <button id="cnz-profile-add"    class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save as new profile">&#x2795;</button>
          <button id="cnz-profile-rename" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Rename this profile">&#x270F;&#xFE0F;</button>
          <button id="cnz-profile-delete" class="cnz-btn cnz-btn-danger    cnz-btn-sm" title="Delete this profile">&#x1F5D1;&#xFE0F;</button>
        </div>

        <!-- ── Summary / Lorebook ── -->
        <div class="cnz-settings-row">
          <label for="cnz-set-profile">Summary Connection Profile ${tip('AI connection used for narrative hook (summary) and lorebook sync calls. Leave blank to use the global connection.')}</label>
          <select id="cnz-set-profile" class="text_pole"></select>
        </div>

        <div class="cnz-settings-inline-row">
          <label for="cnz-set-sync-from-turn">Begin sync from turn ${tip('The first turn included in all processing. Turns before this number are ignored. Useful for skipping prologues or resetting sync mid-story.')}</label>
          <input id="cnz-set-sync-from-turn" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.syncFromTurn ?? 1))}">
        </div>

        <div class="cnz-settings-inline-row">
          <label for="cnz-set-chunk-every-n">Turns between updates ${tip('How many new turns trigger an auto-sync. Also sets the rolling window size — each sync analyses this many of the most recent turns for lorebook and summary.')}</label>
          <input id="cnz-set-chunk-every-n" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.chunkEveryN ?? 20))}">
        </div>

        <div class="cnz-settings-inline-row">
          <label for="cnz-set-hookseeker-horizon">Summary horizon (turns) ${tip('How many of the most recent turns are fed to the narrative hook / summary generator. Higher values give richer context at the cost of more tokens. Typically 50–100.')}</label>
          <input id="cnz-set-hookseeker-horizon" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.hookseekerHorizon ?? 70))}">
        </div>

        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-prune-on-sync" type="checkbox" ${(s.pruneOnSync ?? false) ? 'checked' : ''}>
            <span>Rolling trim ${tip('After each successful sync, delete all turns before the rolling window edge from chat history. Canonized content is already preserved in your lorebook, summary, and RAG — keeping only the active window prevents context bloat over long stories. Irreversible: enable only if you do not need the raw turns after syncing.')}</span>
          </label>
        </div>

        <div class="cnz-settings-inline-row">
          <label for="cnz-set-lorebook-sync-start">Lorebook sync start ${tip('"From latest turn": each sync processes from the Begin sync turn value. "From sync point": only new turns since the last successful lorebook sync are processed — avoids re-analysing old content.')}</label>
          <select id="cnz-set-lorebook-sync-start" class="cnz-select cnz-settings-select-sm">
            <option value="syncTurn"  ${(s.lorebookSyncStart ?? 'syncTurn') === 'syncTurn'  ? 'selected' : ''}>From latest turn</option>
            <option value="lastSync"  ${(s.lorebookSyncStart ?? 'syncTurn') === 'lastSync'  ? 'selected' : ''}>From sync point</option>
          </select>
        </div>

        <div class="cnz-settings-row cnz-settings-prompt-row">
          <button id="cnz-edit-summary-prompt"  class="cnz-btn cnz-btn-secondary"
                  title="Edit the prompt template sent to the AI when generating the narrative hook / scenario summary.">Edit Summary Prompt</button>
          <button id="cnz-edit-lorebook-prompt" class="cnz-btn cnz-btn-secondary"
                  title="Edit the prompt template used when asking the AI to suggest lorebook entry updates and new entries.">Edit Lorebook Sync Prompt</button>
        </div>

        <!-- ── RAG Settings ── -->
        <div class="cnz-settings-section-header">RAG Settings</div>

        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-enable-rag" type="checkbox" ${enableRag ? 'checked' : ''}>
            <span>Enable Narrative Memory (RAG) ${tip('When enabled, each sync builds a structured memory document from the transcript and uploads it to the SillyTavern Data Bank as a character attachment for vector retrieval.')}</span>
          </label>
        </div>

        <div id="cnz-rag-settings-body" class="cnz-settings-subgroup ${enableRag ? '' : 'cnz-disabled'}">

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-rag-separator">Separator ${tip('Template string prepended to every memory chunk in the RAG document. Supports {{turn_number}}, {{char_name}}, {{turn_range}}. Leave blank to use the default *** divider.')}</label>
            <input id="cnz-set-rag-separator" type="text" class="cnz-input cnz-settings-input-wide"
                   placeholder="e.g. ** {{turn_number}} **"
                   value="${escapeHtml(s.ragSeparator ?? '')}">
          </div>
          <small class="cnz-settings-hint">Vars: <code>{{turn_number}}</code>, <code>{{char_name}}</code>, <code>{{turn_range}}</code> &mdash; blank defaults to <code>***</code></small>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-rag-contents">RAG Contents ${tip('"Summary + Full Content": AI-generated header plus raw dialogue. "Summary Only": compact header list, no dialogue. "Full Content Only": raw dialogue with no headers.')}</label>
            <select id="cnz-set-rag-contents" class="cnz-select cnz-settings-select-sm">
              <option value="summary+full" ${ragContents === 'summary+full' ? 'selected' : ''}>Summary + Full Content</option>
              <option value="summary"      ${ragContents === 'summary'      ? 'selected' : ''}>Summary Only</option>
              <option value="full"         ${ragContents === 'full'         ? 'selected' : ''}>Full Content Only</option>
            </select>
          </div>

          <div id="cnz-rag-summary-source-row" class="cnz-settings-inline-row ${hasSummary ? '' : 'cnz-hidden'}">
            <label for="cnz-set-rag-summary-source">Summary Source ${tip('"Defined Here": uses the AI classifier prompt below to generate semantic headers per chunk. "Qvink": reads headers directly from qvink_memory metadata on each AI message — no extra AI calls, forces 1-pair chunks.')}</label>
            <select id="cnz-set-rag-summary-source" class="cnz-select cnz-settings-select-sm">
              <option value="defined" ${isDefinedHere ? 'selected' : ''}>Defined Here</option>
              <option value="qvink"   ${!isDefinedHere ? 'selected' : ''}>Qvink</option>
            </select>
          </div>

          <div id="cnz-rag-ai-controls" class="cnz-settings-subgroup ${(hasSummary && isDefinedHere) ? '' : 'cnz-disabled'}">

            <div class="cnz-settings-row">
              <label for="cnz-set-rag-profile">RAG Connection Profile ${tip('AI connection used for chunk classification calls. Falls back to the Summary profile, then the global connection.')}</label>
              <select id="cnz-set-rag-profile" class="text_pole"></select>
            </div>

            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-max-tokens">Max Tokens ${tip('Maximum tokens the classifier may produce per chunk. Keep low (50–150) to prevent runaway outputs; raise if responses are cut off.')}</label>
              <input id="cnz-set-rag-max-tokens" type="number" min="1"
                     value="${escapeHtml(String(s.ragMaxTokens ?? 100))}">
            </div>

            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-chunk-size">Chunk Size (pairs) ${tip('Number of turn-pairs grouped into each memory chunk when using AI classification. Larger chunks give more context per header but produce fewer total chunks. Qvink mode always uses 1.')}</label>
              <input id="cnz-set-rag-chunk-size" type="number" min="1" max="10" step="1"
                     value="${escapeHtml(String(s.ragChunkSize ?? 2))}">
            </div>

            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-chunk-overlap">Chunk Overlap ${tip('How many turns each chunk shares with the previous one. None: non-overlapping windows (step = chunk size). 1-turn: each chunk adds 1 new turn with 1 prior turn included. 2-turn: each chunk adds 1 new turn with 2 prior turns included.')}</label>
              <select id="cnz-set-rag-chunk-overlap" class="text_pole">
                <option value="0" ${(s.ragChunkOverlap ?? 0) === 0 ? 'selected' : ''}>No overlap</option>
                <option value="1" ${(s.ragChunkOverlap ?? 0) === 1 ? 'selected' : ''}>1-turn overlap</option>
                <option value="2" ${(s.ragChunkOverlap ?? 0) === 2 ? 'selected' : ''}>2-turn overlap</option>
              </select>
            </div>

            <div class="cnz-settings-row cnz-settings-prompt-row">
              <button id="cnz-edit-classifier-prompt" class="cnz-btn cnz-btn-secondary"
                      title="Edit the prompt used to generate a semantic header for each memory chunk.">Edit Classifier Prompt</button>
            </div>

          </div><!-- /cnz-rag-ai-controls -->

        </div><!-- /cnz-rag-settings-body -->

      </div>
    </div>
  </div>
</div>`;
}
