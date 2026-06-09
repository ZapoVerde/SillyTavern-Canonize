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

## Timing

- **Live Context Buffer** — Number of recent turn-pairs left uncompressed and sent as raw dialogue. Default 8.
- **Pairs Between Updates** — How many new pairs must accumulate before a sync cycle triggers. Also defines the sync window size. Default 8. Keep this a multiple of Chunk Size to avoid chunks being split across sync windows.
- **Summary Horizon** — How many turns of history are fed to the AI when updating the bridge summary. Default 40.
- **Lorebook Sync Start**
  - *From sync point* — Only scans the newly added block since the last save marker. 
  - *From latest turn* — Scans the entire horizon to the latest turn.

---

## Connections and Prompts

- **Summary Connection Profile** — Connection Manager profile used for background summarization and lorebook sync calls. Leave blank to use the current chat model.
- **Edit Prompts** — Opens a prompt editor for Summary, Lorebook, People, and Targeted prompts.
- **Reset All Prompts** — Restores all prompts to built-in defaults.

---

## RAG Storage and Retrieval

RAG is always active when Canonize is enabled.

### Content and Embedding

- **RAG Contents**
  - *Summary + Full* — Retrieves the AI-generated chunk summary plus raw dialogue. Recommended.
  - *Summary Only* — Chunk summary only. Compact.
  - *Full Content Only* — Raw dialogue only.
- **RAG Connection Profile** — Model profile used for chunk classification.
- **Chunk Size (pairs)** — Turn-pairs per RAG archive block. Default 2.
- **Chunk Overlap** — Overlapping pairs between adjacent chunks. Prevents transitions from being cut mid-scene. Default 0.
- **Simultaneous Calls** — Maximum parallel background classification calls.
- **Embedding Source / Model** — Provider and model for generating embedding vectors. Called directly from the browser using your stored API key.

### Retrieval Tuning

Canonize uses a hybrid micro-pool threshold rather than a fixed result count. On each turn it fuses vector similarity with keyword relevance, computes statistics on the top candidates, and returns everything above the mean — clamped to your Min/Max bounds.

- **Chat Min / Max** — Floor and ceiling for narrative memory chunks injected per turn.
- **LB Min / Max** — Floor and ceiling for lorebook entries activated via semantic search per turn.
- **Cutoff Mode** — Threshold strictness applied to the local candidate pool.
  - `Mean` — Everything above the pool average. Most permissive.
  - `Mean + 1 std dev` — Stricter. Useful for noisy databases.
  - `Mean + 2 std dev` — Very strict. Only clearly elite results pass.
- **Pool Multiple** — Candidate pool size = Pool Multiple × Max Results (minimum 6). Stats are computed on this pool only, not the full database. 2 is a tight set; 3–4 gives more stable statistics for larger chats.
- **Keyword Blend** — How much the keyword (FTS) lane contributes relative to the top vector score. At 70% vec, the strongest keyword match can add at most 30% of the top cosine score. Lower = keyword has more influence; higher = vector dominates.
- **Unicode FTS** — Enable for non-Latin languages (French, German, Russian, etc.) to preserve diacritics and non-ASCII characters in the keyword index. The vector lane is unaffected.

### Plot Memory

- **Plot Min / Max** — Floor and ceiling for plot arc entries retrieved per turn.
- **Recent cards per arc** — For each retrieved arc, how many recent cards to include beyond the origin card.
- **Recent cards per filler arc** — Same, for filler arcs surfaced by the plot filler system.
- **Plot filler enabled** — Whether the filler system surfaces underrepresented arcs to maintain narrative breadth.
- **Filler strategy** — How filler arcs are selected: `random`, `oldest arc`, or `oldest surfaced`.

---

## Admin and Utilities

- **Verbose Logging** — Outputs detailed execution logs to the browser console.
- **Inspect Chain** — Opens the DNA Chain Inspector to view your save-state timeline.
- **Rebuild RAG** — Re-embeds all stored chunks and lorebook entries for the active chat. Use after switching embedding providers or models, or if the cache is corrupt. Does not affect chat history.
- **Purge RAG** — Deletes all RAG data for the active chat. The cache rebuilds automatically on next load.

---

## Cache Files

- **`cnz_store_<chatname>.json`** — Per-chat vector cache. Disposable: delete to reclaim disk space or force a clean re-index.
- **`cnz_rag_health.csv`** — One row per retrieval channel per turn. Columns: `timestamp, character, channel, provider, model, candidates, max_score, min_score, pool_size, local_mean, local_median, local_std_dev, pearson_skewness, threshold, cutoff_mode, returned`. Open in any spreadsheet to inspect retrieval quality over time.
