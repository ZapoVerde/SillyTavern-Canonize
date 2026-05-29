/**
 * @file data/default-user/extensions/canonize/settings/html-plot.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the Plot Management section of the CNZ settings panel.
 * Controls for semantic arc retrieval, minimum arc floor, and filler arc strategy.
 *
 * @api-declaration
 * buildPlotSectionHTML(s, escapeHtml) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildPlotSectionHTML(s, escapeHtml) {
    const tip            = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;
    const fillerEnabled  = s.ragPlotFillerEnabled ?? true;
    const strategy       = s.ragPlotFillerStrategy ?? 'random';

    return `
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>Plot Management</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">

              <div class="cnz-settings-inline-row">
                <label for="cnz-set-plot-retrieval-topk">Semantic arcs per turn ${tip('How many plot arcs to retrieve via semantic similarity each turn.')}</label>
                <input id="cnz-set-plot-retrieval-topk" type="number" min="0" max="10" step="1" value="${escapeHtml(String(s.ragPlotRetrievalTopK ?? 3))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-plot-recency-count">Cards per semantic arc ${tip('How many of the most recent entries to include for each semantically matched arc.')}</label>
                <input id="cnz-set-plot-recency-count" type="number" min="1" max="10" step="1" value="${escapeHtml(String(s.ragPlotRecencyCount ?? 3))}">
              </div>

              <div class="cnz-settings-inline-row">
                <label for="cnz-set-plot-min-arcs">Minimum arcs per turn ${tip('Total arcs to include per turn. Filler arcs pad up to this number when semantic results fall short.')}</label>
                <input id="cnz-set-plot-min-arcs" type="number" min="0" max="10" step="1" value="${escapeHtml(String(s.ragPlotMinArcs ?? 2))}">
              </div>

              <div class="cnz-settings-row">
                <label class="cnz-checkbox-label">
                  <input id="cnz-set-plot-filler-enabled" type="checkbox" ${fillerEnabled ? 'checked' : ''}>
                  <span>Add filler arcs to reach minimum ${tip('When semantic results are below the minimum, pad with additional arcs from the plot lorebook.')}</span>
                </label>
              </div>

              <div id="cnz-plot-filler-body" class="${fillerEnabled ? '' : 'cnz-disabled'}">
                <div class="cnz-settings-inline-row">
                  <label for="cnz-set-plot-filler-cards">Cards per filler arc ${tip('How many recent entries to include per filler arc. Keep low — fillers are background context.')}</label>
                  <input id="cnz-set-plot-filler-cards" type="number" min="1" max="5" step="1" value="${escapeHtml(String(s.ragPlotFillerCards ?? 1))}">
                </div>
                <div class="cnz-settings-inline-row">
                  <label for="cnz-set-plot-filler-strategy">Filler selection ${tip('How to pick which arcs fill the gap.')}</label>
                  <select id="cnz-set-plot-filler-strategy" class="cnz-select cnz-settings-select-sm">
                    <option value="random"          ${strategy === 'random'           ? 'selected' : ''}>Random</option>
                    <option value="oldest_arc"      ${strategy === 'oldest_arc'       ? 'selected' : ''}>Oldest arc</option>
                    <option value="oldest_surfaced" ${strategy === 'oldest_surfaced'  ? 'selected' : ''}>Longest since surfaced</option>
                  </select>
                </div>
              </div>

            </div>
          </div>`;
}
