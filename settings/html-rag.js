/**
 * @file data/default-user/extensions/canonize/settings/html-rag.js
 * @stamp {"utc":"2026-05-25T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Builds the HTML for the RAG area of the CNZ settings panel: an exposed
 * enable toggle followed by two collapsible sections — RAG Summarization
 * (AI classification) and RAG Storage & Retrieval (embedding + injection).
 * Both collapsibles share a wrapper div that carries the disabled state.
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
    const ragSumSrc     = s.ragSummarySource    ?? 'defined';
    const enableRag     = s.enableRag           ?? false;
    const hasSummary    = ragContents !== 'full';
    const isDefinedHere = ragSumSrc === 'defined';
    const embedSource   = s.ragEmbeddingSource  ?? 'openrouter';

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
        ['palm',         'Google AI Studio (PaLM)'],
        ['vertexai',     'Google Vertex AI'],
        ['ollama',       'Ollama (local URL)'],
        ['vllm',         'vLLM (local URL)'],
        ['llamacpp',     'llama.cpp (local URL)'],
        ['transformers', 'Transformers (local)'],
    ].map(([v, l]) => `<option value="${v}" ${embedSource === v ? 'selected' : ''}>${l}</option>`).join('');

    return `
        <!-- ── RAG enable toggle (always visible) ── -->
        <div class="cnz-settings-row">
          <label class="cnz-checkbox-label">
            <input id="cnz-set-enable-rag" type="checkbox" ${enableRag ? 'checked' : ''}>
            <span>Enable Narrative Memory (RAG) ${tip('When enabled, each sync classifies memory chunks and indexes them in the CNZ SQLite vector DB for semantic retrieval at generation time.')}</span>
          </label>
        </div>

        <!-- ── Shared wrapper — carries cnz-disabled when RAG is off ── -->
        <div id="cnz-rag-settings-body" class="${enableRag ? '' : 'cnz-disabled'}">

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
              <div id="cnz-rag-summary-source-row" class="cnz-settings-inline-row ${hasSummary ? '' : 'cnz-hidden'}">
                <label for="cnz-set-rag-summary-source">Summary Source ${tip('"Defined Here": AI classifier prompt generates semantic headers per chunk. "Qvink": reads headers from qvink_memory metadata.')}</label>
                <select id="cnz-set-rag-summary-source" class="cnz-select cnz-settings-select-sm">
                  <option value="defined" ${isDefinedHere  ? 'selected' : ''}>Defined Here</option>
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

              <div class="cnz-settings-inline-row">
                <label for="cnz-set-embedding-source">Embedding Source ${tip('Embedding provider. API keys are read from ST\'s connection settings. URL-based providers (Ollama, vLLM, llama.cpp) use the server URLs already configured in ST\'s API settings.')}</label>
                <select id="cnz-set-embedding-source" class="cnz-select cnz-settings-select-sm">${embedOptions}</select>
              </div>
              <div id="cnz-embed-or-note" class="cnz-settings-note${embedSource === 'openrouter' ? '' : ' cnz-hidden'}">
                OpenRouter pre-filters the model browser to embedding models only.
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
                <label for="cnz-set-rag-score-threshold">Score Threshold ${tip('Minimum cosine similarity (0–1) for a chunk to be injected.')}</label>
                <input id="cnz-set-rag-score-threshold" type="number" min="0" max="1" step="0.05" value="${escapeHtml(String(s.ragScoreThreshold ?? 0.25))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-retrieval-topk">Chunks — chat context ${tip('How many chunks to retrieve using recent chat messages as the query.')}</label>
                <input id="cnz-set-rag-retrieval-topk" type="number" min="0" max="20" step="1" value="${escapeHtml(String(s.ragRetrievalTopK ?? 5))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-lb-retrieval-topk">Chunks — lorebook context ${tip('How many chunks to retrieve using the currently active lorebook entries as the query.')}</label>
                <input id="cnz-set-rag-lb-retrieval-topk" type="number" min="0" max="20" step="1" value="${escapeHtml(String(s.ragLbRetrievalTopK ?? 3))}">
              </div>
              <div class="cnz-settings-inline-row">
                <label for="cnz-set-rag-plot-retrieval-topk">Chunks — plot context ${tip('How many plot lorebook entries to surface via RAG each turn.')}</label>
                <input id="cnz-set-rag-plot-retrieval-topk" type="number" min="0" max="20" step="1" value="${escapeHtml(String(s.ragPlotRetrievalTopK ?? 3))}">
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
