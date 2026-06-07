# The Review Wizard

Canonize never writes permanently to your world-state without your consent. When a sync cycle completes (automatically or by clicking the book icon in the toolbar), the Review Wizard appears and walks you through four steps.

---

## Step 1: Narrative Hooks Workshop

Review the updated rolling summary of your story.

- **Workshop tab** — Diff view. Words added by this sync are highlighted green; deleted/edited words are red. Editable directly.
- **New tab** — Raw AI output for this cycle.
- **Old tab** — The summary as it was before this sync.
- **Regenerate** — If the AI missed something, edit the text or hit Regenerate to let it take another pass.

---

## Step 2: Lorebook Workshop

Review and approve updates to your world knowledge database.

- **Ingester tab** — Suggestions presented one-by-one. The dropdown lists all proposed modifications marked with:
  - `✓` Applied/Approved
  - `✗` Rejected
  - `✖` Deleted
- **Editor fields** — Edit Name, Search Keys, and Content directly before approving.
- **Verdict buttons:**
  - **Apply** — Confirms the suggestion is ready to save.
  - **Reject** — Reverts to pre-sync state (or prevents creation if new).
  - **Delete** — Marks the entry for deletion from the lorebook.
  - **Latest / Prev** — Load the raw AI suggestion or previous disk copy into the editor.
  - **Regenerate** — Runs a targeted AI query for this individual card only.
- **Targeted Concept Generator** — Type a name or term and click Generate to force the AI to write a new entry immediately.
- **Freeform tab** — All approved suggestions merged into a single scrollable block for rapid proofreading.

---

## Step 3: Narrative Memory Workshop

Review how your older messages are being archived.

- **Sectioned tab** — Chat split into individual RAG chunks. Each chunk has an editable title (the AI-generated classification, e.g. *"The group discussed plans to breach the old tower"*). Click the refresh icon next to any card to re-classify it.
- **Raw tab** — Final combined document as it will be formatted in the background database.

---

## Step 4: Finalize and Commit

Summary of everything about to be written:

- Preview of updated Narrative Hooks.
- Count of lorebook entries to be updated or created.
- Count of memory chunks to be written to the database.

Click **Confirm** to execute. A receipt list confirms when prompts, files, and chat logs are successfully written and locked into the chronology chain.
