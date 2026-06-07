# Canonize

**Your AI forgets. Canonize remembers.**

Long roleplay chats break in three ways: costs balloon because every message sends the full history, the AI starts ignoring your character card because its attention is diluted by thousands of raw turns, and it forgets — or hallucinates — things that happened 200 messages ago.

Canonize fixes all three by replacing full-history prompting with a structured four-tier memory system, keeping only a short live window in context at any time.

---

## Why It's Different

Most memory systems compress old conversations into summaries and throw the original detail away.

Canonize doesn't.

Every archived conversation remains searchable. Instead of forcing the AI to carry thousands of turns in context, Canonize stores them in a retrieval database and injects only the pieces that are relevant to the current scene.

A conversation from 2,000 turns ago can still be recalled accurately if it matters right now.

Nothing is lost. It simply leaves active context until it becomes relevant again.

---

## The Memory Architecture

| Layer | Purpose |
|---|---|
| **Context Window** | The most recent conversation turns, sent to the model unchanged. |
| **Summary** | A rolling narrative that keeps the model aware of the current situation, character motivations, and active plot threads. This acts like a bridge into the context window. |
| **Lorebook** | Durable world knowledge maintained automatically, including characters, places, relationships, and concepts. |
| **RAG** | Archived conversations retrieved on demand when they become relevant to the current scene. |

These layers work together to maintain long-term continuity while keeping the active prompt small and focused.

A chronology tracker continuously monitors the conversation timeline. If you swipe, edit, delete, or roll back messages, Canonize automatically restores the matching summary, lorebook state, and archived memory, preventing abandoned story branches from contaminating your current timeline.

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

- [Architecture](docs/architecture.md) — How the four tiers work together
- [Installation](docs/installation.md) — Prerequisites and setup
- [Settings Reference](docs/settings.md) — Every knob explained
- [People Curator](docs/people-curator.md) — Character tracking and relationship management
- [Narrative Memory (RAG)](docs/rag.md) — Retrieval pipeline, tuning, and diagnostics
- [Review Wizard](docs/review-wizard.md) — Step-by-step guide to the approval workflow
