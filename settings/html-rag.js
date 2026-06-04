/**
 * @file data/default-user/extensions/canonize/settings/html-rag.js
 * @stamp {"utc":"2026-06-04T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the RAG area of the CNZ settings panel: two collapsible
 * sections — RAG Summarization (AI classification) and RAG Storage & Retrieval
 * (embedding + retrieval). Retrieval controls reflect the distributional cutoff
 * strategy: signal strength (global) and per-channel min/max.
 *
 * @api-declaration
 * buildRagSectionHTML(s, escapeHtml) → string
 *
 * @contract
 *   assertions: { purity: pure, state_ownership: [], external_io: [] }
 */

export function buildRagSectionHTML(s, escapeHtml) {
    const tip           = (text) => `<span class="cnz-info-icon" title="${escapeHtml(text)}">&#9432;</span>`;
    const ragContents   = s.ragContents         ?? 'summary+full';
    const hasSummary    = ragContents !== 'full';
    const embedSource   = s.ragEmbeddingSource  ?? 'openrouter';

    // Sources that need a dedicated key not accessible from the main ST connections panel.
    const EMBED_KEY_MAP = { voyageai: 'api_key_voyageai', nomicai: 'api_key_nomicai' };
    const embedApiKey   = EMBED_KEY_MAP[embedSource] ?? null;

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
        ['voyageai',     'Voyage AI'],
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

              <div class="cnz-settings-inline-row" id="cnz-rag-contents-row">
                <label for="cnz-set-rag-contents">RAG Contents ${tip('"Summary + Full Content": AI-generated header plus raw dialogue. "Summary Only": compact header list. "Full Content Only": raw dialogue.')}</label>
                <select id="cnz-set-rag-contents" class="cnz-select cnz-settings-select-sm">
                  <option value="summary+full" ${ragContents === 'summary+full' ? 'selected' : ''}>Summary + Full Content</option>
                  <option value="summary"      ${ragContents === 'summary'      ? 'selected' : ''}>Summary Only</option>
                  <option value="full"         ${ragContents === 'full'         ? 'selected' : ''}>Full Content Only</option>
                </select>
              </div>
              <div id="cnz-rag-ai-controls" class="cnz-settings-subgroup ${hasSummary ? '' : 'cnz-disabled'}">
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
              </div>

            </div>
          </div>

          <!-- RAG Storage & Retrieval (collapsible) -->
          <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>RAG Storage &amp; Retrieval</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
            </div>
            <div class="inline-drawer-content">

              <!-- Retrieval explainer -->
              <div id="cnz-inflection-explainer-trigger" style="cursor:pointer;color:var(--SmartThemeBlurTintColor, #5c85d6);margin-bottom:8px;font-size:0.82rem;display:flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-circle-info"></i>
                <b style="text-decoration:underline">How does memory retrieval work?</b>
              </div>
              <div id="cnz-inflection-explainer-body" class="cnz-hidden" style="margin-bottom:12px;padding:8px 12px;border-left:2px solid var(--SmartThemeBlurTintColor, #5c85d6);background:rgba(255,255,255,0.015);font-size:0.82rem;line-height:1.45;color:var(--cnz-text-muted, #888);">
                Rather than using a fixed number of results or an absolute quality threshold, Canonize evaluates the score distribution returned by each search. It first checks whether the results have meaningful spread — if everything scores similarly, there is no real signal and only the minimum is returned. When spread exists, it takes everything above the distribution mean and clamps to your configured min and max. This makes retrieval adapt automatically to the query and the state of the database, without manual tuning as your story grows.
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

              <!-- Retrieval controls -->
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-signal-strength">Signal Strength ${tip('Minimum score spread required before the distribution is trusted. If max and min scores are too close together, there is no meaningful signal and only the minimum results are returned. Lower = more permissive. Higher = stricter.')}</label>
                <input id="cnz-set-rag-signal-strength" type="number" min="0" max="1" step="0.01" value="${escapeHtml(String(s.ragSignalStrength ?? 0.35))}">
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
                  <span>Bypass WI keyword activation ${tip('When on, CNZ strips keyword triggers from its managed lorebook entries so ST\'s scanner never fires them. Only RAG decides which entries inject — they still land in World Info (before) via force-activation. Apply to existing entries below; future syncs respect this automatically.')}</span>
                </label>
              </div>
              <div class="cnz-setting-row">
                <button id="cnz-lb-rag-only-apply" class="cnz-btn cnz-btn-secondary cnz-btn-sm">Apply to existing entries</button>
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

            </div>
          </div>

        </div>`;
}