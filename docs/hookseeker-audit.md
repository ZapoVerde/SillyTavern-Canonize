# Hookseeker Audit Guide

Where things live and how to check them without burning tokens on exploration.

---

## Data locations

### Chat JSONL
```
st-data/default-user/chats/{char_name}/{chat_file}.jsonl
```
One JSON object per line. Line 1 is `chat_metadata`. All subsequent lines are messages.

### Hookseeker default prompt
```
SillyTavern-Canonize/defaults.js  line ~115
DEFAULT_HOOKSEEKER_PROMPT
```
Three-part output format: EVENTS table, SCENE prose, optional **NEW:** plot entries.

### Hookseeker output parser
```
SillyTavern-Canonize/core/hookseeker-output.js
parseHookseekerOutput(rawText) → { scene: string, entries: PlotEntry[] }
```
Note: `scene` returned here is only the SCENE block. The full raw output (including EVENTS table) is stored verbatim in the DNA anchor — see below.

### Sync pipeline entry point
```
SillyTavern-Canonize/core/sync.js
runCnzSync(char, messages, { coverAll })
```
Hookseeker runs as Lane 2. The raw output goes to `processSceneUpdate(scene)` (writes CNZ Summary prompt) and `appendAndIndexPlotEntries(entries, ...)` (writes plot lorebook).

---

## Finding anchor turns in the chat

DNA anchor turns have `extra.cnz.type === 'anchor'`. They are placed on the **last AI message** of each sync window. Filter with:

```python
import json

with open('chat.jsonl') as f:
    lines = f.readlines()

for i, line in enumerate(lines):
    msg = json.loads(line)
    cnz = msg.get('extra', {}).get('cnz', {})
    if cnz.get('type') == 'anchor':
        print(f"T{i+1}: committed {cnz['committedAt']}")
```

### What the anchor contains

| Field | Content |
|-------|---------|
| `scene` | **Full raw hookseeker output** — EVENTS table + SCENE prose (not just scene). Verbatim from the LLM. |
| `plotEntries` | List of `{ uid, comment, content }` — entries written to the plot lorebook this sync. |
| `ragHeaders` | List of `{ chunkIndex, header, turnRange, pairStart, pairEnd }` — one per RAG chunk in the window. |
| `lorebook` | Full lorebook snapshot at commit time. |
| `parentUuid` | UUID of the previous anchor (chain linkage). |

---

## Finding chunk header turns

RAG chunk summaries are written to the **last AI message of each chunk window** (different from the DNA anchor turn — every chunk gets one, the DNA anchor covers the whole sync window).

Filter: `msg.extra.cnz_chunk_header` is truthy.

| Field | Content |
|-------|---------|
| `extra.cnz_chunk_header` | Prose summary of the turns in this chunk. Used for RAG embedding. |
| `extra.cnz_turn_label` | Rendered separator label, e.g. `%%% Memory: Turns 1–2`. |

The `cnz_turn_label` encodes the turn range. Strip `%%% Memory:` prefix to get the range string.

---

## Where the SCENE output ends up in context

The SCENE prose (after parsing) is written to the ST Summary prompt via:
```
SillyTavern-Canonize/core/summary-prompt.js
writeCnzSummaryPrompt(avatar, sceneText, anchorUuid)
```
This is what gets injected into the AI context as the situational summary. It is also stored as `anchor.scene` (along with the EVENTS table — the raw full output is stored, not just the parsed scene).

---

## Plot lorebook location

Lorebook name is derived from the character avatar filename:
```
SillyTavern-Canonize/rag/api.js
cnzPlotLbName(avatarFilename)   → "cnz_{char}_png_plot"
cnzDefaultLbName(avatarFilename) → "cnz_{char}_png"
```
Both are standard ST lorebooks stored via the lorebook API. The plot lorebook holds NEW: entries; the default lorebook holds character/world entries.

---

## Quick audit queries

### Pull all hookseeker SCENE+EVENTS output
```python
for i, line in enumerate(lines):
    msg = json.loads(line)
    cnz = msg.get('extra', {}).get('cnz', {})
    if cnz.get('type') == 'anchor':
        print(f"=== T{i+1} ===")
        print(cnz['scene'])       # full EVENTS + SCENE block
        print(cnz['plotEntries']) # plot entries written this sync
```

### Pull all RAG chunk headers
```python
for i, line in enumerate(lines):
    msg = json.loads(line)
    h = msg.get('extra', {}).get('cnz_chunk_header')
    if h:
        label = msg['extra'].get('cnz_turn_label', '')
        print(f"T{i+1} {label}: {h[:120]}")
```

### Verify chunk header covers correct turns
Each chunk covers N story pairs. Map `pairStart`/`pairEnd` from the anchor's `ragHeaders` to message indices:
- pair N = the Nth user+AI exchange in the chat (skipping chat_metadata line 1)
- `pairStart` and `pairEnd` are 0-indexed absolute pair numbers across the full chat

---

## Audit checklist

### EVENTS table
- [ ] Every confirmed future event (specific time/day) appears as a row
- [ ] Events removed once transcript shows they occurred or time passed
- [ ] Ongoing obligations (deliver package, reach destination) persist until resolved — this is the most common failure mode
- [ ] Rows ordered soonest first; "When" column is specific, not vague

### SCENE prose
- [ ] Every concrete detail is supportable from the transcript
- [ ] Captures the *end* of the sync window, not an early scene
- [ ] Active tensions/unresolved threads are present or implied
- [ ] Does not resolve something the transcript left open

### Plot entries
- [ ] Entry exists when: goal/allegiance changed, major decision made, info revealed, threat escalated/resolved, relationship shifted, lasting consequence, new thread
- [ ] No entries for routine continuation or banter
- [ ] 2-4 sentences, past tense, one arc tag
- [ ] Tag reuses existing one if arc continues; new tag only for genuinely unrelated arc

### RAG chunk headers
- [ ] Header content matches the turns in the claimed range (cross-ref pairStart/pairEnd)
- [ ] Named characters and actions match what the transcript says
- [ ] Major events in the window are not omitted
