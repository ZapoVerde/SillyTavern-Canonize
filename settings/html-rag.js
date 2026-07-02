/**
 * @file data/default-user/extensions/canonize/settings/html-rag.js
 * @stamp {"utc":"2026-06-06T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the RAG area of the CNZ settings panel: two collapsible
 * sections — RAG Summarization (AI classification) and RAG Storage & Retrieval
 * (embedding + retrieval). Retrieval controls reflect the distributional cutoff
 * strategy: cutoff mode and per-channel min/max.
 *
 * @api-declaration
 * buildRagSectionHTML(s, escapeHtml) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 *   note: imports SECRET_KEYS (a static constant) from ST core to feature-detect
 *   Voyage AI support; no runtime IO, so purity holds.
 */

import { SECRET_KEYS } from '../../../../../scripts/secrets.js';

// True only on SillyTavern builds that carry the (currently unmerged) Voyage AI
// secret/vector patch — see https://github.com/SillyTavern/SillyTavern/pull/5740.
// Stock ST has no `api_key_voyageai` entry in SECRET_KEYS, so the option must
// stay hidden there or the "Click to set" button silently no-ops.
const VOYAGE_SUPPORTED = Object.values(SECRET_KEYS).includes('api_key_voyageai');

export function buildRagSectionHTML(s, escapeHtml) {
    const tip         = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;
    const embedSource = s.ragEmbeddingSource ?? 'openrouter';

    // Sources that need a dedicated key not accessible from the main ST connections panel.
    const EMBED_KEY_MAP = { voyageai: 'api_key_voyageai', nomicai: 'api_key_nomicai' };
    const embedApiKey   = (embedSource === 'voyageai' && !VOYAGE_SUPPORTED) ? null : (EMBED_KEY_MAP[embedSource] ?? null);

    const embedOptions = [
        ['openrouter',   'OpenRouter'],
        ['openai',       'OpenAI'],
        ['mistral',      'Mistral'],
        ['cohere',       'Cohere'],
        ['nomicai',      'Nomic AI'],
        ['togetherai',   'Together AI'],
        ['electronhub',  'ElectronHub'],
        ['chutes',       'Chutes'],
        ['nanogpt',      'NanoGPT'],
        ['siliconflow',  'SiliconFlow'],
        ['workers_ai',   'Cloudflare Workers AI'],
        ['aistudio',     'Google AI Studio'],
        ['palm',         'Google AI Studio (legacy)'],
        ['vertexai',     'Google Vertex AI'],
        ['ollama',       'Ollama (local URL)'],
        ...(VOYAGE_SUPPORTED ? [['voyageai', 'Voyage AI']] : []),
        ['vllm',         'vLLM (local URL)'],
        ['llamacpp',     'llama.cpp (local URL)'],
        ['transformers', 'Transformers (local)'],
    ].map(([v, l]) => `<option value="${v}" ${embedSource === v ? 'selected' : ''}>${l}</option>`).join('');

    return `
        <div id="cnz-rag-settings-body">

          <!-- RAG Summarization (collapsible) -->
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>RAG Summarization</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">

              <div id="cnz-rag-ai-controls" class="cnz-settings-subgroup">
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
              </div>

            </div>
          </div>

          <!-- RAG Storage & Retrieval (collapsible) -->
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>RAG Storage &amp; Retrieval</b>
              <a href="https://github.com/ZapoVerde/SillyTavern-Canonize/blob/main/docs/rag.md" target="_blank" rel="noopener" class="cnz-docs-link" title="RAG documentation" onclick="event.stopPropagation()">docs</a>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">

              <!-- Retrieval explainer -->
              <div id="cnz-inflection-explainer-trigger" style="cursor:pointer;color:var(--SmartThemeBlurTintColor, #5c85d6);margin-bottom:8px;font-size:0.82rem;display:flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-circle-info"></i>
                <b style="text-decoration:underline">How does memory retrieval work?</b>
              </div>
              <div id="cnz-inflection-explainer-body" class="cnz-hidden" style="margin-bottom:12px;padding:8px 12px;border-left:2px solid var(--SmartThemeBlurTintColor, #5c85d6);background:rgba(255,255,255,0.015);font-size:0.82rem;line-height:1.45;color:var(--cnz-text-muted, #888);">
                Rather than using a fixed threshold, Canonize inspects the shape of your top candidates on every turn. It samples a small pool (Pool Multiple x Max Results), measures how skewed the score distribution is, and dynamically scales the result window up or down. A sharp peak (one standout memory, lots of filler) tightens the window; a dense plateau (many equally-relevant memories) expands it. A second cliff-detection pass can cut even earlier if there is a statistically significant score break. Min and Max are hard boundaries the dynamic window never crosses.
              </div>

              <div class="cnz-settings-inline-row">
                <label for="cnz-set-embedding-source">Embedding Source ${tip('Embedding provider. API keys are read from ST\'s connection settings. URL-based providers (Ollama, vLLM, llama.cpp) use the server URLs already configured in ST\'s API settings.')}</label>
                <select id="cnz-set-embedding-source" class="cnz-select cnz-settings-select-sm">${embedOptions}</select>
              </div>
              <div id="cnz-embed-or-note" class="cnz-settings-note${embedSource === 'openrouter' ? '' : ' cnz-hidden'}">
                OpenRouter pre-filters the model browser to embedding models only.
              </div>
              <div id="cnz-embed-set-key-row" class="cnz-settings-inline-row${embedApiKey ? '' : ' cnz-hidden'}">
                <label class="cnz-label">API Key</label>
                <div id="cnz-embed-set-key-btn"
                     class="menu_button menu_button_icon manage-api-keys"
                     data-key="${embedApiKey ?? ''}">
                  <i class="fa-solid fa-key"></i>
                  <span>Click to set</span>
                </div>
              </div>
              <div id="cnz-rag-remote-embed-rows">
                <div class="cnz-settings-inline-row">
                  <label for="cnz-set-embedding-model">Embedding Model ${tip('Model ID for the selected provider. Click Browse to pick from a live list. OpenRouter: provider/model-name. OpenAI: model name only.')}</label>
                  <div style="display:flex;gap:4px;align-items:center">
                    <input id="cnz-set-embedding-model" type="text" class="cnz-input cnz-settings-input-wide"
                           placeholder="e.g. openai/text-embedding-3-small"
                           value="${escapeHtml(s.ragEmbeddingModel ?? '')}">
                    <button id="cnz-browse-embedding-model" class="cnz-btn cnz-btn-secondary cnz-btn-sm" title="Browse available embedding models">Browse</button>
                  </div>
                </div>
                <select id="cnz-embedding-model-list" class="cnz-select cnz-hidden" style="width:100%;margin-top:4px;font-size:0.8rem"></select>
              </div>
              <div class="cnz-settings-inline-row">
                <label class="cnz-label">Embedding Test ${tip('Sends a short probe sentence through the configured provider and model. Returns the vector dimension and round-trip latency.')}</label>
                <div style="display:flex;gap:8px;align-items:center">
                  <button id="cnz-test-embedding" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Test</button>
                  <span id="cnz-embed-test-result" style="font-size:0.82rem"></span>
                </div>
              </div>

              <div class="cnz-settings-row">
                <label class="cnz-checkbox-label">
                  <input type="checkbox" id="cnz-set-rag-fts-unicode" ${(s.ragFtsUnicode ?? false) ? 'checked' : ''}>
                  <span>Unicode FTS ${tip('FTS keyword matching strips non-ASCII characters by default, optimizing for English. Enable this to preserve Unicode text for non-Latin languages (French, German, Russian, etc.).')}</span>
                </label>
              </div>

              <!-- Retrieval controls -->
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-cutoff-mode">Cutoff Mode ${tip('Score threshold applied to the local candidate pool. Mean keeps everything above the pool average. Higher modes are stricter — useful for noisy databases or when too many marginally-relevant results are leaking through. Skewness is logged for observation but does not affect the cutoff.')}</label>
                <select id="cnz-set-rag-cutoff-mode" class="cnz-select cnz-settings-select-sm">
                  <option value="mean"     ${ (s.ragCutoffMode ?? 'mean') === 'mean'     ? 'selected' : ''}>Mean</option>
                  <option value="mean+1sd" ${ (s.ragCutoffMode ?? 'mean') === 'mean+1sd' ? 'selected' : ''}>Mean + 1 std dev</option>
                  <option value="mean+2sd" ${ (s.ragCutoffMode ?? 'mean') === 'mean+2sd' ? 'selected' : ''}>Mean + 2 std dev</option>
                </select>
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-pool-multiple">Pool Multiple ${tip('Candidate pool size = Pool Multiple x Max Results (minimum 6). Stats are computed on this pool only, not the full database. 2 is a tight competitive set; 3 gives more stable statistics for larger databases.')}</label>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="cnz-set-rag-pool-multiple" type="range" min="1" max="5" step="0.5"
                         value="${escapeHtml(String(s.ragPoolMultiple ?? 2))}" style="flex:1">
                  <span id="cnz-set-rag-pool-multiple-val" style="min-width:2.5em;text-align:right;font-size:0.85rem">${escapeHtml(String(s.ragPoolMultiple ?? 2))}x</span>
                </div>
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-kw-blend">Keyword blend ${tip('How much the keyword (FTS) lane can contribute relative to the top vector score. At 0.7 the strongest keyword match adds at most 30% of the top cosine score to any item. Lower = keyword has more influence; higher = vector dominates. Only affects the chat channel where FTS runs.')}</label>
                <div style="display:flex;align-items:center;gap:8px">
                  <input id="cnz-set-rag-kw-blend" type="range" min="0" max="1" step="0.05"
                         value="${escapeHtml(String(s.ragKwBlend ?? 0.7))}" style="flex:1">
                  <span id="cnz-set-rag-kw-blend-val" style="min-width:3.5em;text-align:right;font-size:0.85rem">${escapeHtml(String(Math.round((s.ragKwBlend ?? 0.7) * 100)))}% vec</span>
                </div>
              </div>
              <div class="cnz-settings-inline-row" style="align-items:baseline;gap:8px;">
                <label style="flex:1">Chat context ${tip('Results from searching the narrative memory store using recent conversation turns as the query.')}</label>
                <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Min</label>
                <input id="cnz-set-rag-chat-min" type="number" min="0" max="20" step="1" style="width:52px" value="${escapeHtml(String(s.ragChatMin ?? 2))}">
                <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Max</label>
                <input id="cnz-set-rag-chat-max" type="number" min="1" max="30" step="1" style="width:52px" value="${escapeHtml(String(s.ragChatMax ?? 8))}">
              </div>
              <div class="cnz-settings-inline-row" style="align-items:baseline;gap:8px;">
                <label style="flex:1">LB context ${tip('Results from searching the lorebook entry store using recent conversation turns as the query. Relevant entries are activated rather than injected as prose.')}</label>
                <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Min</label>
                <input id="cnz-set-rag-lb-min" type="number" min="0" max="20" step="1" style="width:52px" value="${escapeHtml(String(s.ragLbMin ?? 2))}">
                <label style="font-size:0.8rem;color:var(--cnz-text-muted,#888)">Max</label>
                <input id="cnz-set-rag-lb-max" type="number" min="1" max="20" step="1" style="width:52px" value="${escapeHtml(String(s.ragLbMax ?? 4))}">
              </div>
              <div class="cnz-settings-row">
                <label class="cnz-checkbox-label">
                  <input type="checkbox" id="cnz-set-lb-rag-only" ${(s.lbRagOnly ?? false) ? 'checked' : ''}>
                  <span>Bypass WI keyword activation ${tip('Detaches the lorebook from the character so ST\'s keyword scanner never sees it. RAG-matched entries inject directly into a dedicated CNZ World Info prompt slot. Toggle off to re-attach and use the WI pipeline with Structurize formatting.')}</span>
                </label>
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
                <label for="cnz-set-rag-separator">Sync Separator ${tip('Separator used between chunks in classifier documents during sync.')}</label>
                <input id="cnz-set-rag-separator" type="text" class="cnz-input cnz-settings-input-wide"
                       placeholder="e.g. %%%" value="${escapeHtml(s.ragSeparator ?? '%%%')}">
              </div>

              <div class="cnz-settings-section-label" style="margin-top:12px">
                Additional Lorebooks ${tip('Read-only reference lorebooks (e.g. world encyclopaedias, spell books) queried every generation alongside the character lorebook. Each entry is vectorised and retrieved semantically. The list is saved in the chat anchor, so it restores automatically on branch rollback.')}
              </div>
              <div id="cnz-additional-lb-list"></div>
              <div id="cnz-additional-lb-add-row" style="display:none;margin-top:6px;gap:6px;align-items:center" class="cnz-settings-inline-row">
                <select id="cnz-additional-lb-select" class="cnz-select" style="flex:1"></select>
                <button id="cnz-additional-lb-confirm" class="cnz-btn cnz-btn-primary cnz-btn-sm">Add</button>
                <button id="cnz-additional-lb-cancel"  class="cnz-btn cnz-btn-secondary cnz-btn-sm">Cancel</button>
              </div>
              <button id="cnz-additional-lb-open-add" class="cnz-btn cnz-btn-secondary cnz-btn-sm" style="margin-top:6px">+ Add Lorebook</button>

            </div>
          </div>

        </div>`;
}