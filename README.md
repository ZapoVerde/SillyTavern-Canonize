This documentation is designed to introduce you to the narrative engine, explaining its core purposes, features, installation, and underlying mechanics in clear, plain language.

---

### The Purpose of This Extension

As text conversations with artificial intelligence grow longer, they inevitably face a critical bottleneck: memory capacity. Standard AI models have a limited "context window" (the maximum amount of text they can remember at one time). 

To prevent the AI from forgetting earlier events, chat applications must send the entire conversation history with every new message. This approach introduces two severe challenges:
*   **Exponential Costs:** The financial cost of using AI is directly tied to the number of words (tokens) sent. As a chat grows to hundreds or thousands of messages, each reply becomes progressively and significantly more expensive.
*   **Degraded Quality:** When an AI's memory is saturated with massive amounts of raw chat history, it begins to lose focus. It may forget key plot points, lose track of character intentions, hallucinate details, or become repetitive.

This extension resolves these challenges. It acts as an automated assistant that dynamically archives older parts of your story into a highly organized, multi-tiered memory system. By keeping the active chat history sent to the AI very short (for example, only the last few messages), **your token usage and costs are kept to a small fraction of their original size, even in chats spanning thousands of messages.** 

At the same time, the extension ensures the AI maintains a deep, high-fidelity awareness of your story's emotional history, established facts, and overall plot trajectory.

---

### Key Features

*   **Continuous Story Summarization:** The system reads new stretches of your chat and condenses them into a highly structured, rolling summary. This summary is placed directly into the AI's mind, keeping it constantly aware of where the characters are physically and emotionally, what they intend to do next, and what plot threads remain unresolved.
*   **Dynamic World Knowledge Syncing:** The extension automatically extracts new facts, character descriptions, and locations as they are introduced in the story. It saves these details directly into standard SillyTavern lorebooks, ensuring they are only retrieved when relevant keywords are used in the active chat.
*   **Archived Conversation Memory:** Older conversation blocks are sliced, summarized, and indexed in a searchable background database. When you send a message, the system searches this database for semantically relevant past events (such as an emotional conversation that happened 200 messages ago) and feeds those specific memories back to the AI just in time.
*   **Timeline Recovery and Branch Guard:** If you decide to swipe to a different response, delete messages, or switch between different chats, the extension automatically detects the change. It rolls back your summary, lorebook state, and background memory to match that exact moment in time, preventing your database from being corrupted by abandoned plot paths.
*   **Clean, Complete Deactivation:** If you decide to turn the extension off, a single master switch halts all background schedulers, disconnects active database streams, removes the control buttons from your user interface, and purges all custom prompts from the AI's execution list, leaving your chat environment entirely pristine.

---

### How to Install

Canonize has two parts: a browser extension and a server plugin. **Both must be installed.** The extension alone will not work.

#### Part 1 — Install the Extension

1.  **Open Extensions Menu:** Open your SillyTavern interface, click the Extensions icon (the puzzle piece), and select the option to install an extension from a URL.
2.  **Provide the Link:** Paste the web address of this repository into the input field and click the install button.

#### Part 2 — Install the Server Plugin (Required)

The Narrative Memory (RAG) system requires a server-side plugin to manage the embedded vector database. This plugin ships inside the extension but **must be copied manually into SillyTavern's plugin directory.**

3.  **Locate the plugin files:** After the extension installs, find the `plugin` subfolder inside the Canonize extension directory:
    ```
    [ST extensions folder]/SillyTavern-Canonize/plugin/
    ```
4.  **Copy the plugin to ST's plugin directory:** Copy the entire contents of that `plugin/` folder into a new folder named `cnz` inside your SillyTavern `plugins/` directory:
    ```
    [ST plugins folder]/cnz/
    ```
    When done, the folder should contain: `index.js`, `embed.js`, `routes.js`, `db.js`, `rrf.js`, and `package.json`.

    **Docker users:** your ST plugins folder is the `st-plugins/` directory in your Canonize workspace (mounted as `/home/node/app/plugins` in the container). Create `st-plugins/cnz/` and copy the files there.

5.  **Install plugin dependencies:** Inside the `cnz` plugin folder, run:
    ```
    npm install
    ```
6.  **Restart SillyTavern:** The plugin only loads at server startup. Restart ST completely (not just a browser refresh).

#### Part 3 — Verify

7.  **Refresh Your Browser:** After ST restarts, reload your browser page. You will see a new book-shaped sync icon appear in your chat toolbar and a new configuration panel inside your extensions drawer. If you enable Narrative Memory (RAG) in the settings and the plugin is not installed, you will see a clear error rather than silent failure.

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