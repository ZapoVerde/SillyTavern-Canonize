# Architecture: How Canonize Works

## The Problem

Standard long-context roleplay has three failure modes:

1. **Cost blowout.** Every message sends the entire chat history. A 2,000-turn chat means paying for 2,000 turns of tokens on every single reply.
2. **Attention dilution.** LLMs suffer from "Lost in the Middle" — when forced to read massive raw logs, they start ignoring system prompts, drop character card instructions, and fall into repetitive prose.
3. **Stale or missing memories.** The AI either forgets things from 200 turns ago, or hallucinates them because it is pattern-matching on noise rather than fact.

## The Four-Tier Memory Model

Canonize replaces the raw chat log with four structured layers. On every turn, the AI's context window is populated from these tiers rather than from raw history.

### 1. Clockwork (The Active Window)

The live, uncompressed last N turn-pairs sent as-is. Keeping this short (default 5 pairs) keeps token costs predictable and puts your instructions in the high-attention zone at the top of context.

### 2. Summary (Situational Awareness)

A structured rolling narrative updated periodically in the background. It tracks where characters are physically and emotionally, what they intend to do, and what plot threads are unresolved. The AI always knows *what is happening right now* without reading the raw dialogue that produced it.

### 3. Lorebook (Durable Knowledge)

Static, referenceable facts about the world — character descriptions, locations, items, factions — stored in standard SillyTavern lorebooks and injected only when relevant. Canonize writes and maintains these entries automatically via its sync pipeline.

### 4. RAG (Associative Recall)

Older conversations are sliced into chunks, summarized, and indexed in a searchable vector database. On each turn, Canonize runs a hybrid search (semantic similarity + keyword) against this database and injects the most relevant past moments directly into context — even if they happened thousands of turns ago.

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
