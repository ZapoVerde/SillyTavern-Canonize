# Architecture: How Canonize Works

## The Problem

Standard long-context roleplay has three failure modes:

1. **Cost blowout.** Every message sends the entire chat history. A 2,000-turn chat means paying for 2,000 turns of tokens on every single reply.
2. **Attention dilution.** LLMs suffer from "Lost in the Middle" — when forced to read massive raw logs, they start ignoring system prompts, drop character card instructions, and fall into repetitive prose.
3. **Stale or missing memories.** The AI either forgets things from 200 turns ago, or hallucinates them because it is pattern-matching on noise rather than fact.

## Memory & Retrieval Architecture

At each generation turn, three things are assembled into the prompt:

### Live Context
The most recent conversation turns, sent directly to the model. Not a memory system — just the active window.

### Bridge Summary
A rolling narrative that keeps the model aligned with the current story state. Bridges the retrieval memory into the live context.

### Retrieval Memory
The actual memory system. Three search lanes run in parallel and inject only their most relevant matches:

- **Chat Lane** — archived conversation chunks, summarised and indexed
- **General Lane** — world knowledge lorebook (characters, places, objects, concepts)
- **Plot Lane** — plot lorebook (active story arcs and unresolved narrative threads)

The lorebooks are the source material for the general and plot lanes. All three lanes feed into the retrieval memory system.

## Timeline Integrity

Canonize writes sync markers into your chat file alongside certain messages. Each marker is a complete snapshot of your lorebook state and narrative summary at that point in the timeline. They are stored in message metadata and are never sent to the model.

When you swipe, delete messages, or edit past turns, Canonize detects the divergence, identifies the last valid marker, and rolls back the summary, lorebook state, and retrieval index to match. Your AI's memory always reflects your *current* timeline, not an abandoned branch.

## The Sync Pipeline

When enough new turns have accumulated (default: every 10 pairs), Canonize runs a background sync:

1. Reads the new conversation block since the last marker.
2. Updates the rolling **Summary**.
3. Runs two lorebook lanes — the **General Curator** (places, things, concepts) and the **People Curator** (characters, relationships, goals).
4. Classifies and indexes new conversation chunks into the **RAG store**.
5. Embeds all new chunks and lorebook entries.
6. Presents everything in the **Review Wizard** for your approval before writing.

Nothing is written permanently until you confirm.

## Hybrid RAG Retrieval

The RAG retrieval pipeline runs on every generation turn:

1. **Vector search** — embeds the recent conversation and scores all stored chunks by cosine similarity across two lanes (content body + chunk summary).
2. **Temporal decay** — chat chunks are gently down-weighted by age so recent events rank slightly higher than older ones at the same similarity level. A floor prevents old-but-relevant content from being buried entirely. Applies to the chat lane only.
3. **Keyword search** — TF-IDF: scores each chunk based on how well its specific terms match the query; common words that appear everywhere count for little, distinctive or rare words count for more.
4. **Micro-pool threshold** — normalises results to a pool of P × Max candidates, giving the scoring a consistent reference group from which to separate signal from noise. Min, Max, and cutoff mode are the knobs that shape this: Min sets the floor on what is always returned, Max sets the ceiling, and cutoff mode controls how aggressively the threshold separates signal from noise within the pool.
5. **Score combination** — the final score for each chunk draws from all three lanes. Chunks that matched strongly across both vector lanes (content body and chunk summary) receive a confidence bonus; keyword score is added proportionally on top.

See [RAG_strategy_v4.md](RAG_strategy_v4.md) for full technical detail.
