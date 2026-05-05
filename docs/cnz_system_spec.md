# CNZ System Architecture
*How the DNA Chain, AI calls, and RAG attachments fit together*
*Current as of v1.1*

---

## The Storage Model

Unlike traditional extensions that rely on external databases, CNZ treats the **SillyTavern Chat JSONL** as the primary database. This ensures that world state is perfectly synchronized with the narrative timeline.

**Embedded Metadata:** 
Every sync cycle commits an **Anchor** to the last AI message of the processed window. This Anchor (stored in `message.extra.cnz`) contains:
- The full Hookseeker prose summary.
- A complete snapshot of the Lorebook.
- References to the RAG files produced during that cycle.
- A unique cryptographic UUID for lineage tracking.

**Data Bank Attachments:**
The only external files CNZ manages are **RAG Documents** (.txt). These are uploaded to the SillyTavern Data Bank and registered as character attachments. They are named using a `cnz_[avatar]_[timestamp].txt` convention to allow for easy orphan detection.

---

## The DNA Chain

The DNA Chain is the chronological sequence of Anchors embedded in the chat. It serves two purposes:
1. **Context Masking:** The engine identifies the most recent Anchor (the "Head") and masks all messages prior to that point from the main AI prompt, replacing them with the Hookseeker summary and RAG retrieval.
2. **Lineage Verification:** Each Anchor can point to a `parentUuid`. By following these pointers, the Healer can verify if the current chat history is a continuous "Canon" timeline or if it has been altered.

---

## The Healer

The Healer runs automatically on character load or chat change. It performs a "Lineage Scan":
1. It reads the chat array and locates all embedded Anchors.
2. It verifies the Head Anchor: does the message it's attached to still exist at the expected position? Has the text been swiped?
3. If a divergence is found (a "Branch"), the Healer identifies the last valid Anchor.
4. **Restoration:** It hot-swaps the active Lorebook and Character Scenario (Hooks) with the snapshots stored inside that valid Anchor. It then reconciles the RAG attachments to ensure the Vector Index only contains memories from the valid timeline.

---

## Purge & Rebuild

The Purge & Rebuild utility (found in Settings) is the maintenance tool for the DNA Chain.
- **Orphan Cleanup:** It deletes RAG files in the Data Bank that are no longer referenced by any Anchor in the current chat.
- **Deep Rebuild:** It can scan the entire chat history for `cnz_chunk_header` metadata (stamps left on messages during prior syncs) and compile them into a single, optimized RAG document. This "defills" the Data Bank by replacing many small files with one master history file.

---

## AI Call Pipeline

CNZ utilizes a non-blocking, parallel execution pipeline for its three core tasks:

1. **The Hookseeker:** Analyzes the sync window (plus a narrative lookback) to produce a flowing prose summary of unresolved tensions and active plot threads.
2. **The Lorebook Sync:** Audits the transcript against the pre-sync lorebook to suggest updates or new entries.
3. **The RAG Classifier (Fan-Out):** A high-concurrency task that splits the sync window into chunks. Each chunk is sent to the AI to generate a 2–3 sentence semantic header. These headers are used by the vector engine to improve the accuracy of narrative retrieval.

---

## The Context Mask (Native Interceptor)
CNZ utilizes SillyTavern's native `generate_interceptor` API to manage the context window. This is a high-reliability, synchronous process:

1. **The Intercept:** Before SillyTavern builds the prompt, it calls `cnzMaskMessages`.
2. **Identification:** The engine performs a single pass on the chat array to locate the most recent **Head Anchor**.
3. **The Ignore Symbol:** CNZ marks every message from the start of the chat up to the Head Anchor using the SillyTavern `IGNORE_SYMBOL`. 
4. **Result:** SillyTavern’s internal prompt builder automatically skips these marked messages. This ensures that only the "Live Buffer" (uncommitted turns) is sent to the AI, keeping context usage minimal and preventing "Context Bloat."