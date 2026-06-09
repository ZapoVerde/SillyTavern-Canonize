# Canonize

**Your AI forgets. Canonize remembers.**

Long roleplay chats break in three ways: costs balloon because every message sends the full history, the AI starts ignoring your character card because its attention is diluted by thousands of raw turns, and it forgets or hallucinates things that happened 200 messages ago.

Canonize fixes all three by replacing full-history prompting with a retrieval memory system — archiving past turns into a searchable database and injecting only what is relevant to the current scene, while keeping a short live window in context at any time.

---

## Why It's Different

Most memory systems compress old conversations into summaries and throw the original detail away.

Canonize doesn't.

Every archived conversation remains searchable. Instead of forcing the AI to carry thousands of turns in context, Canonize stores them in a retrieval database and injects only the pieces that are relevant to the current scene.

A conversation from 2,000 turns ago can still be recalled accurately if it matters right now.

Nothing is lost. It simply leaves active context until it becomes relevant again.

---

## The Memory Architecture

| | |
|---|---|
| **Live Context** | The most recent conversation turns, sent to the model unchanged. |
| **Bridge Summary** | A rolling narrative that keeps the model aware of the current situation, character motivations, and active plot threads. Bridges the retrieval memory into the live context. |
| **Retrieval Memory** | Three search lanes run on every turn, injecting only what is relevant to the current scene: archived conversation (chat lane), world knowledge and characters (general lane), and active story arcs (plot lane). The lorebooks are the source for the general and plot lanes. |

These work together to maintain long-term continuity while keeping the active prompt small and focused.

A timeline tracker continuously monitors the conversation. If you swipe, edit, delete, or roll back messages, Canonize automatically restores the matching summary, lorebook state, and retrieval index, preventing abandoned story branches from contaminating your current timeline.

---

## Key Features

- Recall important events from thousands of turns ago without carrying the entire chat in context.
- Track characters, world knowledge, and active plot threads with three specialist curators.
- Keep the AI focused with a continuously updated narrative summary.
- Retrieve relevant memories and lore on demand with hybrid semantic and keyword search.
- Survive swipes, edits, and timeline rewinds without corrupting memory state.
- Review and approve every summary, lorebook change, and archived memory before it is committed.

---

## Installation

**Prerequisite (cloud embedding providers only):** Set `allowKeysExposure: true` in `config.yaml` and restart SillyTavern. Not required for local embedding providers (Ollama, llama.cpp, vllm).

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
