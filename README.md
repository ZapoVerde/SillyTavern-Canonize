
---

### `README.md`

# 📜 Canonize for SillyTavern
### *The Autonomous Narrative Engine*

**Canonize** is a background continuity service designed to keep long-running stories coherent, lightweight, and immortal. Unlike traditional "chapter" tools that force you to reset your chat or duplicate your characters, Canonize works silently in the background while you write.

By extracting lore snapshots and building narrative memory (RAG) every 20 turns, Canonize ensures your AI always has "The Long View" of the plot without the "Context Bloat" that causes slow responses and forgetfulness.

---

## ✨ Key Features

### 🛠️ The Dual-Window Engine
Canonize mimics human memory by splitting processing into two adjustable windows:
*   **The Fact-Finder (Short View):** Every 20 turns, the AI audits your chat for new NPCs, items, and world-state changes, updating your Lorebook in real-time.
*   **The Hookseeker (Long View):** A sliding 70-100 turn window that identifies "Open Loops," unresolved tensions, and character motivations. This is injected directly into your Character Scenario to keep the AI focused on the plot.

### ⛓️ The Narrative Ledger (Hash-Chaining)
Canonize treats your story like a blockchain. Every "sync" creates a **Milestone** tied to a unique cryptographic hash of your chat history.
*   **Lineage Tracking:** The Ledger knows exactly which memories belong to which timeline.
*   **The Healer:** If you jump to a branch or rollback 30 turns, the Healer detects the "DNA change" in the chat and instantly swaps your Lorebook and Vector memories to match that specific point in time.

### 🗄️ The Vault (Snapshots)
Stop worrying about "corrupting" your Lorebook. Canonize saves **World State Snapshots** to a private Vault. If you go back in time, your world building goes back with you. If you push forward, the world evolves.

### 🚀 Frictionless Workflow
*   **Stay on One Card:** No more `Character (Ch 2)` clones.
*   **Stay in One Chat:** No more "Start New Chat" resets.
*   **Background Processing:** AI calls happen while you type. A simple toast notification lets you know a sync is complete.

---

## 🚦 How it Works

1.  **The Trigger:** Every 20 turns (adjustable), Canonize fires a background sync.
2.  **The Sync:** 
    *   **Lore** is extracted and staged.
    *   **RAG Chunks** are built and summarized for Vector Storage.
    *   **Hooks** are updated in the character's scenario.
3.  **The Commit:** These changes are saved to the **Ledger** and the **Vault**.
4.  **The Review (Optional):** Click the toast notification to open the **Review Modal** if you want to manually tweak the AI's findings. Otherwise, it just works.

---

## ⚙️ Configuration

*   **Sync Frequency:** Set how many turns pass between background syncs.
*   **Hookseeker Horizon:** Adjust how far back the AI looks to track plot threads (Default: 70 turns).
*   **Target Lorebook:** Designate a specific Lorebook for Canonize to manage, keeping your static world-building safe from automated updates.
*   **Connection Profiles:** Use a fast, cheap model for your chat and a "heavy-lifter" (like Claude 3.5 or GPT-4o) for the background Canonize syncs.

---

## 🛠️ Installation

1.  Open the **Extensions** menu in SillyTavern.
2.  Select **Install Extension**.
3.  Paste the URL of this repository: `[Your-Repo-URL]`
4.  Restart SillyTavern.

---

## 🧠 Technical Note on "The Healer"
The Healer is the most powerful part of the Canonize architecture. It monitors the SillyTavern `CHAT_CHANGED` event. When a new chat or a branch is detected, it:
1.  Hashes the current message history.
2.  Locates the matching **Milestone** in the Ledger.
3.  **Hot-Swaps** the Lorebook JSON and moves the correct Vector `.txt` files into the active Data Bank folder.
4.  Restores the **Hookseeker** summary to match that timeline.

---

## 📜 Credits & Inspiration
Canonize was born from a desire to simplify the "Chapterize" workflow. 
*   Built on the UI foundations of **Chapterize** by ZapoVerde.
*   Refactored for **Autonomous State Management** and **Hash-Chained Lineage**.

---
*“Canonize your story. Let the engine handle the rest.”*