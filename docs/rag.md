# Narrative Memory (RAG)

Canonize's RAG system archives older conversation blocks into a searchable vector database and retrieves the most relevant past moments on every generation turn. This gives the AI accurate recall of events from hundreds or thousands of turns ago without sending them in the raw context window.

## How It Works

### Storage

Every sync cycle, new conversation blocks are:

1. Sliced into chunks (default 2 turn-pairs each, with optional overlap).
2. Classified by an AI call — each chunk gets a chunk summary describing what happened.
3. Embedded as vectors using your configured embedding provider (content body and chunk summary are embedded separately for two-lane retrieval).
4. Written to a per-chat cache file alongside the lorebook entry vectors.

### Retrieval

On every generation turn, Canonize runs a hybrid search across three channels:

- **Chat** — Searches narrative memory chunks.
- **LB** — Searches lorebook entries semantically, activating the most relevant ones.
- **Plot** — Searches the plot lorebook for arc entries, supplemented by recency-based filler.

Each channel runs the full pipeline: vector cosine scoring, TF-IDF keyword scoring, RRF fusion, keyword blend, and micro-pool mean threshold. See [RAG_strategy_v4.md](RAG_strategy_v4.md) for the complete technical specification.

### Additional Lorebooks

Beyond the three built-in channels, you can attach extra lorebooks to a chat for semantic retrieval. These appear in the **Additional Lorebooks** section of the RAG Storage & Retrieval panel.

Each additional lorebook has its own Min/Max budget and a **Bypass WI** toggle that controls how its results are injected:

- **Bypass WI off** (default) — matched entries are activated via `WORLDINFO_FORCE_ACTIVATE`, the same mechanism as the main LB channel. ST's normal lorebook pipeline handles them.
- **Bypass WI on** — matched entries are injected directly into the CNZ lorebook prompt slot, bypassing ST's world info system entirely. Use this for lorebooks whose entries contain structured data or narrative context you want injected verbatim without ST filtering.

Additional lorebook configuration is stored in the DNA anchor — it is per-chat, not a global setting, and travels with the chat file.

At each generation turn, Canonize checks whether the content of each additional lorebook has changed since it was last indexed. If it has, the lorebook is re-embedded before the query runs. This happens automatically; no manual rebuild is needed.

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
- **Amber** — chunk summary embedding contribution (labelled `header` in the telemetry output)
- **Green** — keyword (FTS) contribution

Score suffix shows the three-way breakdown: `content+header+keyword=total` (all × 1000).

## Tuning

The key knobs and what they do:

| Knob | What to change it for |
|---|---|
| **Chat/LB Min** | Guaranteed floor. Set to 0 if you want the algorithm to return nothing on a low-relevance turn. |
| **Chat/LB Max** | Hard ceiling. Set this about 30% above how many results you'd typically want — the threshold trims it back on quiet turns, and the headroom lets it fill out on information-dense ones. |
| **Cutoff Mode** | Controls how selective the threshold is. See profiles below. |
| **Pool Multiple** | How many candidates the statistics are computed on. Raise to 3–4 for large chats (300+ chunks). |
| **Keyword Blend** | How much the FTS lane contributes. Default 70% vector. Lower toward 0.5 if proper nouns are being missed. |

### Suggested Profiles

Pick one as a starting point. All of these work with the 30% Max headroom recommendation above.

| Profile | Pool Multiple | Cutoff Mode | Character |
|---|---|---|---|
| **Adaptive — Inclusive** | 2 | `mean` | Returns strong results plus high-scoring neighbours. The threshold grades on a curve within the top candidates. Good default for most chats. |
| **Adaptive — Selective** | 5 | `mean+1sd` | Only items that stand clearly above the background pass. More conservative on flat or noisy queries, tighter around genuine peaks. Good for large databases or multi-genre stories. |
| **Pseudo-fixed** | 4 | `mean` | The large pool pulls the mean well below the top results, so nearly all of them pass. Returns close to Max on most queries. Use when you want predictable volume. |
| **Strict clamp** | 4 | `mean+2sd` | Only the strongest standouts pass. Expect returns near Min on most turns, with larger batches only when relevance is very high. |

The first two are the recommended defaults. See [RAG_strategy_v4.md — Appendix A](RAG_strategy_v4.md#appendix-a-understanding-the-knobs--2mean-vs-51sd) for the mathematical explanation of why they behave differently.

## Cache Files

- **`cnz_store_<chatname>.json`** — Vector cache per chat. Delete to reclaim space or force re-index.
- **`cnz_rag_health.csv`** — Per-turn telemetry. One row per channel with pool statistics, threshold, and result count. Open in a spreadsheet to audit retrieval quality over time.

## Rebuild vs Purge

- **Rebuild RAG** — Re-embeds everything from existing chunk metadata. Use after changing embedding provider or model.
- **Purge RAG** — Deletes all data. The healer will reconstruct from chat history on next load (one embedding pass required).

---

## Appendix: RAG Explained From Scratch

This section is for readers who are new to the concept. No machine-learning background required.

### The core problem RAG solves

A language model can only "see" a fixed number of tokens at one time — its **context window**. For a long roleplay that has been running for weeks, the full chat history is far too large to fit. The model only ever reads the most recent portion; everything older is invisible to it.

RAG is a way to give the model selective access to the past without cramming all of it into the window.

### What a vector is

A **vector** in this context is a list of numbers — typically hundreds or thousands of them — that represents the meaning of a piece of text.

An embedding model (a specialized AI) reads a sentence and outputs a vector. The key property is that **similar meanings produce similar vectors**. The vector for "Elena entered the tavern at dusk" will be mathematically close to the vector for "She arrived at the inn in the evening," even though the words are different. The vector for "Theron's betrayal broke her trust" will be far away from both of those.

This lets the system find relevant memories by meaning, not by exact keyword matching.

### How similarity is measured

Vectors are compared using **cosine similarity**, which measures the angle between two vectors in high-dimensional space. A score of 1.0 means the vectors point in exactly the same direction (identical meaning). A score near 0 means they are unrelated.

When Canonize searches for relevant chunks, it converts the current generation context into a vector and finds the stored chunks whose vectors are closest to it. Those are the chunks that are semantically most relevant to what is happening right now in the story.

### The basic RAG transaction

Here is what happens on every single generation turn:

1. **The current context is embedded.** Canonize takes the recent messages and turns them into a query vector.
2. **The vector database is searched.** The query vector is compared against all stored chunk vectors. The closest matches win.
3. **The winning chunks are retrieved.** Canonize pulls the original text (or summaries) of the top-scoring chunks.
4. **The chunks are injected into the prompt.** Before the model generates its response, the retrieved text is inserted into the context — usually in a dedicated lorebook entry or injection slot.
5. **The model generates normally.** From the model's point of view, this information was always there. It reads the injected memories as part of the context and can reference them in its response.

The model itself has no special RAG awareness. It simply sees text that includes relevant past events, and writes accordingly.

### What the embedding provider does

The embedding provider is the service that converts text into vectors. Canonize supports several (local models via Ollama, cloud APIs, etc.). The embedding model has no creative role — it never writes story content. It only performs the translation between text and numbers.

The quality of retrieval depends heavily on the embedding model. A model that produces rich, meaning-aware vectors will find "Elena's grief after the funeral" when the story is discussing loss, even if those exact words haven't appeared recently. A weaker model may miss the connection.

### Why there are two lanes (content and summary)

Canonize embeds each chunk twice: once for its **raw content** and once for an AI-generated **chunk summary**. These are two separate vectors stored side by side.

The content lane is good at matching specific details — names, places, exact events. The summary lane is good at matching themes and emotional beats, because the summary abstracts away surface details and captures what the scene was *about*.

Querying both lanes and merging the results (via RRF fusion) gives more robust retrieval than either lane alone.
