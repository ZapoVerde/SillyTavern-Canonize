# Canonize
**[Released]**

**Long chats make AI worse. Canonize makes them better.**

Canonize classifies your conversation as it unfolds and stores it in a searchable vault. Once archived, those turns are removed from the context sent to the AI. When something comes up 200 turns later, only the most relevant pieces are pulled back into context.

It builds and maintains a lorebook of plot, people, places, things, and concepts to keep every response grounded in the story you've actually written.

**Canonize follows you automatically between chats.** Whether you switch to a different story, branch a timeline, roll back a decision, or start fresh, it restores the exact state of that chat at whatever point you left it. No reconfiguration required.

---

## What You Get

**Cheaper runs.** Archived turns leave the context window. Every turn costs less because the AI isn't processing hundreds to thousands of messages it doesn't need.

**Better instruction adherence.** Less context means less dilution. Character cards and system prompts land harder when they aren't buried under raw history.

**Faster generations.** Less context to process means faster output, turn after turn.

**A lorebook that maintains itself.** Canonize automatically creates and updates entries for characters, locations, concepts, and plot threads as the story develops, so the AI always has an accurate, current picture of your world without you managing it manually.

---

## Installation

**Prerequisite (cloud embedding providers only):** Set `allowKeysExposure: true` in `config.yaml` and restart SillyTavern. Not required for local embedding providers (Ollama, llama.cpp, vllm).

**Voyage AI does not currently work on stock SillyTavern.** It requires core SillyTavern support (the `api_key_voyageai` secret and vector routing) that is not yet in the upstream codebase — see [#5740](https://github.com/SillyTavern/SillyTavern/pull/5740), open and awaiting review. Until that merges, use a different embedding source (OpenAI, OpenRouter, Cohere, etc.).

1. Open the Extensions menu (puzzle piece icon) and install from URL.
2. Paste this repository's URL (https://github.com/ZapoVerde/SillyTavern-Canonize) and click Install.
3. Reload the page.
4. Open the Canonize settings panel, set your **Embedding Source** and **Embedding Model**, and you're ready.

See [docs/installation.md](docs/installation.md) for full setup detail.

---


## Documentation

- [Architecture](docs/architecture.md) — System design and retrieval pipeline
- [Installation](docs/installation.md) — Prerequisites and setup
- [Settings Reference](docs/settings.md) — Every knob explained
- [Lorebook](docs/lorebook.md) — Lorebook architecture, curator lanes, and entry structure
- [Narrative Memory (RAG)](docs/rag.md) — Retrieval pipeline, tuning, and diagnostics
- [Review Wizard](docs/review-wizard.md) — Step-by-step guide to the approval workflow
