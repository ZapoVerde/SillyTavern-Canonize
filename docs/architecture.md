# Architecture: How Canonize Works

## The Problem

Standard long-context roleplay has three failure modes:

1. **Cost blowout.** Every message sends the entire chat history. A 1,000-turn chat means paying for 1,000 turns of tokens on every single reply.
2. **Attention dilution.** LLMs suffer from "Lost in the Middle" when forced to read massive raw logs, they start ignoring system prompts, drop character card instructions, and fall into repetitive prose.
3. **Stale or missing memories.** The AI either forgets things from 200 turns ago, or hallucinates them because it is pattern-matching on noise rather than fact.

## Memory & Retrieval Architecture

At each generation turn, three things are assembled into the prompt:

### Live Context
The most recent conversation turns, sent directly to the model. Not a memory system, just the active window.

### Bridge Summary
A rolling narrative that keeps the model aligned with the current story state. Bridges the retrieval memory into the live context.

### Retrieval Memory
The actual memory system. Three search lanes run in parallel and inject only their most relevant matches:

- **Chat Lane** — archived conversation chunks, summarised and indexed
- **General Lane** — world knowledge lorebook (characters, places, objects, concepts)
- **Plot Lane** — plot lorebook (active story arcs and unresolved narrative threads)

The lorebooks are the source material for the general and plot lanes. All three lanes feed into the retrieval memory system.

## The Conversation Windows

Canonize divides the conversation into four sequential regions:

```
│←── archival ───│←── bridge horizon (default 40 pairs) ───│←── sync window (0→8 pairs) ──→│←── live context (8 pairs) ──→│
oldest                                                                                                                       newest
```

**Live context** (default: 8 pairs) — The most recent turns sent to the model as raw dialogue. Maintains scene continuity and gives you room to revise before the sync window closes.

**Sync window** (default: 8 pairs) — Accumulates from zero after each sync. When it reaches the target, the sync pipeline fires, a new sync point is written, and the counter resets. Keep this a multiple of Chunk Size so chunks are not split across sync boundaries.

**Bridge horizon** (default: 40 pairs) — The window the AI reads when regenerating the bridge summary and updating the plot lorebook at sync time.

**Archival** — Everything beyond the bridge horizon. Accessible only through the RAG retrieval system.

## The Sync Pipeline

When the sync window fills:

1. The accumulated turns are sliced into **chunks** — fixed-size blocks of turn-pairs (default: 2 pairs each) that become the searchable units in the archive.
2. Each chunk is classified by an AI call that generates a summary of what happened in that block.
3. The lorebook curators run — **General** (places, things, concepts) and **People** (characters, relationships, goals) — and suggest updates.
4. The bridge summary is regenerated across the full bridge horizon.
5. All new chunks and lorebook entries are embedded as vectors.
6. Changes are presented in the Review Wizard. You can approve, edit, or let the sync commit in the background.

Each completed sync writes a **sync marker** into the chat file — a hidden snapshot of the lorebook state and summary at that point. Markers are never sent to the model.

## Timeline Integrity

If you swipe, delete messages, roll back, or branch the story, Canonize detects the divergence, identifies the last valid marker on your current branch, and restores the lorebook, summary, and retrieval index to match. Your AI's memory always reflects the timeline you are actually on.

## Hybrid RAG Retrieval

The RAG retrieval pipeline runs on every generation turn:

1. **Vector search** — embeds the recent conversation and scores all stored chunks by cosine similarity across two lanes (content body + chunk summary).
2. **Temporal decay** — chat chunks are gently down-weighted by age so recent events rank slightly higher than older ones at the same similarity level. A floor prevents old-but-relevant content from being buried entirely. Applies to the chat lane only.
3. **Keyword search** — TF-IDF: scores each chunk based on how well its specific terms match the query; common words that appear everywhere count for little, distinctive or rare words count for more.
4. **Micro-pool threshold** — normalises results to a pool of P × Max candidates, giving the scoring a consistent reference group from which to separate signal from noise. Min, Max, and cutoff mode are the knobs that shape this: Min sets the floor on what is always returned, Max sets the ceiling, and cutoff mode controls how aggressively the threshold separates signal from noise within the pool.
5. **Score combination** — the final score for each chunk draws from all three lanes. Chunks that matched strongly across both vector lanes (content body and chunk summary) receive a confidence bonus; keyword score is added proportionally on top.

See [RAG_strategy_v4.md](RAG_strategy_v4.md) for full technical detail.
