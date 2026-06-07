# Canonize

**Your AI forgets. Canonize remembers.**

Long roleplay chats break in three ways: costs balloon because every message sends the full history, the AI starts ignoring your character card because its attention is diluted by thousands of raw turns, and it forgets — or hallucinates — things that happened 200 messages ago.

Canonize fixes all three by replacing the raw chat log with a structured four-tier memory system, keeping only a short live window in context at any time.

---

## Why It's Different

Most memory extensions summarize and forget. Canonize archives everything into a searchable database and retrieves it *on demand*, meaning the AI can accurately recall a conversation from 2,000 turns ago as long as the current message is relevant to it. Nothing is lost — it's just not in context unless it's needed.

It also never writes to your world-state without your approval. Every sync presents a Review Wizard where you can read, edit, and approve or reject every proposed change before it is committed.

---

## The Four-Tier Architecture

| Tier | What it is |
|---|---|
| **Clockwork** | The live uncompressed window — your last N turn-pairs sent as-is |
| **Summary** | A structured rolling narrative updated in the background — what is happening right now |
| **Lorebook** | Durable world facts (characters, places, things) written and maintained automatically |
| **RAG** | Archived conversation chunks retrieved by hybrid semantic + keyword search on every turn |

A chain of invisible sync markers keeps all four tiers in sync with your current timeline. Swipe, delete, or edit past messages and Canonize rolls everything back to match.

---

## Key Features

- Continuous rolling narrative summary updated every N turns
- Dual-lane lorebook sync — General Curator (places, things, concepts) + People Curator (characters, relationships, goals)
- Hybrid RAG retrieval — vector cosine + TF-IDF keyword fusion with proportional score blending
- Micro-pool mean threshold — computes statistics on the top candidates only, not the full database
- Timeline recovery — automatic rollback when you edit or swipe past messages
- Review Wizard — approve every summary, lorebook, and RAG change before it is written
- Multiple setting profiles for different models or scenarios
- Per-turn retrieval telemetry in `cnz_rag_health.csv`

---

## Installation

**Prerequisite (cloud embedding providers only):** Set `allowKeysExposure: true` in `config.yaml` and restart SillyTavern. Not required for local providers (Ollama, llama.cpp, vllm).

1. Open the Extensions menu (puzzle piece icon) and install from URL.
2. Paste this repository's URL and click Install.
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
