
***

# CNZ Review Modal — Specification
*Authoritative reference for modal purpose, structure, and commit behaviour*
*Current as of v1.1*

---

## What the Modal Is For
The modal is a correction and review tool. By the time it opens, a background sync has already committed its output to the story: the lorebook has been updated, the narrative hooks are in the scenario, RAG chunks are in the Data Bank, and a **DNA Anchor** has been embedded in the chat. 

The modal allows the user to inspect these changes, edit the text, or regenerate specific parts. On **Finalize**, only the user's manual corrections are written back to the chat and disk. If no changes are made, Finalize performs no IO.

---

## Opening the Modal
The modal is opened via the **Wand Menu** or the sync completion toast. On open, it initializes its state by reading the **DNA Chain** from the current chat:

1.  **The Head Anchor:** The most recent `anchor` metadata found in the chat messages. This provides the "Current/After" state for the workshop.
2.  **The Parent Anchor:** The previous anchor in the chain. This provides the "Before" baseline used for diffing and the "Reject" fallback.
3.  **Concurrency Guard:** The UUID of the Head Anchor is captured as `_modalOpenHeadUuid`. If a background sync completes while the modal is open, the UUIDs will mismatch, and Finalize will block the save to prevent data corruption.

---

## Four-Step Wizard Flow

### Step 1 — Hooks (Scenario Summary)
Shows the **Hookseeker** prose summary written to the character's scenario.
*   **Workshop Tab:** An editable text area with a word-level diff showing changes against the **Parent Anchor**.
*   **New Tab:** A read-only view of what the most recent sync produced, featuring a **Regen** button to trigger a fresh AI summary.
*   **Old Tab:** A read-only view of the hooks text from the Parent Anchor.
*   **Reverts:** Buttons to quickly swap the workshop text with either the "Old" or "New" versions.

### Step 2 — Lorebook Workshop
A three-lane ingester for reviewing and staging lorebook changes.
*   **Lane 1 (Sync Results):** Automatically populated with suggestions derived from the diff between the Head and Parent Anchors.
*   **Lane 2 (Manual Generate):** Allows the user to type a keyword and trigger a targeted AI call to create a brand-new entry.
*   **Lane 3 (Existing Picker):** Allows the user to load *any* entry from the current lorebook into the editor for manual tweaking or regeneration.
*   **The Editor:** A shared space for editing Name, Keys, and Content. Edits are staged in a `_draftLorebook` in memory.
*   **Freeform Tab:** A read-only serialised overview of all staged changes (Updates, New entries, and Deletions).

### Step 3 — Narrative Memory (RAG)
Displays the chunk cards generated for the current sync window.
*   **Sectioned Tab:** Individual cards for each pair-window. Each card shows the Turn Range, the Dialogue (read-only), and the **Semantic Header** (editable). Users can **Regen** individual headers if they are inaccurate.
*   **Raw Tab:** Shows the full compiled `.txt` document. Editing here "detaches" the raw view from the cards, allowing for total manual control over the document structure.

### Step 4 — Finalize (Review & Commit)
A read-only summary of staged changes:
*   **Hooks Preview:** Displays the first 100 characters of the new summary.
*   **Lore Summary:** Counts how many entries are being created or updated.
*   **RAG Timeline:** Lists the filenames for Narrative Memory documents.

---

## The Commit Process (Finalize)
When the user clicks **Finalize**, the engine performs a "Surgical Patch":

1.  **Hooks:** If the workshop text differs from the character's current scenario, the scenario is patched.
2.  **Lorebook:** If the `_draftLorebook` differs from the on-disk lorebook, the `.json` file is overwritten.
3.  **RAG:** If headers were manually edited or the Raw tab was detached, a new `.txt` file is uploaded to the Data Bank and registered as an attachment.
4.  **The Anchor Patch:** The existing **Head Anchor** embedded in the chat message is updated in-place. Its internal snapshots of the Hooks and Lorebook are replaced with the user's corrected versions. **No new DNA Anchor or chat message is created.**

---

## State Persistence
*   **Engine State:** Data like `_ragChunks` and `_lorebookSuggestions` persist even if the modal is closed, as long as the character is not switched. This allows users to close the modal and return to their corrections later.
*   **UI State:** Tab selections, loading spinners, and error banners are reset every time the modal is closed to ensure a clean interface on the next open.

---

## State Sources (Truth Table)

| Panel | "Before" State Source | "After" State Source |
| :--- | :--- | :--- |
| **Hooks** | Parent Anchor `hooks` field | Character Scenario Text |
| **Lorebook** | Parent Anchor `lorebook` snapshot | Head Anchor `lorebook` snapshot |
| **RAG** | `cnz_chunk_header` message stamps | In-memory `_ragChunks` array |
| **Lineage** | Parent Anchor `uuid` | Head Anchor `uuid` |