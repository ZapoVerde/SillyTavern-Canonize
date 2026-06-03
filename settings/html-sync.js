/**
 * @file data/default-user/extensions/canonize/settings/html-sync.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the sync engine area: an always-visible profile bar,
 * a collapsible CNZ Timing section, and a collapsible Connections & Prompts section.
 *
 * @api-declaration
 * buildSyncSectionHTML(s, escapeHtml, profileOptions) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildSyncSectionHTML(s, escapeHtml, profileOptions) {
    const tip = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;

    return `
      <!-- ── Profile bar (always visible) ── -->
      <div class="cnz-settings-group">
        <div class="cnz-settings-row cnz-profile-bar">
          <select id="cnz-profile-select" class="cnz-select cnz-profile-select" title="Active settings profile">${profileOptions}</select>
          <button id="cnz-profile-save"   class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save current settings to this profile">&#x1F4BE;</button>
          <button id="cnz-profile-add"    class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Save as new profile">&#x2795;</button>
          <button id="cnz-profile-rename" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Rename this profile">&#x270F;&#xFE0F;</button>
          <button id="cnz-profile-delete" class="cnz-btn cnz-btn-danger    cnz-btn-sm" title="Delete this profile">&#x1F5D1;&#xFE0F;</button>
        </div>
      </div>

      <!-- ── CNZ Timing (collapsible) ── -->
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>CNZ Timing</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="cnz-settings-note">All numeric settings use <strong>turn pairs</strong> (one user message + one AI reply = 1 pair).</div>
          <div class="cnz-settings-inline-row">
            <label for="cnz-set-live-context-buffer">Live context buffer (pairs) ${tip('Number of recent turn pairs kept in full live context, counted back from the end of the chat. These pairs are excluded from sync.')}</label>
            <input id="cnz-set-live-context-buffer" type="number" min="0" step="1" value="${escapeHtml(String(s.liveContextBuffer ?? 5))}">
          </div>
          <div class="cnz-settings-inline-row">
            <label for="cnz-set-chunk-every-n">Pairs between updates ${tip('How many new turn pairs trigger an auto-sync. Also sets the standard sync window size.')}</label>
            <input id="cnz-set-chunk-every-n" type="number" min="1" step="1" value="${escapeHtml(String(s.chunkEveryN ?? 20))}">
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
        </div>
      </div>

      <!-- ── Connections & Prompts (collapsible) ── -->
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>Connections &amp; Prompts</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
        </div>
        <div class="inline-drawer-content">
          <div class="cnz-settings-row">
            <label for="cnz-set-profile">Summary Connection Profile ${tip('AI connection used for narrative hook (summary) and lorebook sync calls. Leave blank to use the global connection.')}</label>
            <select id="cnz-set-profile" class="text_pole"></select>
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">Summary Prompt</label>
            <button id="cnz-edit-summary-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">Lorebook Sync Prompt</label>
            <button id="cnz-edit-lorebook-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>
          <div class="cnz-settings-row">
            <label class="cnz-checkbox-label">
              <input id="cnz-set-enable-people-sync" type="checkbox" ${(s.enablePeopleSync ?? true) ? 'checked' : ''}>
              <span>People Curator ${tip('When enabled, a dedicated AI pass tracks and updates character (#person) entries. Disable to treat your character entries as a manual source of truth — CNZ will sync world facts but never touch person entries.')}</span>
            </label>
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">People Sync Prompt</label>
            <button id="cnz-edit-people-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">Targeted Update Prompt</label>
            <button id="cnz-edit-targeted-update-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>
          <div class="cnz-setting-row">
            <label class="cnz-label">Targeted New Entry Prompt</label>
            <button id="cnz-edit-targeted-new-prompt" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Edit…</button>
          </div>
          <div class="cnz-settings-row">
            <button id="cnz-reset-all-prompts" class="cnz-btn cnz-btn-danger cnz-btn-sm">Reset All Prompts to Default</button>
          </div>
        </div>
      </div>`;
}
