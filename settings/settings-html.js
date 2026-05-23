/**
 * @file data/default-user/extensions/canonize/settings/settings-html.js
 * @stamp {"utc":"2026-05-22T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Builds and returns the HTML string for the Canonize extension settings panel.
 * Extracted from ui.js to keep both files under the 300-line limit.
 * All runtime values are received as parameters; this module holds no state
 * and performs no IO.
 *
 * @api-declaration
 * buildSettingsHTML(settings, escapeHtml, profileNames, currentProfile, verboseLogging) → string
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: []
 */

/**
 * Returns the HTML for the Canonize extensions settings panel.
 * @param {object}   settings        activeState snapshot (read-only).
 * @param {Function} escapeHtml      HTML-escape utility passed from caller.
 * @param {string[]} profileNames    Ordered list of saved profile names.
 * @param {string}   currentProfile  Name of the currently active profile.
 * @param {boolean}  verboseLogging  Current verbose logging state.
 * @returns {string}
 */
export function buildSettingsHTML(settings, escapeHtml, profileNames = ['Default'], currentProfile = 'Default', verboseLogging = false) {
    const s = settings;
    const ragContents      = s.ragContents      ?? 'summary+full';
    const ragSummarySource = s.ragSummarySource ?? 'defined';
    const enableRag        = s.enableRag        ?? false;
    const hasSummary       = ragContents !== 'full';
    const isDefinedHere    = ragSummarySource === 'defined';
    const embedSource      = s.ragEmbeddingSource ?? 'local';
    const isRemoteEmbed    = embedSource !== 'local';

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
        <div class="cnz-settings-note">All numeric settings use <strong>turn pairs</strong> (one user message + one AI reply = 1 pair).</div>
        <div class="cnz-settings-row">
          <label for="cnz-set-profile">Summary Connection Profile ${tip('AI connection used for narrative hook (summary) and lorebook sync calls. Leave blank to use the global connection.')}</label>
          <select id="cnz-set-profile" class="text_pole"></select>
        </div>
        <div class="cnz-settings-inline-row">
          <label for="cnz-set-live-context-buffer">Live context buffer (pairs) ${tip('Number of recent turn pairs kept in full live context, counted back from the end of the chat. These pairs are excluded from sync.')}</label>
          <input id="cnz-set-live-context-buffer" type="number" min="0" step="1" value="${escapeHtml(String(s.liveContextBuffer ?? 5))}">
        </div>
        <div class="cnz-settings-inline-row">
          <label for="cnz-set-chunk-every-n">Pairs between updates ${tip('How many new turn pairs trigger an auto-sync. Also sets the standard sync window size.')}</label>
          <input id="cnz-set-chunk-every-n" type="number" min="1" step="1" value="${escapeHtml(String(s.chunkEveryN ?? 20))}">
        </div>
        <div class="cnz-settings-inline-row">
          <label for="cnz-set-gap-snooze">Gap snooze (pairs) ${tip('When a large gap is detected and you dismiss the offer, auto-sync will stay quiet for this many additional pairs.')}</label>
          <input id="cnz-set-gap-snooze" type="number" min="1" step="1" value="${escapeHtml(String(s.gapSnoozeTurns ?? 5))}">
        </div>
        <div class="cnz-settings-inline-row">
          <label for="cnz-set-hookseeker-horizon">Summary horizon (pairs) ${tip('How many of the most recent turn pairs are fed to the narrative hook / summary generator.')}</label>
          <input id="cnz-set-hookseeker-horizon" type="number" min="1" step="1" value="${escapeHtml(String(s.hookseekerHorizon ?? 40))}">
        </div>
        <div class="cnz-settings-inline-row">
          <label for="cnz-set-lorebook-sync-start">Lorebook sync start ${tip('"From sync point": only the gap turns this cycle. "From latest turn": the full hookseeker window.')}</label>
          <select id="cnz-set-lorebook-sync-start">
            <option value="syncPoint"  ${(s.lorebookSyncStart ?? 'syncPoint') === 'syncPoint'  ? 'selected' : ''}>From sync point</option>
            <option value="latestTurn" ${(s.lorebookSyncStart ?? 'syncPoint') === 'latestTurn' ? 'selected' : ''}>From latest turn</option>
          </select>
        </div>
        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-auto-advance-mask" type="checkbox" ${(s.autoAdvanceMask ?? false) ? 'checked' : ''}>
            <span>Auto-advance context mask ${tip('When enabled, the context mask follows the DNA chain head after each commit, hiding canonized turns from the main AI.')}</span>
          </label>
        </div>
        <div class="cnz-setting-row">
          <label class="cnz-label">Summary Prompt</label>
          <button id="cnz-edit-summary-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
        </div>
        <div class="cnz-setting-row">
          <label class="cnz-label">Lorebook Sync Prompt</label>
          <button id="cnz-edit-lorebook-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
        </div>
        <div class="cnz-setting-row">
          <label class="cnz-label">Targeted Update Prompt</label>
          <button id="cnz-edit-targeted-update-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
        </div>
        <div class="cnz-setting-row">
          <label class="cnz-label">Targeted New Entry Prompt</label>
          <button id="cnz-edit-targeted-new-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
        </div>

        <!-- ── RAG Settings ── -->
        <div class="cnz-settings-section-header">RAG Settings</div>
        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-enable-rag" type="checkbox" ${enableRag ? 'checked' : ''}>
            <span>Enable Narrative Memory (RAG) ${tip('When enabled, each sync classifies memory chunks and indexes them in the CNZ SQLite vector DB for semantic retrieval at generation time.')}</span>
          </label>
        </div>

        <div id="cnz-rag-settings-body" class="cnz-settings-subgroup ${enableRag ? '' : 'cnz-disabled'}">

          <!-- ── Classification ── -->
          <div class="cnz-settings-inline-row" id="cnz-rag-contents-row">
            <label for="cnz-set-rag-contents">RAG Contents ${tip('"Summary + Full Content": AI-generated header plus raw dialogue. "Summary Only": compact header list. "Full Content Only": raw dialogue.')}</label>
            <select id="cnz-set-rag-contents" class="cnz-select cnz-settings-select-sm">
              <option value="summary+full" ${ragContents === 'summary+full' ? 'selected' : ''}>Summary + Full Content</option>
              <option value="summary"      ${ragContents === 'summary'      ? 'selected' : ''}>Summary Only</option>
              <option value="full"         ${ragContents === 'full'         ? 'selected' : ''}>Full Content Only</option>
            </select>
          </div>
          <div id="cnz-rag-summary-source-row" class="cnz-settings-inline-row ${hasSummary ? '' : 'cnz-hidden'}">
            <label for="cnz-set-rag-summary-source">Summary Source ${tip('"Defined Here": AI classifier prompt generates semantic headers per chunk. "Qvink": reads headers from qvink_memory metadata.')}</label>
            <select id="cnz-set-rag-summary-source" class="cnz-select cnz-settings-select-sm">
              <option value="defined" ${isDefinedHere ? 'selected' : ''}>Defined Here</option>
              <option value="qvink"   ${!isDefinedHere ? 'selected' : ''}>Qvink</option>
            </select>
          </div>

          <div id="cnz-rag-ai-controls" class="cnz-settings-subgroup ${(hasSummary && isDefinedHere) ? '' : 'cnz-disabled'}">
            <div class="cnz-settings-row">
              <label for="cnz-set-rag-profile">RAG Connection Profile ${tip('AI connection used for chunk classification calls.')}</label>
              <select id="cnz-set-rag-profile" class="text_pole"></select>
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-max-tokens">Max Tokens ${tip('Maximum tokens the classifier may produce per chunk.')}</label>
              <input id="cnz-set-rag-max-tokens" type="number" min="1" value="${escapeHtml(String(s.ragMaxTokens ?? 100))}">
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-chunk-size">Chunk Size (pairs) ${tip('Number of turn-pairs grouped into each memory chunk.')}</label>
              <input id="cnz-set-rag-chunk-size" type="number" min="1" max="10" step="1" value="${escapeHtml(String(s.ragChunkSize ?? 2))}">
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-chunk-overlap">Chunk Overlap</label>
              <select id="cnz-set-rag-chunk-overlap" class="text_pole">
                <option value="0" ${(s.ragChunkOverlap ?? 0) === 0 ? 'selected' : ''}>No overlap</option>
                <option value="1" ${(s.ragChunkOverlap ?? 0) === 1 ? 'selected' : ''}>1-turn overlap</option>
                <option value="2" ${(s.ragChunkOverlap ?? 0) === 2 ? 'selected' : ''}>2-turn overlap</option>
              </select>
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-classifier-history">Classifier History ${tip('Turn-pairs preceding each chunk included as context in the classifier prompt. 0 = disabled.')}</label>
              <input id="cnz-set-rag-classifier-history" type="number" min="0" step="1" value="${escapeHtml(String(s.ragClassifierHistory ?? 0))}"> pairs
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-max-concurrent">Simultaneous Calls</label>
              <input id="cnz-set-rag-max-concurrent" type="number" min="1" max="10" step="1" value="${escapeHtml(String(s.maxConcurrentCalls ?? 3))}">
            </div>
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-rag-retries">Retries on Failure</label>
              <input id="cnz-set-rag-retries" type="number" min="0" max="5" step="1" value="${escapeHtml(String(s.ragMaxRetries ?? 1))}">
            </div>
            <div class="cnz-setting-row">
              <label class="cnz-label">Classifier Prompt ${tip('Sent to the AI once per memory chunk to produce a semantic header.')}</label>
              <button id="cnz-edit-classifier-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
            </div>
          </div><!-- /cnz-rag-ai-controls -->

          <!-- ── Retrieval Settings ── -->
          <div class="cnz-settings-section-header">Retrieval Settings</div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-embedding-source">Embedding Source ${tip('Embedding provider. Uses the API key already stored in ST\'s connection settings — no separate key needed.')}</label>
            <select id="cnz-set-embedding-source" class="cnz-select cnz-settings-select-sm">
              <option value="openrouter" selected>OpenRouter</option>
              <option value="openai">OpenAI</option>
            </select>
          </div>
          <div id="cnz-rag-remote-embed-rows">
            <div class="cnz-settings-inline-row">
              <label for="cnz-set-embedding-model">Embedding Model ${tip('Model ID for the selected provider. Click Browse to pick from a live list. OpenRouter: provider/model-name (e.g. openai/text-embedding-3-small). OpenAI: model name only (e.g. text-embedding-3-small).')}</label>
              <div style="display:flex;gap:4px;align-items:center">
                <input id="cnz-set-embedding-model" type="text" class="cnz-input cnz-settings-input-wide"
                       placeholder="e.g. openai/text-embedding-3-small"
                       value="${escapeHtml(s.ragEmbeddingModel ?? '')}">
                <button id="cnz-browse-embedding-model" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Browse available embedding models for the selected provider">Browse</button>
              </div>
            </div>
            <select id="cnz-embedding-model-list" class="cnz-select cnz-hidden" style="width:100%;margin-top:4px;font-size:0.8rem"></select>
          </div>

          <div class="cnz-settings-inline-row">
            <label for="cnz-set-rag-score-threshold">Score Threshold ${tip('Minimum cosine similarity (0–1) for a chunk to be injected. 0 = inject everything. 0.25 is a sensible default for well-labeled chunks.')}</label>
            <input id="cnz-set-rag-score-threshold" type="number" min="0" max="1" step="0.05"
                   value="${escapeHtml(String(s.ragScoreThreshold ?? 0.25))}">
          </div>
          <div class="cnz-settings-inline-row">
            <label for="cnz-set-rag-retrieval-topk">Chunks — chat context ${tip('How many chunks to retrieve using recent chat messages as the query. These surface memories relevant to what is happening right now.')}</label>
            <input id="cnz-set-rag-retrieval-topk" type="number" min="0" max="20" step="1"
                   value="${escapeHtml(String(s.ragRetrievalTopK ?? 5))}">
          </div>
          <div class="cnz-settings-inline-row">
            <label for="cnz-set-rag-lb-retrieval-topk">Chunks — lorebook context ${tip('How many chunks to retrieve using the currently active lorebook entries as the query. These surface memories relevant to the current world state.')}</label>
            <input id="cnz-set-rag-lb-retrieval-topk" type="number" min="0" max="20" step="1"
                   value="${escapeHtml(String(s.ragLbRetrievalTopK ?? 3))}">
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">Injection Template ${tip('Wraps the retrieved chunks before injection. Use {{text}} where the chunks should appear.')}</label>
            <button id="cnz-edit-injection-template" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>

          <div class="cnz-setting-row">
            <label class="cnz-label">Chunk Template ${tip('Wraps each individual retrieved chunk. Supports {{text}}, {{turn_range}}, {{header}}, {{char_name}}.')}</label>
            <button id="cnz-edit-chunk-template" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>

          <div class="cnz-settings-inline-row" id="cnz-rag-separator-row">
            <label for="cnz-set-rag-separator">Sync Separator ${tip('Separator used between chunks in classifier documents during sync. Changing this invalidates stored chunk headers.')}</label>
            <input id="cnz-set-rag-separator" type="text" class="cnz-input cnz-settings-input-wide"
                   placeholder="e.g. %%%" value="${escapeHtml(s.ragSeparator ?? '%%%')}">
          </div>

        </div><!-- /cnz-rag-settings-body -->
      </div>

      <!-- ── Danger zone ── -->
      <div class="cnz-settings-group">
        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-verbose-logging" type="checkbox" ${verboseLogging ? 'checked' : ''}>
            <span>Verbose logging ${tip('When enabled, informational log messages are printed to the browser console.')}</span>
          </label>
        </div>
        <div class="cnz-settings-row">
          <button id="cnz-inspect-chain" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Inspect Chain</button>
          <button id="cnz-purge-chain"   class="cnz-btn cnz-btn-danger cnz-btn-sm">Purge &amp; Rebuild</button>
          <button id="cnz-purge-files"   class="cnz-btn cnz-btn-danger cnz-btn-sm">Purge</button>
        </div>
      </div>

    </div>
  </div>
</div>`;
}
