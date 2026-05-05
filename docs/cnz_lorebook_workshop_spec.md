# CNZ Lorebook Workshop — Specification
*Authoritative reference for how the lorebook workshop flows and behaves*
*Current as of v0.9.45*

---

## What the Workshop Is For

The lorebook workshop is a correction tool. By the time it opens, the sync
has already committed its lorebook changes to disk. The workshop shows the
user what was committed this cycle and lets them correct anything that looks
wrong. If the user makes no corrections, Finalize writes nothing — the
committed state stands.

---

## When Things Get Written

The Lorebook state is modified at exactly two points:

1.  **During Sync:** The background AI call runs and automatically applies its suggestions to the active Lorebook `.json` file. Simultaneously, it commits a **DNA Anchor** to the last AI message of the sync window. This Anchor stores a complete snapshot of the world-state *as it exists at that moment*.
2.  **During Finalize:** If the user makes corrections in the Workshop (editing names, keys, or content), those changes overwrite the Lorebook `.json`. Crucially, the **Head Anchor** in the chat is patched in-place to reflect these manual corrections.

Everything the user does between these two points lives in memory only.


---

## The Diff Baseline

Every diff in the workshop compares the current editor state against the **Parent Anchor**—the world-state snapshot embedded in the chat message *preceding* the current sync block.

This Parent Anchor is the definitive record of what the Lorebook looked like before the AI made its changes. It is stable and survives page reloads or swipes, ensuring that diffs remain consistent even if you return to the Workshop mid-session.

---

## The Editor and Freeform Are Always Accurate

The editor and freeform are a live preview of the final disk state — what
Finalize will actually write. This invariant is maintained throughout:

- Unresolved suggestions show the AI-committed version
- Applied suggestions show whatever is currently in the editor
- Rejected suggestions show the pre-sync version (or empty for new entries)
- Deleted entries are absent from the editor content; the freeform shows a
  DELETE marker for visibility

Whenever a verdict is rendered (Apply, Reject, Delete), the suggestion
object's `name`, `keys`, and `content` fields are updated immediately so
that both the editor and the freeform serialiser always read correct state.

---

## Three-Lane Layout

The workshop has three lanes that all feed into one shared editor at the
bottom. Each lane is a different way of loading an entry into the editor.

**Lane 1 — Committed Sync Changes**
This lane features a dropdown populated with suggestions derived by comparing the **Head Anchor** (post-sync) against the **Parent Anchor** (pre-sync). 

Suggestions arrive as **Unresolved**. Even though the sync has already committed its changes to the Lorebook file, the Workshop treats every AI-touched entry as requiring a user verdict (Apply, Reject, or Delete) to ensure narrative accuracy.

**Lane 2 — Create a new entry**
A keyword input with a Generate button. Type a term, hit Generate, and a
targeted AI call creates a full entry for it. The result lands in the editor
as a new unresolved suggestion ready to review.

**Lane 3 — Update any existing entry**
A dropdown of every entry currently in the lorebook, not just the ones the
sync touched. Selecting one loads it into the editor. Use this for entries
the sync missed or that need a manual refresh. If the selected entry is
already in Lane 1, the two stay in sync. If it is not in Lane 1, it is
added so it gets tracked and appears in the freeform overview.

---

## The Shared Editor

One editor, shared across all three lanes. Whichever lane last loaded
something into it is the active context.

The editor has a live diff panel showing what has changed versus the
pre-sync baseline. Below that are the name, keys, and content fields.

**The content of these fields is the source of truth.** Whatever is in
the editor when Finalize runs is what gets written to disk. The engine
tracks every change to the editor in real time, so there is no separate
save step and no corrections can be lost.

---

## Two Button Groups

The ingester has two clearly separated button groups.

### Content-loading buttons

These change what is in the editor without rendering a verdict. They do
not resolve the suggestion.

**← Latest** — loads the most recent AI-generated version of this entry
back into the editor. Useful if you have been editing and want to start
from the AI output again. Disabled if the AI never generated anything for
this entry.

**← Prev** — loads the pre-sync version of this entry into the editor.
Disabled for brand new entries that did not exist before this sync. On a
deleted entry that has a prior version, ← Prev restores the content and
clears the deleted state — effectively un-deleting.

**Regenerate** — fires a fresh targeted AI call for whatever entry is
currently loaded. The result lands in the editor. The entry stays unresolved
so you can review the new output before committing.

### Verdict buttons

These render a final decision on the current suggestion. Apply, Reject, and
Delete are mutually exclusive — whichever verdict is currently active is
disabled; the others are enabled.

**Apply** — marks this suggestion as resolved. The editor content is
unchanged. Apply means "this looks right." Because the engine tracks editor
content in real time, Apply is purely a review marker.

**Reject** — Restores the entry to the version found in the **Parent Anchor**. This version is loaded into the editor and applied to the draft Lorebook. 
*   For **UPDATE** entries: The entry reverts to its pre-sync content.
*   For **NEW** entries: The entry has no prior version, so it is cleared from the draft entirely.
*   **Result:** Reject effectively means "The AI was wrong; put the world back the way it was."

**Delete** — removes the entry from the draft lorebook entirely and marks
the suggestion as resolved. The editor content is cleared. Delete means
"this entry should not exist." The freeform shows a DELETE marker for the
entry so the intended deletion is visible in the overview.

For brand new entries (no prior version), Delete and Reject behave
identically — both clear the content and remove the entry from the draft.

---

## Verdict State Matrix

| State | Apply | Reject | Delete | ← Prev |
|---|---|---|---|---|
| Unresolved | enabled | enabled | enabled | if prior exists |
| Applied | disabled | enabled | enabled | if prior exists |
| Rejected | enabled | disabled | enabled | if prior exists |
| Deleted | enabled | enabled | disabled | if prior exists |

← Prev on a deleted entry with a prior version clears the deleted state
and loads the prior content — the entry returns to unresolved. ← Prev
remains disabled for brand new entries regardless of state.

---

## Freeform Tab — Read-Only Overview

The Freeform tab shows a formatted read-only view of the full suggestion
list — every entry that has been created, updated, loaded from Lane 3, or
marked for deletion this session. It updates automatically as you work
through the Ingester.

Rejected entries are excluded from the freeform entirely.

Deleted entries appear as a DELETE marker:

```
**DELETE: [Entry Name]**
```

All other entries appear in the standard block format.

The Freeform tab is read-only. This ensures the displayed state always
matches what the engine is tracking.

The only action available from the Freeform tab is **Regen**, which fires
a full lorebook sync AI call and replaces the entire suggestion list with
fresh output. This is the escape hatch for when the whole batch looks wrong.
It asks for confirmation first because it discards any corrections already
made.

The Ingester tab is the default landing tab when the modal opens.

---

## Technical State Mapping

To maintain the DNA Chain, the Workshop reads and writes to the following memory/storage locations:

| Feature | Source of Truth |
| :--- | :--- |
| **"Before" Baseline** | Snapshot in the **Parent Anchor** (`message.extra.cnz`) |
| **"After" State** | Snapshot in the **Head Anchor** (`message.extra.cnz`) |
| **Staged Edits** | In-memory `_draftLorebook` object |
| **Final Commit** | Overwrites Lorebook `.json` and patches **Head Anchor** |

---

## How It Flows in Practice

**After a sync fires:**
The modal opens on the Ingester tab. Lane 1 is populated with everything
the sync committed, all unresolved. The first item is pre-loaded in the
editor. Step through the list using Next Unresolved — Apply anything that
looks right, Reject anything that should revert, Delete anything that
should not exist. When satisfied, move to Finalize.

**If the sync missed something:**
Use Lane 2 to generate a brand new entry for a term that should have been
captured. Use Lane 3 to load an existing entry that needs updating and
either edit it manually or hit Regenerate for a fresh AI take.

**If you want to cull an existing entry:**
Use Lane 3 to load it, then hit Delete. It will be removed from the draft
on Finalize and a DELETE marker will appear in the freeform overview.

**If the whole batch looks wrong:**
Switch to Freeform and hit Regen. Confirm the warning. The AI runs again
from scratch and the suggestion list is rebuilt.

**If you open the modal without a preceding sync:**
Lane 1 still shows the committed changes from the most recent sync cycle —
derived from the DNA chain, not from session memory — so the workshop is
always useful regardless of when it is opened.