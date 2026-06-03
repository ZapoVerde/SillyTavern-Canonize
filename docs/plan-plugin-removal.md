# Plan: Plugin Removal and File-Based RAG Store

**Goal:** Eliminate the server plugin and `npm install` requirement entirely. Replace PGlite vector storage with JSON files in ST's user data directory, embedding generation with a direct call through ST's own embedding infrastructure, and PostgreSQL FTS with MiniSearch. No user-visible behavioural change.

---

## What Goes Away and Why

The plugin (`plugin/`) exists to do three things: proxy embedding API calls through ST's server-side vector modules, store chunks and lorebook vectors in a PGlite (PostgreSQL-in-process) database with the pgvector extension, and serve HTTP routes that the extension calls. Every one of these is replaceable without the plugin:

- **Proxy embedding:** ST's server already exposes embedding via its own API. The extension can call that endpoint directly instead of routing through a custom plugin.
- **PGlite + pgvector:** At realistic Canonize data volumes (a few hundred to low thousands of chunks per character), a linear-scan cosine similarity in JS is indistinguishable in latency from an HNSW index. The overhead is measured in single-digit milliseconds and is completely masked by embedding API round-trip time.
- **HTTP routes:** The extension already talks to ST's server for everything else (lorebooks, chats, settings). It simply calls different endpoints for file read/write.

The plugin is also the cause of the entire install friction: copying files, running `npm install`, restarting ST. That friction disappears completely.

---

## New Storage Model

Three JSON files per character, written to ST's user files directory. ST's file API uses flat filenames (no subdirectory support confirmed), so the CNZ prefix is the namespace — mirroring Loggeryze's `st_` convention:

**`cnz_chunks_{avatarKey}.json`**
Holds all RAG chunks for the character. Each chunk record contains: `hash`, `anchorUuid`, `chatFile`, `pairStart`, `pairEnd`, `header`, `turnRange`, `content`, content embedding (Base64-encoded Float32Array), and header embedding (Base64-encoded Float32Array, nullable). A serialised MiniSearch index is stored alongside the chunk array and rebuilt incrementally on write — it is never recomputed from scratch at query time.

**`cnz_lb_{avatarKey}.json`**
Holds all lorebook vector entries for the character. Each record contains: `hash`, `anchorUuid`, `lorebookName`, `entryUid`, `entryKeys`, `content`, and embedding (Base64-encoded Float32Array).

**`cnz_plot_{avatarKey}.json`**
Holds plot filler history: a map of `{lorebookName}/{arcTag}` to `{ lastSurfacedTurn }`. Small — no embeddings.

**Why Base64 Float32Array instead of JSON float arrays?**
A 768-dimension embedding as a JSON float array is approximately 7,500 characters. As a Base64-encoded `Float32Array` it is approximately 1,025 characters — a 7× size reduction. At 1,000 chunks × 2 embeddings each, this is the difference between a 15 MB file and a 2 MB file. Encode once on write; decode once on load. The math is `btoa(String.fromCharCode(...new Uint8Array(f32arr.buffer)))` in reverse.

**Multi-machine access** is identical to today. Files live on the ST server in the user data directory, the same tree as lorebooks and chat files. All clients connecting to the same ST instance share the same files.

---

## New Embedding Approach

### Primary path: ST's built-in vector endpoint

ST already exposes embedding generation through an API used by its Vectorize extension. Before writing any embedding code, **verify the exact endpoint and request shape** against ST's server source. Expected form: `POST /api/vector/embed` accepting `{ source, model, text }` (or `{ texts }` for batch) and returning `{ embedding: number[] }`. This endpoint reuses whatever embedding provider the user has already configured in ST's Vectorize settings, requires no additional auth logic in the extension, and keeps API keys server-side.

If this endpoint does not exist or does not support all required providers, the fallback is direct browser-to-embedding-API calls using the keys already accessible in ST's client-side settings objects (`oai_settings.api_key_openai`, `textgenerationwebui_settings.server_urls`, etc.).

### Embed progress monitoring

The plugin's SSE embed-stream (`/api/plugins/cnz/embed-stream`) currently drives a toast during large rebuilds. With embedding happening in the extension, progress is trackable directly. A simple in-memory counter passed through the existing bus (a `EMBED_PROGRESS` event) replaces the SSE stream. The `_startEmbedMonitor` function in `lifecycle.js` is deleted; the toast logic moves to wherever batch embedding is driven.

---

## New Full-Text Search

**MiniSearch** replaces PostgreSQL's `tsvector`/`plainto_tsquery`. It provides BM25 scoring (superior to `ts_rank_cd` for short documents), Porter stemming, stop-word removal, fuzzy matching, and field weighting. The index is serialisable to JSON and stored inside `chunks-{avatarKey}.json` so it never needs to be rebuilt from disk — only updated incrementally when new chunks are written.

MiniSearch is a zero-dependency ES module. Vendor it into the extension at `vendor/minisearch.js` (copy the minified ESM build from npm). Do not import from a CDN — extensions must be self-contained.

The FTS module (`rag/fts.js`) is **Pure**. It accepts an array of chunk records and a query string, builds or accepts a serialised index, and returns ranked results. It has no knowledge of files, the DOM, or ST.

---

## ST APIs — Confirmed and Still to Verify

### File API — confirmed via Loggeryze

Loggeryze already uses these endpoints in production. They are the pattern to follow exactly.

**Write:** `POST /api/files/upload`
Body: `{ name: 'cnz_chunks_{avatarKey}.json', data: <base64> }`
The `data` field is UTF-8 bytes of the JSON content encoded as Base64 — same chunked `btoa` pattern Loggeryze uses in `_encode()`.

**Read:** `GET /user/files/{filename}`
Returns the raw file content. For JSON files, call `.json()` on the response.

Files are flat (no subdirectory nesting confirmed). The `cnz_` prefix is the namespace.

### Embedding API — still to verify

`POST /api/vector/embed` is the preferred path. This endpoint must be verified against ST's server source (`src/endpoints/vector*.js`) before implementation. Expected shape: `{ source, model, text }` → `{ embedding: number[] }` for single, `{ texts }` → `{ embeddings: number[][] }` for batch.

If this endpoint does not exist or does not cover all required providers, the fallback is direct browser-to-API calls using keys from `oai_settings` / `textgenerationwebui_settings`. The `embed-client.js` IO Wrapper is the only file that changes depending on which path is used.

### AI Studio models list — still to verify

Currently the plugin fetches available AI Studio embedding models by calling the Google API using the key from ST's settings. Verify whether ST exposes an endpoint for this, or whether `embed-client.js` should keep the direct Google API call (the plugin already does this directly — it is safe to preserve).

---

## Files to Delete

| File | Why |
|---|---|
| `plugin/` (entire directory) | The plugin and all its dependencies cease to exist |
| `rag/vec-store.js` | Replaced by `rag/file-store.js` |
| `rag/plugin-health.js` | No plugin to check; RAG channel is always available |
| `core/plugin-setup-orchestrator.js` | No plugin to set up or symlink |
| `modal/plugin-setup-modal.js` | No plugin setup UI |

---

## Files to Add

Each new file must open with a complete Principle 10 preamble before any implementation.

### `rag/embed-client.js`
**Role:** IO Wrapper — generates embeddings by calling ST's vector endpoint (or direct embedding API as fallback). Owns nothing. Returns raw float arrays. Has no knowledge of chunks, lorebooks, or files. Exports `embedText(cfg, text)` and `embedBatch(cfg, texts)`. Also owns `testEmbed(cfg)` and `fetchAiStudioModels()` (migrated from `vec-store.js`). Reports estimated embed token usage to Loggeryze (same as `vec-store.js` currently does).

### `rag/cosine.js`
**Role:** Pure — cosine similarity math. No external reads or writes. Exports:
- `cosineSimilarity(a, b)` — scalar similarity between two float arrays
- `linearScan(chunks, queryVec, validUuids, topK, threshold)` — returns top-K chunks from the provided array scoped to valid anchor UUIDs
- `linearScanLb(entries, queryVec, validUuids, topK)` — same for lorebook entries
- `encodeEmbedding(float32Array)` — Base64 encode for file storage
- `decodeEmbedding(base64)` — Base64 decode back to Float32Array

Temporal decay (currently in `generation-hook.js`) may stay where it is or move here — it is pure math either way. Decide at implementation time based on where it reads most clearly.

### `rag/fts.js`
**Role:** Pure — MiniSearch-based full-text search over chunk records. No external reads or writes. Exports:
- `buildFtsIndex(chunks)` — returns a serialisable MiniSearch index
- `serialiseFtsIndex(index)` — returns a JSON string
- `deserialiseFtsIndex(json, chunks)` — reconstructs the index from stored JSON
- `queryFts(index, queryText, validUuids, topK)` — returns ranked chunk references

Field weighting: `header` field weighted above `content`. Fuzzy matching enabled with a maximum edit distance of 1.

### `rag/file-store.js`
**Role:** IO Wrapper — reads and writes the CNZ chunk, lorebook, and plot files in ST's user data directory. Owns the file path convention (`cnz/chunks-{avatarKey}.json`, etc.). Translates CNZ domain operations into file reads/writes. Exports a surface that mirrors the current `vec-store.js` public API exactly — same function names, same argument shapes, same return shapes — so all callers require only an import path change, not a logic change.

Functions to export (same names as `vec-store.js`):
`insertSyncChunks`, `querySyncChunks`, `insertLorebookEntries`, `queryLorebookEntries`, `queryRecentPlotEntries`, `purgeAnchorChunks`, `purgeCharacterChunks`, `purgeCharacterLbEntries`, `anchorChunkCount`, `anchorStats`, `fetchEmbedStats`.

Internally: load the character's chunk file once per operation (lazy cache invalidated on write), run `cosine.js` for vector search, run `fts.js` for keyword search, merge with the RRF logic already in `rrf.js` (which is Pure and can be imported by the IO Wrapper). RRF lives in `plugin/rrf.js` today — it must be **moved** to `rag/rrf.js` (pure JS, no plugin dependency) before the plugin directory is deleted.

---

## Files to Move

| From | To | Why |
|---|---|---|
| `plugin/rrf.js` | `rag/rrf.js` | Pure function, no reason to be in the plugin directory; `file-store.js` will import it |

---

## Files to Modify

For each file, only the listed concerns change. Everything else is untouched.

### `rag/pipeline.js`
Change `insertSyncChunks` import from `./vec-store.js` → `./file-store.js`. Update preamble `external_io` to remove `/api/plugins/cnz/insert-chunks`. No logic changes.

### `rag/rag-fetch.js`
Change `querySyncChunks`, `queryLorebookEntries`, `queryRecentPlotEntries` imports from `./vec-store.js` → `./file-store.js`. Remove `isPluginReachable` guard (no longer conditional — RAG always runs if the channel is enabled per Principle 7). Update preamble.

### `rag/generation-hook.js`
Remove `isPluginReachable` import and both plugin-reachability guards. Change `insertLorebookEntries` import from `./vec-store.js` → `./file-store.js`. Update preamble.

### `core/sync.js`
Remove `isPluginReachable` import from `../rag/plugin-health.js`. Remove the plugin-reachability early-return inside Lane 3. Lane 3 now runs unconditionally whenever the RAG channel is enabled. Update preamble `external_io`.

### `core/sync-helpers.js`
Change `insertLorebookEntries` import from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble.

### `core/healer.js`
Change `anchorChunkCount`, `insertSyncChunks`, `insertLorebookEntries` imports from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble `external_io` to remove plugin endpoint references.

### `core/maintenance.js`
Change `insertSyncChunks`, `insertLorebookEntries`, `anchorChunkCount` imports from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble.

### `core/maintenance-cleanup.js`
Change `purgeCharacterChunks`, `purgeCharacterLbEntries` imports from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble.

### `lifecycle.js`
Remove `insertLorebookEntries` import from `./rag/vec-store.js` → `./rag/file-store.js`. Delete the `_startEmbedMonitor` function and its SSE fetch. Replace with a bus listener on a new `EMBED_PROGRESS` bus event emitted by `embed-client.js` during batch operations. The toast threshold and message format stay the same.

### `modal/commit.js`
Change `insertLorebookEntries` import from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble.

### `modal/dna-inspector.js`
Change `anchorStats` import from `../rag/vec-store.js` → `../rag/file-store.js`. Update preamble.

### `settings/handlers-rag.js`
Change `testEmbed`, `fetchAiStudioModels` imports from `../rag/vec-store.js` → `../rag/embed-client.js`. Update preamble.

### `settings/panel.js`
Remove `getLastHealthResult` import from `../rag/plugin-health.js`. Remove `triggerSetupFromSettings` import from `../core/plugin-setup-orchestrator.js`. Remove the `pluginLinked` variable and the `#cnz-setup-symlink-btn` click handler. Pass `false` (or remove the parameter entirely) from `buildSettingsHTML`. Update preamble.

### `settings/html-admin.js`
Remove the `pluginLinked` parameter from `buildAdminSectionHTML`. Delete the symlink button HTML. Update the function signature and preamble. If the admin section becomes empty after this removal, delete the file and inline what remains into `settings-html.js`.

### `settings/settings-html.js`
Remove `pluginLinked` parameter from `buildSettingsHTML`. Stop passing it to `buildAdminSectionHTML`. Update preamble.

### `index.js`
Remove `runPluginSetup` import and call. Update preamble.

### `bus.js`
Add `EMBED_PROGRESS` to the `BUS_EVENTS` constants. No other changes.

---

## Principles Compliance Notes

**Principle 1 (The Chat IS the Database):** Unchanged. The JSON files are a secondary operational cache, not the source of truth. The anchor chain in the chat remains the ground truth; the healer can rebuild the file store from it. This is identical to the current relationship between the chat and PGlite.

**Principle 4 (Four Kinds of Code):** `cosine.js` and `fts.js` are Pure. `embed-client.js` and `file-store.js` are IO Wrappers. No derivation logic enters the IO layer; no IO enters the Pure layer.

**Principle 5 (Additive Sync):** The `insertSyncChunks` contract is preserved. New chunks are appended; the `hash + anchorUuid` uniqueness constraint (currently enforced by SQL `ON CONFLICT DO NOTHING`) is enforced in `file-store.js` by checking existing hashes before writing.

**Principle 6 (Label Everything):** The `cnz/` prefix on all file paths is the namespace. The `avatarKey` scopes per-character. The `anchorUuid` on every record is the per-anchor label used by purge and heal operations.

**Principle 7 (Independently Toggleable):** Removing the plugin-reachability gate does not break independent toggling. The RAG channel is still independently disableable via settings. The gate was a plugin-availability guard, not a channel enable/disable control — these are different concerns and the former should never have been the mechanism for the latter.

**Principle 9 (Healer Restores Completely):** The healer's contract is unchanged. It calls `purgeAnchorChunks` and `insertSyncChunks` through `file-store.js` instead of `vec-store.js`. The file-store implementation must ensure these operations are atomic enough that a partial failure leaves no inconsistent state — write the complete file or do not write at all.

**Principle 10 (Self-Describing):** Every new and modified file updates its preamble before any code is changed. The timestamp, role, API declaration, and contracts are all updated.

**Principle 11 (Size Budget):** `file-store.js` will be the largest new file. If it approaches 300 lines, split at the fault line between chunk operations and lorebook operations — matching the existing `db.js` / `db-lb.js` split in the plugin.
