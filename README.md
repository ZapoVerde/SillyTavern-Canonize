
***

### `README.md`

# 📜 Canonize for SillyTavern
### *The Autonomous Narrative Engine*

**Canonize** is a background continuity service designed to keep long-running stories coherent, lightweight, and immortal. Canonize works silently in the background while you write.

By extracting lore snapshots and building narrative memory (RAG) every 20 turn pairs, Canonize ensures your AI always has "The Long View" of the plot without the "Context Bloat" that causes slow responses and forgetfulness.

---

## ✨ Key Features

### 🛠️ The Dual-Window Engine
Canonize mimics human memory by splitting processing into two adjustable windows:
*   **The Fact-Finder (Short View):** Every 6-10 turn pairs, the AI audits your chat for new NPCs, items, and world-state changes, updating your Lorebook in real-time.
*   **The Hookseeker (Long View):** A sliding ~40 turn pair window that identifies "Open Loops," unresolved tensions, and character motivations. This is injected directly into your Character Scenario to keep the AI focused on the plot.

### 🧬 The DNA Chain (Chat-Embedded Memory)
Canonize treats your chat file as the ultimate database. Instead of cluttering your hard drive with external save files, every "sync" embeds a complete **World State Snapshot (Anchor)** directly into the hidden metadata of your chat messages.
*   **Lineage Tracking:** Because the memory lives inside the messages themselves, every timeline or branch intrinsically carries its own perfect history.
*   **The Healer:** If you jump to a branch, swipe, or rollback 30 turns, the Healer instantly detects the divergence by walking the chat's DNA Chain. It then automatically restores the Lorebook, Hooks, and Vector memories to exactly match that specific point in time. 

---

## 💡 What is a "Turn Pair"?
To ensure narrative consistency, Canonize measures the story in **Turn Pairs** rather than individual messages.
*   **1 Turn Pair = 1 User Message + all following AI Responses.**
*   By using pairs as the atomic unit, Canonize ensures that a "snapshot" never cuts off in the middle of an exchange, keeping the context of your prompts and the AI's reactions linked together.

---

## 🚦 How it Works

1.  **The Trigger:** Every 6-10 turn pairs (adjustable), Canonize fires a background sync.
2.  **The Sync:** 
    *   **Lore** is extracted and staged.
    *   **RAG Chunks** are built and summarized for Vector Storage.
    *   **Hooks** are updated in the character's scenario.
3.  **The Commit:** These changes are saved seamlessly into the **DNA Chain** embedded in your active chat file.
4.  **The Review (Optional):** Click the Canonize wand icon to open the **Review Modal** if you want to manually tweak the AI's findings. Otherwise, it just works.

---

## ⚙️ Configuration

*   **Sync Frequency:** Set how many turn pairs pass between background syncs.
*   **Hookseeker Horizon:** Adjust how far back the AI looks to track plot threads (Default: 40 turn pairs).
*   **Target Lorebook:** Designate a specific Lorebook for Canonize to manage.
*   **Connection Profiles:** Use a fast, cheap model for your chat and a "heavy-lifter" (like Claude 3.5 or GPT-4o) for the background Canonize syncs.

---

## 🛠️ Installation

1.  Open the **Extensions** menu in SillyTavern.
2.  Select **Install Extension**.
3.  Paste the URL of this repository: `[Your-Repo-URL]`
4.  Restart SillyTavern.

---

## 📜 Credits & Inspiration
Canonize was born from a desire to simplify the "Chapterize" workflow. 
*   Built on the UI foundations of **Chapterize** by ZapoVerde.
*   Refactored for **Autonomous State Management** and **DNA-Chained Lineage**.

---
*“Canonize your story. Let the engine handle the rest.”*