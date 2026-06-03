/**
 * @file data/default-user/extensions/canonize/settings/html-rag.js
 * @stamp {"utc":"2026-06-03T21:18:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the RAG area of the CNZ settings panel: two collapsible
 * sections — RAG Summarization (AI classification) and RAG Storage & Retrieval
 * (embedding + injection). Adaptive Inflection controls are exposed here.
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

              <!-- Interactive Adaptive Retrieval Explainer -->
              <div id="cnz-inflection-explainer-trigger" style="cursor:pointer;color:var(--SmartThemeBlurTintColor, #5c85d6);margin-bottom:8px;font-size:0.82rem;display:flex;align-items:center;gap:6px;">
                <i class="fa-solid fa-circle-info"></i>
                <b style="text-decoration:underline">How does adaptive memory retrieval work?</b>
              </div>
              <div id="cnz-inflection-explainer-body" class="cnz-hidden" style="margin-bottom:12px;padding:8px 12px;border-left:2px solid var(--SmartThemeBlurTintColor, #5c85d6);background:rgba(255,255,255,0.015);font-size:0.82rem;line-height:1.45;color:var(--cnz-text-muted, #888);">
                Instead of forcing a fixed number of past memories into your chat on every turn, Canonize analyzes the signal-to-noise ratio of your search results in real time. It retrieves a wide pool of candidate memories, measures the rate of quality decline (to find a score cliff), and checks if different search paths (vector vs. keyword) still agree. Based on this, it dynamically isolates and injects only the highest-relevance memories, cutting off the noise before it bloats your active context window.
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

              <!-- Unified Adaptive Inflection Controls -->
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-score-threshold">Absolute Quality Floor ${tip('Minimum cosine similarity (0–1) for a memory to be injected. Any candidate scoring below this is immediately discarded.')}</label>
                <input id="cnz-set-rag-score-threshold" type="number" min="0" max="1" step="0.05" value="${escapeHtml(String(s.ragScoreThreshold ?? 0.25))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-max-results">Memory Ceiling (Max Chunks) ${tip('The hard limit on the total number of memories that can be injected on a single turn. This acts as a safety shield to protect your active context budget.')}</label>
                <input id="cnz-set-rag-max-results" type="number" min="1" max="20" step="1" value="${escapeHtml(String(s.ragInflectionMaxResults ?? 7))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-retrieval-topk">Base Search Pool — chat context ${tip('The baseline candidate count retrieved from the vector database using recent chat messages as the query. This pool gets multiplied under the hood to perform distribution analysis.')}</label>
                <input id="cnz-set-rag-retrieval-topk" type="number" min="0" max="20" step="1" value="${escapeHtml(String(s.ragRetrievalTopK ?? 5))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-lb-retrieval-topk">Base Search Pool — lorebook context ${tip('The baseline candidate count retrieved from the vector database using active lorebook entries as the query.')}</label>
                <input id="cnz-set-rag-lb-retrieval-topk" type="number" min="0" max="20" step="1" value="${escapeHtml(String(s.ragLbRetrievalTopK ?? 3))}">
              </div>
              <div class="cnz-settings-row">
                <label class="cnz-checkbox-label">
                  <input id="cnz-set-inflection-verbose" type="checkbox" ${s.ragInflectionVerbose ? 'checked' : ''}>
                  <span>Verbose Inflection Logs ${tip('Outputs detailed mathematical calculations (including score gaps and path consensus data) directly to the browser console on every turn.')}</span>
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

            </div>
          </div>

        </div>`;
}