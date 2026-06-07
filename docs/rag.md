# Narrative Memory (RAG)

Canonize's RAG system archives older conversation blocks into a searchable vector database and retrieves the most relevant past moments on every generation turn. This gives the AI accurate recall of events from hundreds or thousands of turns ago without sending them in the raw context window.

## How It Works

### Storage

Every sync cycle, new conversation blocks are:

1. Sliced into chunks (default 2 turn-pairs each, with optional overlap).
2. Classified by an AI call — each chunk gets a short summary header describing what happened.
3. Embedded as vectors using your configured embedding provider (content body and header summary are embedded separately for two-lane retrieval).
4. Written to a per-chat cache file alongside the lorebook entry vectors.

### Retrieval

On every generation turn, Canonize runs a hybrid search across three channels:

- **Chat** — Searches narrative memory chunks.
- **LB** — Searches lorebook entries semantically, activating the most relevant ones.
- **Plot** — Searches the plot lorebook for arc entries, supplemented by recency-based filler.

Each channel runs the full pipeline: vector cosine scoring, TF-IDF keyword scoring, RRF fusion, keyword blend, and micro-pool mean threshold. See [RAG_strategy_v4.md](RAG_strategy_v4.md) for the complete technical specification.

## Console Diagnostics

Every turn emits a collapsible group to the browser console showing the full retrieval graph for each channel:

```
[CNZ] chat | 96 raw  pool=20  μ=0.685  Sk=0.91  (mean)  kw≤0.213  → 9 injected
  ████████████████████  355+313+213=881
  ████████████████░░░░  390+319+148=857
  ...
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ cutoff  (threshold 0.685)
  ██████████████░░░░░░  318+274+70=662
  ...
```

Each bar is color-coded by source lane:
- **Blue** — content embedding contribution
- **Amber** — header embedding contribution
- **Green** — keyword (FTS) contribution

Score suffix shows the three-way breakdown: `content+header+keyword=total` (all × 1000).

## Tuning

The key knobs and what they do:

| Knob | What to change it for |
|---|---|
| **Chat/LB Min** | Guaranteed floor. Set to 0 if you want the algorithm to return nothing on a low-relevance turn. |
| **Chat/LB Max** | Hard ceiling. Raising this allows more context but risks dilution. |
| **Cutoff Mode** | `mean` is permissive. Use `mean+1sd` if too many marginal results are leaking through. |
| **Pool Multiple** | How many candidates the statistics are computed on. 2 is tight; 3–4 is better for large chats (300+ chunks). |
| **Keyword Blend** | How much the FTS lane contributes. Default 70% vector. Lower toward 0.5 if proper nouns are being missed. |

## Cache Files

- **`cnz_store_<chatname>.json`** — Vector cache per chat. Delete to reclaim space or force re-index.
- **`cnz_rag_health.csv`** — Per-turn telemetry. One row per channel with pool statistics, threshold, and result count. Open in a spreadsheet to audit retrieval quality over time.

## Rebuild vs Purge

- **Rebuild RAG** — Re-embeds everything from existing chunk metadata. Use after changing embedding provider or model.
- **Purge RAG** — Deletes all data. The healer will reconstruct from chat history on next load (one embedding pass required).
