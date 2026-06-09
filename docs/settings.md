# Settings Reference

Open the Canonize settings panel via the Extensions drawer in SillyTavern.

**A note on pairs:** Canonize measures conversation in turn-pairs — one user message plus all AI responses that follow it. A pair is the smallest atomic unit of story. All timing, chunking, and horizon settings use pairs as their unit, not individual messages.

---

## General

- **Enable Canonize** — Master switch. Turning this off cleans the prompt stack, detaches all background listeners, and removes the toolbar button.

---

## Profile Management

Canonize supports multiple settings profiles.

- **Profile Dropdown** — Selects the active profile.
- **Save (floppy disk)** — Saves current changes to the active profile. An asterisk (`*`) next to the name indicates unsaved changes.
- **Add (+)** — Creates a new profile cloned from current settings.
- **Rename (pencil)** — Renames the active profile.
- **Delete (trash)** — Deletes the active profile.

---

## CNZ Timing

Canonize works in cycles, not continuously. These settings control how much recent dialogue stays live and unprocessed, how often a sync cycle fires, and how far back the AI looks when building the running summary.

```
│←── archival ───│←── bridge horizon (default 40 pairs) ───│←── sync window (0→8 pairs) ──→│←── live context (8 pairs) ──→│
oldest                                                                                                                       newest
```

- **Live Context Buffer** — How many turn-pairs are left untouched — counted back from the latest entry to the sync point. Everything before this buffer is archived and searched as memory. Default 8.
- **Pairs Between Updates** — How many new pairs must accumulate before a sync cycle triggers. This defines the sync window size. Default 8. Keep this a multiple of Chunk Size to avoid chunks being split across sync windows.
- **Summary Horizon** — How many turns of history are fed to the AI when updating the bridge summary. Default 40.
- **Lorebook Sync Start**
  - *From sync point* — Only scans the newly added block since the last save marker. 
  - *From latest turn* — Scans the entire horizon to the latest turn. 

---

## Connections & Prompts

Canonize makes AI calls in the background, separate from your main chat. Here you set which Connection Manager profile handles that work and what instructions it follows.

- **Summary Connection Profile** — Connection Manager profile used for background summarization and lorebook sync calls. Leave blank to use the current chat model.
- **Edit Prompts** — Opens a prompt editor for Summary, Lorebook, People, and Targeted prompts.
- **Reset All Prompts** — Restores all prompts to built-in defaults.

---

## RAG Storage & Retrieval

This is Canonize's memory engine. It breaks your chat history into indexed chunks and searches them on every turn, pulling in past scenes, lorebook entries, and story arcs relevant to the current moment.

### RAG Summarization

On each sync, Canonize runs the classifier prompt against each new chunk to generate a summary header. These settings control which model handles that work and how.

- **RAG Connection Profile** — Connection Manager profile used for chunk classification.
- **Max Tokens** — Maximum tokens the classifier may produce per chunk. Keep low (50–150) to avoid runaway outputs.
- **Chunk Size (pairs)** — Turn-pairs per archive block. Default 2.
- **Classifier History** — Turn-pairs before each chunk included as context in the classifier prompt. 0 = disabled.
- **Simultaneous Calls** — Maximum parallel background classification calls.
- **Retries on Failure** — How many times a failed classification call is retried per chunk.
- **Classifier Prompt** — Opens the prompt editor for the classifier. Sent to the AI once per chunk to produce the summary header.

### RAG Storage & Retrieval

Embedding converts your text into a searchable form; retrieval pulls the most relevant chunks from the archive on each turn. Rather than inserting a fixed count, Canonize only adds those that score meaningfully above the rest of the shortlist. Min/Max bounds cap the range regardless.

- **Embedding Source / Model** — Provider and model used to convert text into a searchable form. Called directly from the browser using your stored API key. See [installation.md](installation.md) for provider recommendations.
- **API Key** — Appears for providers that require a dedicated key not covered by ST's connection settings (Voyage AI, Nomic AI). Click to set.
- **Embedding Test** — Sends a short probe through your configured provider and model, returning the vector dimension and round-trip latency. Use to confirm your setup before indexing.
- **Chat Min / Max** — The minimum and maximum number of memory chunks inserted per turn.
- **LB Min / Max** — The minimum and maximum number of lorebook entries inserted per turn.
- **Cutoff Mode** — How selectively results are drawn from the shortlist.
  - `Mean` — Everything above the shortlist average. Most permissive.
  - `Mean + 1 std dev` — Stricter. Useful for noisy archives.
  - `Mean + 2 std dev` — Very strict. Only results that stand significantly above average pass.
- **Pool Multiple** — Controls how many results are shortlisted from the archive before the cutoff runs: Pool Multiple × Max (minimum 6). A smaller shortlist draws only from the top of the archive; a larger one casts a wider net. Works in tandem with Cutoff Mode — see [rag.md](rag.md) for guidance on tuning the two together.
- **Keyword Blend** — Controls the proportional contribution of keyword matching against meaning-based similarity scoring. At 70%, keyword results can contribute at most 30% of the top similarity score. Lower = keywords have more influence; higher = meaning-based similarity dominates.
- **Unicode Keyword Search** — Enable for non-Latin languages (French, German, Russian, etc.) to preserve diacritics and special characters in the keyword index. The meaning-based search lane is unaffected.
- **Bypass WI keyword activation** — Detaches the lorebook from SillyTavern's keyword scanner. When enabled, lorebook entries are activated only by Canonize's semantic search, not ST's keyword matching. Disable to re-attach and use the standard WI pipeline.
- **Injection Template** — Wraps all retrieved chunks as a block before insertion. Use `{{text}}` where the chunks should appear.
- **Chunk Template** — Wraps each individual retrieved chunk. Supports `{{text}}`, `{{turn_range}}`, `{{header}}`, and `{{char_name}}`.
- **Sync Separator** — Text placed between chunks in the classifier document during sync. Changing this clears stored chunk headers and triggers reclassification.
- **Additional Lorebooks** — Read-only reference lorebooks (world encyclopaedias, spell books, etc.) queried every turn alongside the character lorebook. Entries are indexed and retrieved semantically. Each added lorebook has its own Min/Max and Bypass WI controls. The list is saved in the chat anchor and restores automatically on branch rollback.

### Plot Memory

Plot arcs track ongoing storylines across your chat. These settings control how many arcs surface each turn, and what happens when the current scene only touches one thread — so other storylines don't go silent.

- **Plot Min / Max** — Floor and ceiling for plot arcs retrieved per turn. Plot Min also sets the filler threshold: when semantic search returns fewer arcs than this value, filler picks up the shortfall.
- **Recent cards per arc** — For each semantically retrieved arc, the origin card is always included. This setting controls how many additional recent cards are added on top. Any card directly matched by semantic search is also always included regardless of this limit.
- **Recent cards per filler arc** — How many cards each filler arc brings in. Filler arcs contribute recent cards only; they do not trigger a separate semantic search for that arc.
- **Plot filler enabled** — When the current scene triggers fewer arcs than Plot Min, filler surfaces the shortfall from arcs not referenced in recent turns. This keeps dormant storylines alive instead of letting them quietly disappear whenever the scene focuses on only one thread.
- **Filler strategy** — How filler arcs are selected when topping up to Plot Min:
  - `random` — picks from eligible arcs at random each turn.
  - `oldest arc` — prioritises the arc created earliest.
  - `oldest surfaced` — prioritises the arc that has gone the longest without appearing in context, rotating through neglected storylines over time.

---

## Admin and Utilities

One-off maintenance tools: rebuild the memory index, wipe it entirely, or inspect its internal state.

- **Verbose Logging** — Outputs detailed execution logs to the browser console.
- **Inspect Chain** — Opens the DNA Chain Inspector to view your save-state timeline.
- **Rebuild RAG** — Re-indexes all chunks and lorebook entries for the active chat. A confirmation prompt offers an optional checkbox before it runs:
  - *Without "Reclassify all chunks with AI":* Re-embeds existing chunk summaries as-is. Already-indexed chunks are skipped, so this is safe to re-run after a partial failure. Use after switching embedding providers or models, or to recover from a corrupt vector cache. The chat file and all chunk summaries are unchanged.
  - *With "Reclassify all chunks with AI (slow)":* Discards existing chunk summaries and re-runs the AI classifier across the entire conversation history to generate fresh ones, then re-embeds everything. Use when your classifier prompt has changed, or when you have changed Chunk Size or Chunk Overlap and want the archive re-sliced to match. Each chunk costs one AI call. The chat file (your actual messages) is never modified, but all AI-generated chunk summaries are replaced.
- **Purge RAG** — Deletes all RAG data for the active chat: the vector cache and the plot lorebook. The narrative lorebook (characters, places, concepts) and your chat file are not touched. Run Rebuild RAG afterwards to restore the index and plot lorebook.

---

## Cache Files

- **`cnz_store_<chatname>.json`** — Per-chat vector cache. Disposable: delete to reclaim disk space or force a clean re-index.
- **`cnz_rag_health.csv`** — One row per retrieval channel per turn. Columns: `timestamp, character, channel, provider, model, candidates, max_score, min_score, pool_size, local_mean, local_median, local_std_dev, pearson_skewness, threshold, cutoff_mode, returned`. Open in any spreadsheet to inspect retrieval quality over time.
