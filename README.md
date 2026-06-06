# Canonize

**[Unreleased]**

This documentation introduces you to the Canonize narrative engine, explaining its core purposes, features, installation, and underlying mechanics in clear, plain language.

---

### The Purpose of This Extension

As text conversations with artificial intelligence grow longer, they inevitably face a critical bottleneck: memory capacity. Standard AI models have a limited "context window" (the maximum amount of text they can remember at one time). 

To prevent the AI from forgetting earlier events, chat applications traditionally send the entire conversation history with every new message. This brute-force approach introduces three severe challenges: exponential financial costs, attention dilution (causing the AI to ignore its system prompt), and narrative repetition.

Canonize resolves these challenges by actively archiving older parts of your story into a highly organized, multi-tiered memory system. By keeping the active chat history sent to the AI relatively short, the extension optimizes your chat sessions across three core pillars:

#### 1. Operational Economy
In standard long-context chats, your costs scale linearly. A chat of hundreds or thousands of messages means paying for a massive block of raw tokens on *every single turn*. Canonize maintains a short, sliding active window (for example, the last 8 to 10 turn pairs) [3]. Because the active context size remains small and predictable, **your token usage and costs are kept to a tiny fraction of their original size, even in chats spanning thousands of messages.** 

#### 2. High Prompt Adherence
Large Language Models suffer from an attention limitation known as the "Lost in the Middle" phenomenon [1]. When forced to read massive, unpruned chat logs, the model's attention is diluted [1]. It frequently ignores system prompts, overrides character card instructions, and lapses into repetitive prose or formatting errors. By keeping the active context window uncluttered, **your system cards, formatting presets, and instruction sets remain in high-attention zones, ensuring the AI maintains sharp adherence to its instructions [1].**

#### 3. Clutter-Free, Relevant Context
Instead of forcing the model to read exhaustive, chronological history, Canonize utilizes a hybrid retrieval model. It maintains situational awareness through a rolling narrative summary, tracks active character motivations through relationship goals, and queries an embedded vector database to inject past events **only when they are semantically relevant to what you are currently writing.** This eliminates narrative noise while ensuring the AI retains high-fidelity memory of established facts and plot threads.

---

### Key Features

*   **Continuous Story Summarization:** The system reads new stretches of your chat and condenses them into a highly structured, rolling summary. This summary is placed directly into the AI's mind, keeping it constantly aware of where the characters are physically and emotionally, what they intend to do next, and what plot threads remain unresolved.
*   **Dual-Lane Lorebook Synchronization:** Fact-extraction is split into two specialized AI processes: a **General Curator** for places, things, and concepts, and a dedicated **People Curator** for tracking character relationships, physical appearances, and individual character motivations. 
*   **Dynamic World Knowledge Retrieval:** The extension automatically extracts new facts, character descriptions, and locations as they are introduced in the story. It saves these details directly into standard SillyTavern lorebooks, ensuring they are only retrieved when relevant keywords are used in the active chat.
*   **Archived Conversation Memory (RAG):** Older conversation blocks are sliced, summarized, and indexed in a searchable background database. When you send a message, the system searches this database for semantically relevant past events (such as an emotional conversation that happened 200 messages ago) and feeds those specific memories back to the AI just in time.
*   **Timeline Recovery and Branch Guard:** If you decide to swipe to a different response, delete messages, or switch between different chats, the extension automatically detects the change. It rolls back your summary, lorebook state, and background memory to match that exact moment in time, preventing your database from being corrupted by abandoned plot paths.
*   **Clean, Complete Deactivation:** If you decide to turn the extension off, a single master switch halts all background schedulers, removes the control buttons from your user interface, and purges all custom prompts from the AI's execution list, leaving your chat environment entirely pristine.

---

### How to Install

Canonize is a standard SillyTavern extension. The Narrative Memory (RAG) system calls your configured embedding provider directly from the browser, which requires one configuration change in SillyTavern before installing.

**Prerequisites**

*   **Cloud embedding providers only:** If you are using a cloud embedding provider (OpenAI, OpenRouter, Voyage AI, etc.), open `config.yaml` in your SillyTavern data directory and set `allowKeysExposure: true`, then restart SillyTavern. If you are using a local provider (Ollama, llama.cpp, vllm), skip this step — no key is involved.

    This setting is required because Canonize calls the embedding API directly from your browser rather than through SillyTavern's built-in vector proxy. The direct call is necessary to receive similarity scores, which Canonize uses to filter results by relevance. SillyTavern's proxy returns only ranked results without scores, so it cannot be used here. There is an [open issue](https://github.com/SillyTavern/SillyTavern/issues/5729) to expose scores through the proxy; once that ships, this requirement will be removed. The key is read from SillyTavern's own secret store at call time and is used solely for embedding requests — your LLM API key is never touched. Canonize does not store or forward keys.

**Installation**

1.  **Open Extensions Menu:** Open your SillyTavern interface, click the Extensions icon (the puzzle piece), and select the option to install an extension from a URL.
2.  **Provide the Link:** Paste the web address of this repository into the input field and click the install button.
3.  **Refresh Your Browser:** After installation, reload your browser page. You will see a new book-shaped sync icon appear in your chat toolbar and a new configuration panel inside your extensions drawer.

---

### Deep Dive: How It Works

To keep costs low while maintaining high fidelity, the engine organizes your story's history into four distinct layers. This approach mimics human memory, which separates immediate attention from long-term memory, factual knowledge, and situational awareness.

#### 1. The Four-Tiered Memory Model

When you send a message, the AI's context window is populated by these four structured layers:

*   **Immediate Attention (The Active Window):** This is the live, uncompressed chat buffer containing only your most recent messages. Keeping this window short keeps your active token costs low and prevents the AI from becoming repetitive.
*   **Situational Awareness (The Narrative State):** This is a structured summary placed above your active chat history. It acts as the AI's "short-term memory," telling it exactly what is currently happening, what characters want, what secrets are still active, and where the story is headed. This summary is updated periodically in the background.
*   **Durable Knowledge (The Lorebook):** This layer stores static, referenceable facts about the world, such as character descriptions, item properties, and locations. It is managed via SillyTavern's native world info system, meaning these details are only loaded into the AI's mind when specific keywords are mentioned in the active window.
*   **Associative Recall (Archived Memory):** Older conversations are stored in a searchable background database. When you type a message, the system analyzes its emotional and thematic meaning, searches the database for similar moments in the past, and injects those retrieved memories as brief, archived notes. This allows the AI to recall past events with surprising accuracy, even if they happened thousands of turns ago.

#### 2. The Chronology Tracker

To coordinate these memory layers without manual effort, the extension uses a system of invisible markers placed directly inside your chat messages. 

Think of these markers as "save states." Each time a synchronization cycle runs, the extension stamps your last message with a unique marker containing a complete snapshot of your lorebook and narrative summary at that exact moment. 

#### 3. Seamless Timeline Synchronization

In creative roleplay, users frequently explore different narrative paths by deleting messages, editing past turns, or swiping for alternative AI replies. In standard systems, this can cause background databases to become out of sync, filling your character's memory with details from abandoned timelines.

The chronology tracker solves this problem:
*   Every time SillyTavern loads a chat or registers a message change, the extension scans the active chat for the latest valid progress marker.
*   If it detects that you have edited or rolled back the conversation, it identifies the divergence.
*   It immediately alerts you and rolls back your active lorebook and narrative summary to match that specific historical marker. 

This ensures your character's active world, relationship states, and memories always remain aligned with your current story timeline, providing a smooth and worry-free writing experience.

---

### Appendix A: The People Curator Feature

Unlike static world info entries (like a town name or magic sword), characters are dynamic. They change their clothes, update their motivations, and form complex relationships with you over time. 

To handle this, Canonize implements a **Dual-Lane Lorebook Synchronization** model. When a synchronization runs, two separate prompts are processed:
1.  **The General Curator Lane:** Extracts updates and creates records for `#place`, `#thing`, and `#concept` categories. It ignores people entirely to avoid formatting noise.
2.  **The People Curator Lane:** Deals exclusively with `#person` categories. It evaluates the dialogue, actions, and subtext of the recent conversation to update character profiles.

#### 1. Category Tagging (MECE System)
To prevent organizational chaos, Canonize assigns a single category tag to every single lorebook entry:
*   `#place` — A location, building, geographic feature, or region.
*   `#thing` — An object, item, creature, or physical material.
*   `#concept` — A faction, magic system, organization, or historical event.
*   `#person` — A character or individual.

Additional tags (like `#deceased`, `#King's_Household`, or `#ally`) can be added freely by the AI, but the core category tag is strictly enforced to ensure entries are routed to the correct lane.

#### 2. Surface NPCs vs. Full Treatment Tiers
The People Curator automatically tiers characters based on how prominent they are in the story:
*   **Surface NPC:** For peripheral characters who are mentioned or appear briefly but have no major dialogue or dynamic relationship. The Curator writes a single paragraph describing their identity, role, and immediate physical appearance.
*   **Full Treatment:** Triggered automatically when a character recurs, engages in meaningful dialogue, or develops a closer relationship with you. The Curator upgrades the entry into four distinct, structural subheadings:
    *   `## Appearance` — Physically inherent traits (height, natural hair color, scars, facial features) that do not change. Clothes, current injuries, and temporary hairstyles are excluded.
    *   `## Personality` — Evaluated on 3 to 5 polar spectrum axes (e.g., *Warm ↔ Guarded: Leans guarded—slow to trust, but fiercely loyal once earned*).
    *   `## Relationship with {{user}}` — A paragraph of continuous prose focusing purely on their *current* emotional stance, the power dynamic, active tensions, or trust level. It avoids narrating past events.
    *   `## Goals` — Tracks character agency. It defines **one major goal** (core long-term drive) and **exactly three minor goals** (immediate, short-term plans or concerns). 

#### 3. Automatic Upgrades & Duplicate Merging
*   **Dynamic Upgrades:** If a Surface NPC undergoes a meaningful interaction in the chat, the People Curator automatically rewrites them into the structured "Full Treatment" format on the next sync.
*   **Conflict Resolution:** If the General Curator detects a new name and tentatively creates a basic record for them, the sync pipeline's *Reconciliation Step* catches this, scraps the redundant general entry, and hands the character over to the People Curator to draft a proper `#person` profile.
*   **Duplicate Merging:** If the AI inadvertently creates two separate cards for the same character under different names (like an alias), it will automatically merge their content into the primary entry and tag the redundant entry with `**dup** — duplicate of [Name]` so you can easily clean it up.

---

### Appendix B: Settings and Configuration Guide

You can access the settings panel by opening the Extensions Drawer in SillyTavern and locating the **Canonize** section.

#### 1. General Panel
*   **Enable Canonize:** Master switch. Turning this off cleans your prompt stack, detaches all background listeners, and removes the toolbar button.

#### 2. Profile Management
Canonize supports multiple setting profiles (e.g., a "Low Cost" profile for cheap models, or a "High Fidelity" profile for complex roleplays):
*   **Profile Dropdown:** Select which profile is currently active.
*   **Save Profile (Floppy Disk icon):** Saves your current settings changes to the active profile. An asterisk (`*`) next to the profile name indicates unsaved changes.
*   **Add Profile (+ icon):** Create a new profile cloned from your current settings.
*   **Rename Profile (Pencil icon):** Renames the active profile.
*   **Delete Profile (Trash icon):** Deletes the active profile.

#### 3. CNZ Timing Settings
*   **Live Context Buffer:** The number of recent turn pairs (1 user + all AI replies = 1 pair) that are left uncompressed [3]. These are never summarized, allowing the AI to read your immediate back-and-forth in full detail. Default is `5`.
*   **Pairs Between Updates:** The interval of new conversation pairs that must pass before a sync cycle is triggered. Also defines your synchronization window size. Default is `20`.
*   **Summary Horizon:** The amount of conversation history fed to the AI when updating your rolling Narrative summary. Default is `40`.
*   **Lorebook Sync Start:** 
    *   *From sync point:* The AI only scans the newly added conversation block since the last save point.
    *   *From latest turn:* The AI scans the entire horizon. This is slower and more expensive but helps catch missed details.

#### 4. Connections & Prompts
*   **Summary Connection Profile:** Select a specific Connection Manager profile to run background summarization and lorebook syncs. This allows you to offload background tasks to a cheaper model, leaving your main chat model unburdened. Leaving this blank defaults to your currently selected chat model.
*   **Edit Prompts:** Opens a prompt editor for your *Summary*, *Lorebook*, *People*, and *Targeted* prompts.
*   **Reset All Prompts to Default:** Discards all custom prompt text and restores the built-in defaults for every prompt in this section.

#### 5. Narrative Memory (RAG) Settings
RAG is always active when Canonize is enabled. No separate toggle is required.

*   **RAG Contents:**
    *   *Summary + Full Content:* Retrieves the AI's summarized header of an event plus the actual dialogue. Recommended.
    *   *Summary Only:* Retrieves only the brief past tense summary of the event.
    *   *Full Content Only:* Retrieves the raw dialogue text only.
*   **RAG Connection Profile:** The model profile used specifically for chunk classification.
*   **Chunk Size (pairs):** How many turn-pairs are compressed into each RAG archive block. Default is `2`.
*   **Chunk Overlap:** Adds overlapping turn-pairs between adjacent chunks to ensure transition scenes aren't cut in half.
*   **Simultaneous Calls:** The maximum number of background AI classification calls allowed to run at once.
*   **Embedding Source / Model:** Select the provider (OpenRouter, OpenAI, Voyage AI, local Ollama, etc.) and model name used to generate embedding vectors. Canonize calls this provider directly using your stored API key.

**Retrieval Tuning**

Canonize uses a distributional cutoff rather than a fixed result count. On each turn it computes the cosine similarity of all stored vectors against the current query and returns everything above the mean — clamped to the bounds you set. If nothing clears the threshold, at least the minimum number of results is returned.

*   **Chat Min / Max:** Floor and ceiling for the number of narrative memory chunks injected per turn.
*   **LB Min / Max:** Floor and ceiling for the number of lorebook entries activated via semantic search per turn.
*   **Plot Min / Max:** Floor and ceiling for plot lorebook arc entries retrieved per turn.
*   **Unicode FTS:** By default, keyword matching strips non-ASCII characters, optimizing for English. Enable this if you roleplay in a non-Latin language (French, German, Russian, etc.) so that text is preserved correctly in the keyword index. The semantic embedding lane is unaffected by this setting.

#### 6. Admin and Utilities
*   **Verbose Logging:** Outputs detailed background execution logs to your browser console.
*   **Inspect Chain:** Opens the **DNA Chain Inspector** to view your save-state timeline.
*   **Rebuild RAG:** Re-embeds all stored chunks and lorebook entries for the active chat, rebuilding the cache from scratch. Use this after switching embedding providers or models, or if the cache file is missing or corrupt. Does not affect your chat history.
*   **Purge RAG:** Deletes all RAG data for the active chat, including vectors and chunk metadata. The cache will be rebuilt automatically by the healer on next load.

**RAG Cache File**

To avoid re-embedding the same content on every session, Canonize writes a cache file named `cnz_store_<chatname>.json` to your SillyTavern user files directory. One file is created per chat. These files are disposable — if deleted, Canonize will silently rebuild them from your chat history on next load at the cost of one embedding pass. You can safely delete them to reclaim disk space or to force a clean re-index.

**Health Telemetry**

Each generation turn appends one row per retrieval channel to `cnz_rag_health.csv` in your SillyTavern user files directory. Columns include the embedding provider and model, candidate count, max/min/mean cosine scores, slope, items returned, and whether the result ceiling was hit. Open this file in any spreadsheet application to inspect retrieval quality over time.

---

### Appendix C: How to Use the Review Wizard

While Canonize works quietly in the background, it never writes permanently to your character's world-state without your consent. When a synchronization is triggered (either automatically or by clicking the **Run Canonize** book icon in your extensions toolbar), the **Review Wizard** appears.

The wizard guides you through a 4-step check:

#### Step 1: Narrative Hooks Workshop
This step lets you review the updated rolling summary of your story.
*   **Workshop Tab:** Shows a comparison. Words added by the new sync are highlighted in green; deleted/edited words are highlighted in red. You can edit this text box directly.
*   **New Tab:** Shows the raw summary output generated by the AI this cycle.
*   **Old Tab:** Shows the summary as it was *before* this sync started.
*   **Regenerate Button:** If the AI missed an important plot point, you can rewrite the summary or hit Regenerate to let the AI take another pass.

#### Step 2: Lorebook Workshop
This is where you review and approve updates to your world knowledge database.
*   **Ingester Tab:** Displays suggestions one-by-one. The dropdown at the top lists all suggested modifications, marked with icons:
    *   `✓` (Applied/Approved)
    *   `✗` (Rejected)
    *   `✖` (Deleted)
*   **The Editor Fields:** You can manually edit the entry's Name, Search Keys, and Content box.
*   **Verdict Buttons:**
    *   `Apply` (Approve): Confirms the suggestion is ready to save.
    *   `Reject`: Reverts the entry to its pre-sync state (or prevents creation if it was new).
    *   `Delete`: Marks the selected entry for deletion from your lorebook entirely.
    *   `Latest` and `Prev`: Instantly load either the raw AI suggestion or the previous disk copy into your editor.
    *   `Regenerate`: Runs a targeted AI query specifically for this individual card.
*   **Targeted Concept Generator (Lane 2):** If you want to force the AI to write a brand new entry for a term immediately, type the name of the concept in the text box at the bottom and click *Generate*.
*   **Freeform Tab:** Displays all approved suggestions merged into a single scrollable text block for rapid proofreading.

#### Step 3: Narrative Memory (RAG) Workshop
This step shows you how your older messages are being sliced and summarized for long-term database storage.
*   **Sectioned Tab:** Displays your text split into individual chunks. Each chunk has an editable title box containing the AI-generated classification (e.g., *"The group discussed plans to breach the old tower"*). You can edit these titles manually or click the refresh icon next to a card to re-classify it.
*   **Raw Tab:** Shows the final combined document exactly as it will be formatted inside the background search database.

#### Step 4: Finalize & Commit
The final summary step. It lists:
*   A preview of your updated Narrative Hooks.
*   The total number of lorebook entries that will be updated or created.
*   The number of memory chunks about to be written to your database.
*   **Confirm:** Click this to execute the saves. A list of receipts will output showing you exactly when your prompts, files, and chat logs are successfully written and locked into the chronology chain.