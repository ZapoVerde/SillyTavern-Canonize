# Canonize — Project Principles
*Read before writing any code. Applies to every session.*

---

## What a Principle Is

**A principle is an enduring statement of design intent.** It says what must be true and why it matters — not how it is currently implemented. A principle should survive a complete rewrite: if you could achieve the same property by different means, the principle still holds.

**A principle is not:** a description of specific functions or file paths, a code recipe, a static analysis rule, or implementation documentation. When a principle references code by name, that code illustrates the principle in action — it is not the principle itself.

If you find yourself writing "call X" or "wrap in Y", move that detail into code comments or documentation. The principle captures the *why*.

---

## 1. The Chat IS the Database

Canonize manages **Narrative Continuity**. The chat file is the only database that matters.

We do not trust external files, databases, or global settings for the narrative state of a story branch. Every sync embeds a complete World State Snapshot directly into the hidden metadata of chat messages. If the data is not in the chat, it does not exist for CNZ. This means the chat can be copied, moved, or loaded on a different machine and every sync point will still be intact.

---

## 2. Every Branch Carries Its Own History

Branch-awareness is not a feature — it is a structural guarantee.

Because snapshots live inside the messages themselves, every timeline branch intrinsically carries its own perfect state history. There is no central save file that branches must synchronize with. When the user swipes, rolls back, or forks the chat, the system walks the embedded snapshot chain backward to find the most recent valid anchor that belongs to the current branch, and restores exactly to that point. There is no "latest" — there is only "valid for this branch."

---

## 3. Turn Pairs are the Atomic Unit

CNZ measures the story in **Turn Pairs** (1 user message + all following AI responses), never in individual messages.

A sync snapshot never cuts in the middle of an exchange. All snapshot coordinates, scene boundaries, and sync window calculations use pair indexes as their stable reference. Code that reasons about individual message counts instead of pairs at the narrative layer is wrong.

---

## 4. The Three Kinds of Code

Every module belongs to exactly one of three categories. Mixing them is a defect.

1. **Pure Functions** — Input in, derived output out. No external reads or writes. No DOM. No settings access. No knowledge that the UI exists.
2. **Stateful Owners** — The strictly bounded gatekeepers of runtime memory. Only one module may own any given state variable.
3. **IO Wrappers** — Call LLMs, write lorebooks, push vectors, read chat metadata, update the DOM. Contain zero narrative derivation logic. They move data; they do not reason about it.

Each file declares its category before its implementation. That declaration is the first thing a reviewer checks.

---

## 5. Additive Sync, Immutable History

Content behind the anchor is **immutable**. Syncs are strictly additive.

Only turn pairs added since the last anchor are processed on a regular sync. Deduplication at the vector push layer ensures scenes are never re-embedded on repeat calls. Code that reprocesses committed history is a bug. The only legitimate full-reprocess operations are user-initiated: **Purge & Rebuild**, and the **Healer** (which restores to a specific prior anchor, not re-derives from scratch).

---

## 6. Label Everything — Filtering is the Consumer's Right

Everything CNZ produces is labeled so that its consumers can decide what to act on. The producer labels; the consumer filters. That separation is the principle.

For data written to shared systems — message metadata, vector collections, lorebook fields, filenames — the label is a consistent CNZ namespace. CNZ filters in by it to find exactly its own content; external systems filter out by it to exclude CNZ's content from their pipelines. A write without the label means CNZ may not find its content again. A pipeline that ignores the label may act on content it does not own. Injection control follows from this: because CNZ's retrieval content is labeled as CNZ's, CNZ is responsible for when it is used — external pipelines must not touch it without invitation.

For messages surfaced to the user, the label is severity. Errors are never filtered — if something failed, the user is always told. Informational and status messages are a different class and must be suppressible; a power user should be able to run CNZ silently except when something actually goes wrong. Warnings about genuine state ambiguity sit closer to errors than to noise and should err on the side of surfacing.

---

## 7. Every Channel is Independently Toggleable

CNZ operates through three content channels — Hookseeker, Lorebook, and RAG — plus a scheduling layer that drives them. Each channel is a distinct concern and must be disableable independently without breaking the others. CNZ itself must be disableable: when off, it should be as if it is not there.

This is a design constraint, not a convenience feature. A user who wants narrative hooks but not lorebook management should get exactly that. A user who wants lorebook sync but not RAG should get exactly that. Channels must not depend on each other at runtime, and disabling one must never silently corrupt another.

---

## 8. Every Anchor Component Carries Identity

CNZ assigns a unique identifier to every artifact it writes into shared storage — lorebook entries, RAG chunks, narrative hooks, VectFox vector records. When the healer restores state, it uses these identifiers to locate exactly the content belonging to the target anchor — and nothing else. Without per-component identity, healing would have to guess at boundaries, overwrite indiscriminately, or leave stale content from prior sessions mixed in. The identifier is the link between a stored artifact and the anchor that owns it.

---

## 9. The Healer Restores Completely — It Does Not Re-Derive

The healer fires in three situations: a chat is loaded or switched to; the chat position has moved backward (swipe, delete, rollback); or a new chat is started for a character that has an existing session. In each case its job is to return world state to a coherent match with the current chat position.

Restoration must be complete. Every channel that is enabled must be fully restored to the state recorded in the relevant anchor, in a manner consistent with that channel's current configuration. A partially restored state is not a valid state.

The healer does not synthesize or infer — it does not re-run any AI pipeline. For channels whose state is fully embedded in the anchor, restoration is a direct read-and-write. For channels whose state lives outside the anchor — RAG files in external storage — restoration requires reconciling that external state against what the anchor says should be there. When the healer finishes, the system is in a clean, coherent state and ready for normal operation.

The identifier also defines the boundary of every healing operation. A heal scopes in to all artifacts that belong to the target anchor and scopes out everything that does not. Content from other characters or sessions is never touched; nothing belonging to this anchor is missed.

---

## 10. Every Module is Self-Describing

Every source file opens with a structured preamble declaring:

- Its architectural role (Pure / Stateful / IO, and what it owns or does)
- Its public API surface (what it exports and what those exports do)
- Its contracts (what it reads, what it writes, what it must never do)
- A timestamp marking the last intentional architectural change

This preamble is not documentation for documentation's sake. It is a forcing function. A module whose role cannot be stated clearly in a preamble has not been designed clearly enough to be implemented. Write the preamble first.

Example form:

```javascript
/**
 * @file {path}
 * @stamp {utc timestamp}
 * @architectural-role {Pure | Stateful | IO} — {one line describing what this module owns or does}
 * @description
 * {Two to four sentences. What problem does this module solve? What is it not responsible for?}
 *
 * @api-declaration
 * functionName(args) — what it does and what it returns
 *
 * @contract
 *   assertions:
 *     purity:        {classification}
 *     state_ownership: [{domains owned, or none}]
 *     external_io:   [{services touched, or none}]
 */
```

---

## 11. Every File Has One Purpose and a Hard Size Limit

Every source file does exactly one thing. If a file is doing two things, it should be two files.

Any file touched in a session must be under 300 lines of code when the session ends. A file that cannot be brought under 300 lines without losing coherence is a file that has not been decomposed correctly. Split it first, then make the change.
