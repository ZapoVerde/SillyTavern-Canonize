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
        <strong>Canonize Commit Interrupted</strong>
        <ol>
          <li>Check which steps above failed.</li>
          <li>Verify your connection profile in <strong>Settings &rarr; Canonize</strong>.</li>
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

/**
 * Returns the HTML for the prompt-editor popup overlay.
 * The caller populates #stne-pm-title, #stne-pm-textarea, and wires buttons.
 * @returns {string}
 */
export function buildPromptModalHTML() {
    return `
<div id="stne-pm-overlay" class="stne-overlay stne-pm-overlay stne-hidden">
  <div id="stne-pm-modal" class="stne-modal stne-pm-modal" role="dialog" aria-modal="true">
    <div class="stne-section-header">
      <h3 id="stne-pm-title" class="stne-title"></h3>
      <button id="stne-pm-reset" class="stne-btn stne-btn-secondary stne-btn-sm">Reset to Default</button>
    </div>
    <div id="stne-pm-vars" class="stne-pm-vars"></div>
    <textarea id="stne-pm-textarea" class="stne-textarea stne-pm-textarea" spellcheck="false"></textarea>
    <div class="stne-buttons stne-wizard-footer">
      <button id="stne-pm-close" class="stne-btn stne-btn-secondary">Close</button>
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
    const tip = (text) => `<span class="stne-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;

    const profileOptions = profileNames
        .map(n => `<option value="${escapeHtml(n)}"${n === currentProfile ? ' selected' : ''}>${escapeHtml(n)}</option>`)
        .join('');

    return `
<div id="stne-settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>Canonize</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="stne-settings-group">

        <!-- ── Profile bar ── -->
        <div class="stne-settings-row stne-profile-bar">
          <select id="stne-profile-select" class="stne-select stne-profile-select" title="Active settings profile">${profileOptions}</select>
          <button id="stne-profile-save"   class="stne-btn stne-btn-secondary stne-btn-sm" title="Save current settings to this profile">&#x1F4BE;</button>
          <button id="stne-profile-add"    class="stne-btn stne-btn-secondary stne-btn-sm" title="Save as new profile">&#x2795;</button>
          <button id="stne-profile-rename" class="stne-btn stne-btn-secondary stne-btn-sm" title="Rename this profile">&#x270F;&#xFE0F;</button>
          <button id="stne-profile-delete" class="stne-btn stne-btn-danger    stne-btn-sm" title="Delete this profile">&#x1F5D1;&#xFE0F;</button>
        </div>

        <!-- ── Summary / Lorebook ── -->
        <div class="stne-settings-row">
          <label for="stne-set-profile">Summary Connection Profile ${tip('AI connection used for narrative hook (summary) and lorebook sync calls. Leave blank to use the global connection.')}</label>
          <select id="stne-set-profile" class="text_pole"></select>
        </div>

        <div class="stne-settings-inline-row">
          <label for="stne-set-sync-from-turn">Begin sync from turn ${tip('The first turn included in all processing. Turns before this number are ignored. Useful for skipping prologues or resetting sync mid-story.')}</label>
          <input id="stne-set-sync-from-turn" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.syncFromTurn ?? 1))}">
        </div>

        <div class="stne-settings-inline-row">
          <label for="stne-set-chunk-every-n">Turns between updates ${tip('How many new turns trigger an auto-sync. Also sets the rolling window size — each sync analyses this many of the most recent turns for lorebook and summary.')}</label>
          <input id="stne-set-chunk-every-n" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.chunkEveryN ?? 20))}">
        </div>

        <div class="stne-settings-inline-row">
          <label for="stne-set-hookseeker-horizon">Summary horizon (turns) ${tip('How many of the most recent turns are fed to the narrative hook / summary generator. Higher values give richer context at the cost of more tokens. Typically 50–100.')}</label>
          <input id="stne-set-hookseeker-horizon" type="number" min="1" step="1"
                 value="${escapeHtml(String(s.hookseekerHorizon ?? 70))}">
        </div>

        <div class="stne-settings-row">
          <label class="stne-checkbox-label">
            <input id="stne-set-prune-on-sync" type="checkbox" ${(s.pruneOnSync ?? false) ? 'checked' : ''}>
            <span>Rolling trim ${tip('After each successful sync, delete all turns before the rolling window edge from chat history. Canonized content is already preserved in your lorebook, summary, and RAG — keeping only the active window prevents context bloat over long stories. Irreversible: enable only if you do not need the raw turns after syncing.')}</span>
          </label>
        </div>

        <div class="stne-settings-inline-row">
          <label for="stne-set-lorebook-sync-start">Lorebook sync start ${tip('"From latest turn": each sync processes from the Begin sync turn value. "From sync point": only new turns since the last successful lorebook sync are processed — avoids re-analysing old content.')}</label>
          <select id="stne-set-lorebook-sync-start" class="stne-select stne-settings-select-sm">
            <option value="syncTurn"  ${(s.lorebookSyncStart ?? 'syncTurn') === 'syncTurn'  ? 'selected' : ''}>From latest turn</option>
            <option value="lastSync"  ${(s.lorebookSyncStart ?? 'syncTurn') === 'lastSync'  ? 'selected' : ''}>From sync point</option>
          </select>
        </div>

        <div class="stne-settings-row stne-settings-prompt-row">
          <button id="stne-edit-summary-prompt"  class="stne-btn stne-btn-secondary"
                  title="Edit the prompt template sent to the AI when generating the narrative hook / scenario summary.">Edit Summary Prompt</button>
          <button id="stne-edit-lorebook-prompt" class="stne-btn stne-btn-secondary"
                  title="Edit the prompt template used when asking the AI to suggest lorebook entry updates and new entries.">Edit Lorebook Sync Prompt</button>
        </div>

        <div class="stne-settings-row">
          <label for="stne-hookseeker-trailing-prompt">Summary trailing prompt ${tip('Extra instructions appended after the transcript when running the summarizer. Use this to add context-specific guidance without editing the full prompt template.')}</label>
          <textarea id="stne-hookseeker-trailing-prompt" class="stne-input" rows="4"
                    placeholder="e.g. Pay special attention to …"
                    style="width:100%;resize:vertical;">${escapeHtml(s.hookseekerTrailingPrompt ?? '')}</textarea>
        </div>

        <!-- ── RAG Settings ── -->
        <div class="stne-settings-section-header">RAG Settings</div>

        <div class="stne-settings-row">
          <label class="stne-checkbox-label">
            <input id="stne-set-enable-rag" type="checkbox" ${enableRag ? 'checked' : ''}>
            <span>Enable Narrative Memory (RAG) ${tip('When enabled, each sync builds a structured memory document from the transcript and uploads it to the SillyTavern Data Bank as a character attachment for vector retrieval.')}</span>
          </label>
        </div>

        <div id="stne-rag-settings-body" class="stne-settings-subgroup ${enableRag ? '' : 'stne-disabled'}">

          <div class="stne-settings-inline-row">
            <label for="stne-set-rag-separator">Separator ${tip('Template string prepended to every memory chunk in the RAG document. Supports {{turn_number}}, {{char_name}}, {{turn_range}}. Leave blank to use the default *** divider.')}</label>
            <input id="stne-set-rag-separator" type="text" class="stne-input stne-settings-input-wide"
                   placeholder="e.g. ** {{turn_number}} **"
                   value="${escapeHtml(s.ragSeparator ?? '')}">
          </div>
          <small class="stne-settings-hint">Vars: <code>{{turn_number}}</code>, <code>{{char_name}}</code>, <code>{{turn_range}}</code> &mdash; blank defaults to <code>***</code></small>

          <div class="stne-settings-inline-row">
            <label for="stne-set-rag-contents">RAG Contents ${tip('"Summary + Full Content": AI-generated header plus raw dialogue. "Summary Only": compact header list, no dialogue. "Full Content Only": raw dialogue with no headers.')}</label>
            <select id="stne-set-rag-contents" class="stne-select stne-settings-select-sm">
              <option value="summary+full" ${ragContents === 'summary+full' ? 'selected' : ''}>Summary + Full Content</option>
              <option value="summary"      ${ragContents === 'summary'      ? 'selected' : ''}>Summary Only</option>
              <option value="full"         ${ragContents === 'full'         ? 'selected' : ''}>Full Content Only</option>
            </select>
          </div>

          <div id="stne-rag-summary-source-row" class="stne-settings-inline-row ${hasSummary ? '' : 'stne-hidden'}">
            <label for="stne-set-rag-summary-source">Summary Source ${tip('"Defined Here": uses the AI classifier prompt below to generate semantic headers per chunk. "Qvink": reads headers directly from qvink_memory metadata on each AI message — no extra AI calls, forces 1-pair chunks.')}</label>
            <select id="stne-set-rag-summary-source" class="stne-select stne-settings-select-sm">
              <option value="defined" ${isDefinedHere ? 'selected' : ''}>Defined Here</option>
              <option value="qvink"   ${!isDefinedHere ? 'selected' : ''}>Qvink</option>
            </select>
          </div>

          <div id="stne-rag-ai-controls" class="stne-settings-subgroup ${(hasSummary && isDefinedHere) ? '' : 'stne-disabled'}">

            <div class="stne-settings-row">
              <label for="stne-set-rag-profile">RAG Connection Profile ${tip('AI connection used for chunk classification calls. Falls back to the Summary profile, then the global connection.')}</label>
              <select id="stne-set-rag-profile" class="text_pole"></select>
            </div>

            <div class="stne-settings-inline-row">
              <label for="stne-set-rag-max-tokens">Max Tokens ${tip('Maximum tokens the classifier may produce per chunk. Keep low (50–150) to prevent runaway outputs; raise if responses are cut off.')}</label>
              <input id="stne-set-rag-max-tokens" type="number" min="1"
                     value="${escapeHtml(String(s.ragMaxTokens ?? 100))}">
            </div>

            <div class="stne-settings-inline-row">
              <label for="stne-set-rag-chunk-size">Chunk Size (pairs) ${tip('Number of turn-pairs grouped into each memory chunk when using AI classification. Larger chunks give more context per header but produce fewer total chunks. Qvink mode always uses 1.')}</label>
              <input id="stne-set-rag-chunk-size" type="number" min="1" max="10" step="1"
                     value="${escapeHtml(String(s.ragChunkSize ?? 2))}">
            </div>

            <div class="stne-settings-inline-row">
              <label for="stne-set-rag-chunk-overlap">Chunk Overlap ${tip('How many turns each chunk shares with the previous one. None: non-overlapping windows (step = chunk size). 1-turn: each chunk adds 1 new turn with 1 prior turn included. 2-turn: each chunk adds 1 new turn with 2 prior turns included.')}</label>
              <select id="stne-set-rag-chunk-overlap" class="text_pole">
                <option value="0" ${(s.ragChunkOverlap ?? 0) === 0 ? 'selected' : ''}>No overlap</option>
                <option value="1" ${(s.ragChunkOverlap ?? 0) === 1 ? 'selected' : ''}>1-turn overlap</option>
                <option value="2" ${(s.ragChunkOverlap ?? 0) === 2 ? 'selected' : ''}>2-turn overlap</option>
              </select>
            </div>

            <div class="stne-settings-row stne-settings-prompt-row">
              <button id="stne-edit-classifier-prompt" class="stne-btn stne-btn-secondary"
                      title="Edit the prompt used to generate a semantic header for each memory chunk.">Edit Classifier Prompt</button>
            </div>

          </div><!-- /stne-rag-ai-controls -->

        </div><!-- /stne-rag-settings-body -->

      </div>
    </div>
  </div>
</div>`;
}
