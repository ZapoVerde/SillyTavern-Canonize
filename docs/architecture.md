# Architecture: How Canonize Works

## The Problem

Standard long-context roleplay has three failure modes:

1. **Cost blowout.** Every message sends the entire chat history. A 2,000-turn chat means paying for 2,000 turns of tokens on every single reply.
2. **Attention dilution.** LLMs suffer from "Lost in the Middle" — when forced to read massive raw logs, they start ignoring system prompts, drop character card instructions, and fall into repetitive prose.
3. **Stale or missing memories.** The AI either forgets things from 200 turns ago, or hallucinates them because it is pattern-matching on noise rather than fact.

## Memory & Retrieval Architecture

Canonize operates with four inputs into the model:

### 1. Live Context
The most recent conversation turns, sent directly to the model.

### 2. Summary Stream
A rolling narrative that keeps the model aligned with the current story state, bridging the retrieval system with the live context.

### 3. Retrieval System (Three Lanes)

Canonize retrieves additional context using three parallel lanes:

- **Chat Lane** — relevant past conversation fragments
- **General Lane** — world knowledge (characters, places, objects)
- **Plot Lane** — active story arcs and unresolved narrative threads

Each lane runs independently and injects only its most relevant matches.

### 4. Context Assembly
All selected outputs are merged into a single prompt window for generation.

## The Clockwork Chain

To coordinate all four tiers without manual effort, Canonize places invisible sync markers inside your chat messages. Each marker is a complete snapshot of your lorebook state and narrative summary at that exact moment in time.

When you swipe, delete messages, or edit past turns, Canonize detects the divergence, identifies the last valid marker, and rolls back all four tiers to match. Your AI's memory always reflects your *current* timeline, not an abandoned branch.

## The Sync Pipeline

When enough new turns have accumulated (default: every 20 pairs), Canonize runs a background sync:

1. Reads the new conversation block since the last marker.
2. Updates the rolling **Summary**.
3. Runs two lorebook lanes — the **General Curator** (places, things, concepts) and the **People Curator** (characters, relationships, goals).
4. Classifies and indexes new conversation chunks into the **RAG store**.
5. Embeds all new chunks and lorebook entries.
6. Presents everything in the **Review Wizard** for your approval before writing.

Nothing is written permanently until you confirm.

## Hybrid RAG Retrieval

The RAG retrieval pipeline (v4) runs on every generation turn:

1. **Vector search** — embeds the recent conversation and scores all stored chunks by cosine similarity across two lanes (content body + header summary).
2. **Keyword search** — runs a TF-IDF full-text search over the same corpus, preserving raw scores.
3. **RRF fusion** — merges the two lanes per item; items matching both lanes receive a confidence bonus.
4. **Keyword blend** — normalises TF-IDF scores so the top keyword match contributes at most `(1 - α) × maxVectorScore`. Default α=0.7.
5. **Micro-pool threshold** — computes mean/σ/skewness on only the top `P × Max` candidates (not the full database), then cuts at the mean (or mean+σ, mean+2σ). Returns everything above the threshold, clamped to [Min, Max].

See [RAG_strategy_v4.md](RAG_strategy_v4.md) for full technical detail.
