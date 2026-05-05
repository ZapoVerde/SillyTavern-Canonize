# CNZ — Narrative Memory (RAG) Specification
*Authoritative reference for RAG purpose, structure, and behaviour*
*Current as of v0.9.47*

---

## What RAG Is For

The Narrative Memory system gives ST's vector engine a searchable archive of
the full roleplay history. As the chat grows, older turns are masked from the
main AI prompt by the context mask. RAG ensures that narrative detail from
those masked turns is still retrievable during generation — character
relationships, established facts, prior scene outcomes — without those turns
occupying context window space.

Each sync cycle canonizes the uncommitted gap turns into a structured plain
text document, uploaded to the ST Data Bank as a character attachment. ST's
vector engine indexes that document and pulls relevant chunks into the prompt
at generation time.

RAG is optional. It is off by default and must be enabled in settings.

---

## Core Concepts

**Pairs.** CNZ works in prose pairs — one user message plus all consecutive AI
messages that follow it. Pairs are the atomic unit of chunking. All window
sizing and overlap logic operates on pairs, not raw messages.

**The gap.** The uncommitted gap is the set of pairs between the DNA chain
head and the current live context buffer boundary. This is exactly what each
sync cycle canonizes. RAG chunks always cover the gap — not the live buffer
and not already-committed turns.

**Chunks.** A chunk is a fixed window of consecutive pairs from the gap. Each
chunk gets a semantic header — a 2–3 sentence AI-generated summary of the most
significant narrative moment in that window. The header is what the vector
engine retrieves on; the full dialogue content is included in the document body
for downstream use.

**Classifier history.** Each classifier call can optionally receive a window of
preceding pairs as narrative context. This context helps the classifier
understand what led up to the target turns. History pairs are never part of the
chunk being classified — they are read-only context only. History may reach
back into committed turns from prior sync cycles.

---

## What Happens During a Sync

When a sync fires and RAG is enabled, the gap pairs are partitioned into
chunks according to the chunk size setting. Already-classified chunks whose
separator label still matches the current template are reused immediately
without re-classifying — they are pre-populated from headers stored in the
chat file. The remaining chunks are sent to the classifier AI in parallel, up
to the concurrency limit.

Once all chunks have been classified, the full document is assembled and
uploaded to the Data Bank as a character attachment. The sync then commits its
DNA chain node as normal.

If the classifier fails for a chunk, it is retried up to the retry limit. If
it still fails, the chunk is left with its turn range label as the header
placeholder.

---

## Chunk Modes

**Non-overlapping** (default) — advances by the chunk size setting with each
chunk. Each pair belongs to exactly one chunk. This is the recommended mode.

**Overlapping** — each chunk covers one new pair plus the preceding overlap
pairs as context. Every pair gets its own chunk, but earlier pairs appear in
multiple windows. This creates retrieval ambiguity in the vector index —
adjacent chunks describe overlapping narrative territory. The classifier
history feature is a cleaner way to give the classifier narrative context
without this side effect. Overlap is supported but not recommended.

**Qvink mode** — forces one-pair chunks. Headers are read directly from Qvink
memory metadata stored on each AI message rather than being AI-classified.
Chunks with a valid Qvink memory are pre-populated immediately; others fall
back to pending. Classifier history is not used in this mode.

---

## The Separator Template

Each chunk in the document is prefixed by a separator line rendered from a
configurable template. The template supports `{{chunk_number}}`,
`{{turn_range}}`, and `{{char_name}}`. The separator also serves as a
validity key — if the separator template changes, all stored headers are
invalidated and chunks are re-classified from scratch. CNZ detects this and
asks for confirmation before applying the new template.

---

## Chat Persistence

When a chunk is classified, its header is written directly into the chat file
on the last AI message of that chunk's pair window. This means headers survive
page reloads and are available immediately the next time the workshop is
opened — without needing to re-classify.

If the separator template has changed since a header was stored, the stored
header is treated as invalid and the chunk is re-queued for fresh
classification.

---

## Step 3 — Narrative Memory Workshop

The workshop is reached at Step 3 of the review modal. It shows the chunks
produced by the most recent sync cycle and lets the user review and correct
the AI-generated headers before the document is uploaded to the Data Bank.

If RAG was disabled when the sync ran, the workshop shows a disabled notice
and no chunks are displayed.

### Summary context

When the user enters the workshop, the current hookseeker summary from Step 1
is used as context for the classifier. If the summary has changed since
classification last ran — because the user edited or regenerated it in Step 1
— all already-classified chunks are marked stale and re-queued with the new
summary.

### Chunk cards

One card is shown per chunk. Each card has:

- An editable text area for the semantic header
- A status indicator showing whether the chunk is pending, being classified,
  complete, or stale
- A Regen button to re-classify that individual chunk with a fresh AI call
- The full dialogue content of that chunk (read-only)

Editing a header text area directly marks the chunk as manually edited.
Manually edited chunks are always included in the document on Finalize,
regardless of whether Finalize would otherwise write anything.

### Raw tab

The Raw tab shows the full compiled document as it stands — all chunks
assembled with their current headers and content. The user can edit the raw
text directly. Once the raw tab has been edited, it is decoupled from the
chunk cards: card editing and individual regen buttons are disabled, and a
warning banner is shown. The Revert button re-links the raw tab to the chunk
state, discarding the manual edits to the raw text.

---

## Document Content Modes

Three content modes control what appears in each chunk block:

- **Summary + Full** (default) — separator, AI-generated header, full
  dialogue transcript
- **Summary only** — separator and AI-generated header only; no raw dialogue
- **Full only** — separator and raw dialogue only; no AI header

---

## Finalize Behaviour

RAG is written to disk during Finalize only if the user made corrections:
either by hand-editing one or more chunk headers, or by editing the raw
document directly. If neither happened, the RAG file produced by the sync
is kept unchanged — AI-classified headers are already persisted to the chat
file during classification and do not need Finalize to preserve them.

When Finalize does write RAG, it assembles the document from the current chunk
state (or uses the raw text if the raw tab was edited), uploads it to the
Data Bank, and registers it as the character attachment. The DNA chain node is
updated in place to record the new file.

---

## Settings Reference

| Setting | Default | Meaning |
|---|---|---|
| `enableRag` | `false` | Master switch — must be on for any RAG processing |
| `ragChunkSize` | `2` | Pairs per chunk (non-overlapping mode) |
| `ragChunkOverlap` | `0` | Overlap pairs per chunk (0 = non-overlapping) |
| `ragClassifierHistory` | `0` | Pairs of preceding context sent to each classifier call (0 = off) |
| `ragSeparator` | `Chunk {{chunk_number}} ({{turn_range}})` | Separator template |
| `ragContents` | `summary+full` | What to include in each chunk block |
| `ragSummarySource` | `defined` | `defined` = AI classifier, `qvink` = Qvink memory |
| `ragMaxTokens` | `100` | Token cap for classifier AI responses |
| `ragProfileId` | `null` | Separate connection profile for classifier calls |
| `maxConcurrentCalls` | `3` | Max simultaneous classifier calls |
| `ragMaxRetries` | `1` | Retry count per chunk on classifier failure |

---

## Known Gaps

**Workshop empty after page reload.** Chunk headers are persisted to the chat
file, but the chunk array itself is not. On page reload, the workshop will be
empty until a new sync runs. Opening the modal without a preceding sync will
show no chunks even though headers from prior cycles exist in the chat.

**No cross-session chunk reconstruction.** The fallback path for reconstructing
the last committed sync window from the DNA chain when no sync has run this
session is not yet implemented.
