Yes, we should keep it, but it needs to be **re-centered**. 

While the `README` is for installation/marketing and the `System Spec` is for technical architecture, the **Overview** should describe the **Narrative Strategy**. It explains the "mental model" of how Canonize actually handles memory.

I've refactored this to focus on the **Three-Tier Memory Model** and updated all the terminology to match the 1.1 "DNA Chain" code.

***

### `docs/cnz_overview.md`

# CNZ — Narrative Strategy Overview
*How the engine manages story memory*
*Current as of v1.1*

---

## The Three-Tier Memory Model
Canonize replaces the standard "infinite scroll" of chat history with a tiered system designed to mimic human recollection.

1. **Tier 1: The Live Buffer (Short-Term)**
   The most recent ~5 **Turn Pairs** are never touched by Canonize. They stay in the AI's immediate context window exactly as written. This ensures the AI always remembers the *exact* wording of the current conversation.

2. **Tier 2: The Anchor (Mid-Term)**
   Everything behind the Live Buffer is "Canonized." The AI no longer sees the raw messages. Instead, it sees a **Hookseeker Summary** (active plot threads) and an updated **Lorebook** (facts about the world). This keeps the AI focused on the *meaning* of the story rather than the literal text.

3. **Tier 3: The Vault (Long-Term)**
   Turns that are hundreds of messages old are stored in **RAG Documents**. These are only "recalled" (injected into the prompt) if they are semantically relevant to what you are currently typing.

---

## The Sync Lifecycle
Canonize operates on a "Snapshot" logic. It doesn't process one message at a time; it waits for a meaningful chunk of story to accumulate.

### 1. The Trigger
The **Scheduler** watches the chat. Every time you complete a **Turn Pair** (User + AI), it checks the "Gap"—the number of pairs between your last saved **Anchor** and your **Live Buffer**. When that Gap hits your limit (Default: 20), a sync fires.

### 2. The Three-Lane Sync
A Sync happens in the background while you continue to type. It runs three AI calls in parallel:
*   **Hookseeker:** Rewrites the scenario summary to include the events of the last 20 pairs.
*   **Lorebook Sync:** Updates facts (e.g., "The ship is now damaged," "NPC X is now dead").
*   **RAG Classifier:** Summarizes the 20 pairs into searchable memory "chunks."

### 3. The Commit (The DNA Chain)
When the sync finishes, it "pins" the world state. It embeds an **Anchor** directly into the last message of the sync window. This Anchor stores the Lorebook and Hooks snapshots. 

---

## The DNA Chain & The Healer
Because the history of the world is embedded directly in the chat messages, the "Ledger" is part of the chat itself.

*   **Timeline Immunity:** If you branch a chat or delete messages, the DNA Chain is physically broken at that point. 
*   **Automatic Healing:** When you load a chat, the **Healer** scans the messages. If it sees that your current "Canon" doesn't match the last saved Anchor (because you swiped or deleted), it instantly rolls back your Lorebook and Hooks to the last valid point. 

---

## The Context Mask

This is the "Passive Filter" of the engine. Once a sync is committed, CNZ uses a native SillyTavern interceptor to mark canonized messages as "Ignored." 

The AI is "tricked" into thinking the story started at the current Anchor, but it arrives at that starting point with full context thanks to the injected Hooks and Lorebook data. By using the native ST "Ignore" mechanism, the mask is indestructible—it doesn't care if you are on a phone or a PC, or how many other extensions you have active.

---

## Summary of State
*   **Persistent Data:** Lorebook files and Character Scenario (Scenario is the primary "anchor" for Hooks).
*   **Timeline Data:** Anchors and Links embedded in `message.extra.cnz`.
*   **Long-term Data:** `.txt` files in the Data Bank (Character Attachments).
*   **Ephemeral Data:** The **Review Modal** stages changes in memory. Nothing is "final" until you click **Finalize**, which patches the current Anchor in the chat.