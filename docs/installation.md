# Installation

## Prerequisites

**Cloud embedding providers only:** If you are using a cloud embedding provider (OpenAI, OpenRouter, Voyage AI, etc.), open `config.yaml` in your SillyTavern data directory and set `allowKeysExposure: true`, then restart SillyTavern. If you are using a local provider (Ollama, llama.cpp, vllm), skip this step.

This setting is required because Canonize calls the embedding API directly from your browser rather than through SillyTavern's built-in vector proxy. The direct call is necessary to receive similarity scores, which Canonize uses to filter results by relevance. SillyTavern's proxy returns only ranked results without scores, so it cannot be used here. There is an open PR ([#5741](https://github.com/SillyTavern/SillyTavern/pull/5741)) to expose scores through the proxy; once that ships, this requirement will be removed. The key is read from SillyTavern's own secret store at call time and is used solely for embedding requests — your LLM API key is never touched.

## Steps

1. **Open Extensions Menu:** Click the Extensions icon (puzzle piece) in your SillyTavern interface and select the option to install an extension from a URL.
2. **Provide the Link:** Paste the repository URL into the input field and click Install.
3. **Refresh Your Browser:** After installation, reload the page. A new book-shaped sync icon will appear in your chat toolbar and a new configuration panel will appear in the Extensions drawer.

## First-Time Setup

1. Open the Canonize settings panel in the Extensions drawer.
2. Under **Narrative Memory**, set your **Embedding Source** and **Embedding Model**. Voyage AI `voyage-4-large` or OpenAI `text-embedding-3-large` are good defaults.
3. If using a cloud provider, confirm your API key is stored in SillyTavern's API Connections panel under the matching provider.
4. Open a chat with a character. The sync icon in the toolbar will activate once a conversation is in progress.
