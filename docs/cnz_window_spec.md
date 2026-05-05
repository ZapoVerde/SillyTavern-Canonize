---

# CNZ Context Window Architecture
*How the system is meant to work*
*Current as of v0.9.37+*

---

## The Core Idea

CNZ runs silently in the background, periodically snapshotting the narrative into three places: the lorebook (structured world facts), the scenario anchor block (a prose summary of active threads), and the RAG document (searchable memory). It does this by watching the chat and firing when enough new turn pairs have accumulated. The main AI prompt only ever sees recent turns—older turns are replaced by the summaries and DNA Anchors CNZ has built.

---

## The Turn Budget
Every message in the chat is either a system message or a non-system turn. CNZ measures the story in **Turn Pairs** (1 User Message + all consecutive AI responses). The **Live Context Buffer** is a configurable number of the most recent turn pairs that are always kept out of sync processing—they stay in the main AI prompt unmodified. 

The **DNA Chain** tracks where the last sync ended. The **Gap** is the number of turn pairs between the most recent **Anchor** and the current Live Context Buffer boundary.

---

## When Syncs Fire

**Auto-sync** fires whenever the gap reaches `chunkEveryN` turns. If the gap is unusually large (more than twice the window size), CNZ runs a standard window sync first, then offers the user the option to also canonize the remaining older turns.

**The wand button** gives the user manual control. If the gap is smaller than a full window, it opens the review modal directly — there is nothing new to canonize. If the gap is exactly one window, it runs a sync and then opens the modal. If the gap is larger, it asks the user whether to cover the full gap or just the standard window.

---

## Window Modes

- **Standard Window:** Syncs from the current **DNA Chain Head** forward by exactly `chunkEveryN` turn pairs. If the gap is larger than the window, the remaining turns stay uncommitted until the next sync cycle.
- **Full Gap:** Syncs all uncommitted turn pairs from the DNA Chain Head up to the live context buffer boundary. This is the preferred choice for "catching up" after a long session.

In both modes, a new **DNA Anchor** is embedded in the chat at the end of the sync. Multiple overlapping nodes on the same turn are impossible, as the gap calculation always reads the DNA Head fresh before firing.

---

## What a Sync Does

A sync takes the uncommitted gap turn pairs and executes three tasks in parallel:
- **Hookseeker:** Reads the gap plus a lookback into the most recently committed turns for continuity, writing a prose summary into the Character Scenario.
- **Lorebook Sync:** Audits the transcript against the pre-sync lorebook (the snapshot in the **Parent Anchor**) and applies updates directly to the lorebook file.
- **RAG:** Splits the gap into chunks, classifies them with semantic headers, and uploads the result as a character attachment.

**The Commit:** When all three complete, a **DNA Anchor** is written into the metadata (`message.extra.cnz`) of the last AI message in the sync window. This Anchor stores the complete world-state snapshot.

---

## The DNA Chain & The Healer

The DNA Chain is the sequence of Anchors embedded directly in the chat JSONL. This makes branch detection straightforward: the **Healer** walks the chat array and verifies the lineage of each Anchor. 

If a message containing an Anchor is swiped or deleted, the chain is broken. The Healer detects this "divergence," identifies the last valid Anchor, and restores the Lorebook and Hooks to that specific point in history.

---

## The Review Modal

The modal is a correction tool. By the time it opens, the sync has already written the DNA Anchor to the chat. The modal shows the user the diff between the **Head Anchor** (post-sync) and the **Parent Anchor** (pre-sync).

On **Finalize**, the engine patches the **existing Head Anchor in the chat message**. No new anchor is written for modal corrections; the world-state snapshot inside the message metadata is simply updated to match the user's manual fixes.

---

## 7. The Context Mask

The Context Mask is a passive filter that ensures the AI never sees "Canonized" turns as raw text. Instead of modifying the assembled prompt, CNZ acts at the source: it marks messages in the chat array as "Ignored" before the prompt is even built. 

This native integration ensures that System instructions, Persona data, and World Info can be added by SillyTavern without interfering with the mask's precision. The mask always leaves the most recent turn pairs (the Live Buffer) visible to the AI.

---

## What Lives Where

- **On Disk:** The Lorebook `.json` file, the Character Scenario (containing Hooks), and the RAG attachment `.txt` files.
- **In Chat (Metadata):** The **DNA Chain** (Anchors and Links) embedded in `message.extra.cnz`.
- **In Memory:** Staged corrections, the `_draftLorebook`, and the current session's `_ragChunks`. 

**Character Switch:** Everything in memory is cleared. The next character load bootstraps fresh by reading the DNA Chain from the new chat file.
