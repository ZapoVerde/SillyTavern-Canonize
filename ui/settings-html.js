/**
 * @file data/default-user/extensions/canonize/ui/settings-html.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role HTML Builder
 * @description
 * Pure HTML factory for the Canonize extension settings panel. 
 * Includes the master engine toggle and configuration groups.
 *
 * @api-declaration
 * buildSettingsHTML(settings, escapeHtml, profileNames, currentProfile, verboseLogging, isExtEnabled)
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: none
 */

/**
 * Returns the HTML for the Canonize extensions settings panel.
 * @param {object}   settings        activeState snapshot.
 * @param {Function} escapeHtml      HTML-escape utility.
 * @param {string[]} profileNames    Ordered list of saved profile names.
 * @param {string}   currentProfile  Name of the currently active profile.
 * @param {boolean}  verboseLogging  Whether verbose logging is enabled.
 * @param {boolean}  isExtEnabled    Whether the entire extension is enabled.
 * @returns {string}
 */
export function buildSettingsHTML(settings, escapeHtml, profileNames, currentProfile, verboseLogging, isExtEnabled) {
    const s = settings;
    const ragContents      = s.ragContents      ?? 'summary+full';
    const ragSummarySource = s.ragSummarySource ?? 'defined';
    const enableRag        = s.enableRag        ?? false;
    const hasSummary       = ragContents !== 'full';
    const isDefinedHere    = ragSummarySource === 'defined';

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

      <!-- ── Master Toggle ── -->
      <div class="cnz-settings-group cnz-master-toggle-group">
        <label class="cnz-checkbox-label" style="font-weight: 600; font-size: 0.95rem;">
          <input id="cnz-set-extension-enabled" type="checkbox" ${isExtEnabled ? 'checked' : ''}>
          <span>Enable Canonize Engine</span>
        </label>
        <div class="cnz-settings-hint" style="margin-left: 24px;">When disabled, auto-sync stops, full chat history is unmasked, and Canonize artifacts are safely detached from the character's active context.</div>
      </div>

      <!-- ── Settings Container (Visually disabled if engine is off) ── -->
      <div id="cnz-settings-container" class="${isExtEnabled ? '' : 'cnz-disabled'}">
      
        <div class="cnz-settings-group">
          <!-- ── Profile management ── -->
          <div class="cnz-settings-row cnz-profile-bar">
            <select id="cnz-profile-select" class="cnz-select cnz-profile-select" title="Active settings profile">${profileOptions}</select>
            <button id="cnz-profile-save"   class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save to this profile">&#x1F4BE;</button>
            <button id="cnz-profile-add"    class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save as new profile">&#x2795;</button>
            <button id="cnz-profile-rename" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Rename profile">&#x270F;&#xFE0F;</button>
            <button id="cnz-profile-delete" class="cnz-btn cnz-btn-danger    cnz-btn-sm" title="Delete profile">&#x1F5D1;&#xFE0F;</button>
          </div>

          <!-- ── Primary Configuration ── -->
          <div class="cnz-settings-note">All numeric settings use <strong>turn pairs</strong>.</div>
          
          <div class="cnz-settings-row">
            <label for="cnz-set-profile">Summary Connection Profile ${tip('AI connection for summary/lorebook sync calls.')}</label>
            <select id="cnz-set-profile" class="text_pole"></select>
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-live-context-buffer">Live context buffer (pairs) ${tip('Turn pairs kept in full live context.')}</label>
            <input id="cnz-set-live-context-buffer" type="number" min="0" step="1" value="${escapeHtml(String(s.liveContextBuffer ?? 5))}">
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-chunk-every-n">Pairs between updates ${tip('Turn pairs that trigger an auto-sync.')}</label>
            <input id="cnz-set-chunk-every-n" type="number" min="1" step="1" value="${escapeHtml(String(s.chunkEveryN ?? 20))}">
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-gap-snooze">Gap snooze (pairs) ${tip('Additional delay after dismissing a large gap offer.')}</label>
            <input id="cnz-set-gap-snooze" type="number" min="1" step="1" value="${escapeHtml(String(s.gapSnoozeTurns ?? 5))}">
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-hookseeker-horizon">Summary horizon (pairs) ${tip('Context window size for summary generation.')}</label>
            <input id="cnz-set-hookseeker-horizon" type="number" min="1" step="1" value="${escapeHtml(String(s.hookseekerHorizon ?? 40))}">
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-lorebook-sync-start">Lorebook sync start</label>
            <select id="cnz-set-lorebook-sync-start">
              <option value="syncPoint"  ${(s.lorebookSyncStart ?? 'syncPoint') === 'syncPoint'  ? 'selected' : ''}>From sync point</option>
              <option value="latestTurn" ${(s.lorebookSyncStart ?? 'syncPoint') === 'latestTurn' ? 'selected' : ''}>From latest turn</option>
            </select>
          </div>

          <div class="cnz-settings-row">
            <label class="cnz-checkbox-label">
              <input id="cnz-set-auto-advance-mask" type="checkbox" ${(s.autoAdvanceMask ?? false) ? 'checked' : ''}>
              <span>Auto-advance context mask ${tip('Hides canonized turns from the main AI.')}</span>
            </label>
          </div>

          <div class="cnz-settings-prompt-row" style="display:flex; gap: 4px; flex-wrap: wrap; margin-top: 8px;">
            <button id="cnz-edit-summary-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Summary Prompt…</button>
            <button id="cnz-edit-lorebook-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Lorebook Prompt…</button>
            <button id="cnz-edit-targeted-update-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Targeted Update…</button>
            <button id="cnz-edit-targeted-new-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Targeted New…</button>
          </div>

          <!-- ── RAG Settings ── -->
          <div class="cnz-settings-section-header">RAG Settings</div>

          <div class="cnz-settings-row">
            <label class="cnz-checkbox-label">
              <input id="cnz-set-enable-rag" type="checkbox" ${enableRag ? 'checked' : ''}>
              <span>Enable Narrative Memory (RAG)</span>
            </label>
          </div>

          <div id="cnz-rag-settings-body" class="cnz-settings-subgroup ${enableRag ? '' : 'cnz-disabled'}">
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-separator">Separator</label>
              <input id="cnz-set-rag-separator" type="text" class="cnz-input cnz-settings-input-wide" placeholder="e.g. ***" value="${escapeHtml(s.ragSeparator ?? '')}">
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-contents">RAG Contents</label>
              <select id="cnz-set-rag-contents" class="cnz-select cnz-settings-select-sm">
                <option value="summary+full" ${ragContents === 'summary+full' ? 'selected' : ''}>Summary + Full Content</option>
                <option value="summary"      ${ragContents === 'summary'      ? 'selected' : ''}>Summary Only</option>
                <option value="full"         ${ragContents === 'full'         ? 'selected' : ''}>Full Content Only</option>
              </select>
            </div>
            <div id="cnz-rag-summary-source-row" class="cnz-settings-inline-row ${hasSummary ? '' : 'cnz-hidden'}">
              <label for="cnz-set-rag-summary-source">Summary Source</label>
              <select id="cnz-set-rag-summary-source" class="cnz-select cnz-settings-select-sm">
                <option value="defined" ${isDefinedHere ? 'selected' : ''}>Defined Here</option>
                <option value="qvink"   ${!isDefinedHere ? 'selected' : ''}>Qvink</option>
              </select>
            </div>

            <div id="cnz-rag-ai-controls" class="cnz-settings-subgroup ${(hasSummary && isDefinedHere) ? '' : 'cnz-disabled'}">
              <div class="cnz-settings-row">
                <label for="cnz-set-rag-profile">RAG Connection Profile</label>
                <select id="cnz-set-rag-profile" class="text_pole"></select>
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-max-tokens">Max Tokens</label>
                <input id="cnz-set-rag-max-tokens" type="number" min="1" value="${escapeHtml(String(s.ragMaxTokens ?? 100))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-chunk-size">Chunk Size (pairs)</label>
                <input id="cnz-set-rag-chunk-size" type="number" min="1" max="10" step="1" value="${escapeHtml(String(s.ragChunkSize ?? 2))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-classifier-history">Classifier History</label>
                <input id="cnz-set-rag-classifier-history" type="number" min="0" step="1" value="${escapeHtml(String(s.ragClassifierHistory ?? 0))}">
              </div>
              <button id="cnz-edit-classifier-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm" style="margin-top: 4px;">Edit Classifier Prompt…</button>
            </div>
          </div>
        </div>

        <!-- ── Danger Zone ── -->
        <div class="cnz-settings-group">
          <div class="cnz-settings-row">
            <label class="cnz-checkbox-label">
              <input id="cnz-set-verbose-logging" type="checkbox" ${verboseLogging ? 'checked' : ''}>
              <span>Verbose logging</span>
            </label>
          </div>
          <div class="cnz-settings-row" style="display:flex; gap: 4px;">
            <button id="cnz-inspect-chain" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Inspect Chain</button>
            <button id="cnz-purge-chain" class="cnz-btn cnz-btn-danger cnz-btn-sm">Purge &amp; Rebuild</button>
            <button id="cnz-purge-files" class="cnz-btn cnz-btn-danger cnz-btn-sm">Purge Files</button>
          </div>
        </div>
      </div>

    </div>
  </div>
</div>`;
}