# Lorebook Architecture

Canonize maintains two lorebook files per character and uses three curator lanes to write them. All entries are standard SillyTavern lorebook format — they appear in the World Info panel and can be edited there, but CNZ owns and manages them.

---

## The Category System

Every entry carries exactly one category tag on its own line at the end of its content. The four categories are MECE — each entry belongs to exactly one:

| Tag | Covers |
|---|---|
| `#place` | Locations, buildings, geographic features |
| `#thing` | Objects, items, creatures, physical materials |
| `#concept` | Factions, organisations, magic systems, historical events |
| `#person` | Characters and individuals |

Tagging is enforced because it routes entries to the correct curator lane. If an entry carries the wrong tag, the General Curator will correct it. Additional freeform tags can be added after the category tag to reflect groupings the story introduces (`#Bostaff_Household`, `#antagonist`, `#deceased`).

---

## The General Curator

Runs at each sync. Handles `#place`, `#thing`, and `#concept` entries only — it is explicitly forbidden from creating or rewriting `#person` entries.

Entries are 3–6 sentences, third-person present tense. The goal is a living save-file for the world's logistics: not just what something is, but its current operational state — who holds a key item, where a faction is based, the current condition of a place. Purely real-world things with no unique story role are rejected.

Writes to the **main lorebook** (`cnz_<character>`).

---

## The People Curator

Runs at each sync. Handles `#person` entries exclusively. Every character entry has exactly five sections.

### Naming Convention

Every entry name is exactly two words. No exceptions, no parenthetical qualifiers.

| Situation | Format | Example |
|---|---|---|
| Full name known | Firstname Lastname | Elara Mornwood |
| Title + first name | Title Firstname | Queen Elara, Guard Renn |
| Single name only | Role Firstname | Maid Rose, Smith Alvin |

The name is set at creation and never changed.

### Entry Structure

**Appearance** — Physically inherent traits only: body type, height, build, bone structure, facial features, natural hair colour, permanent scars or birthmarks. Clothing, current hairstyle, and injuries are excluded. Set once at creation and reproduced exactly in every subsequent update — never altered.

**Personality** — 3–5 polar spectrum axes chosen to genuinely reveal this specific character:

```
Warm ↔ Guarded: Leans guarded — slow to trust, but fiercely loyal once earned.
```

Set once at creation. Reproduced exactly in every update — never altered.

**Connections** — A reference table of this character's direct relationships to other named characters (not to `{{user}}` — that lives in the next section):

| Person | Relation | Tone |
|---|---|---|
| Elara Mornwood | employer | cold |

*Person* is the exact two-word card name of the connected character. *Relation* is a structural role (grandfather, rival, employer) — updated only when the structural fact changes. *Tone* is a single word describing the current emotional quality of the connection; this updates when the dynamic shifts.

**Relationship with {{user}}** — The live current dynamic: emotional posture, power balance, active leverage, direction of movement. Written as persistent conditions, not event narration. No references to specific past exchanges, no time-based phrasing, no scheduled future actions.

**Goals** — One major goal (the character's own long-term ambition, independent of `{{user}}`) and exactly three minor goals (immediate personal intentions).

Writes to the **main lorebook** (`cnz_<character>`).

---

## The Plot Curator

Runs at each sync. Unlike the other curators, it produces three distinct outputs and writes only to the **plot lorebook** (`cnz_<character>_plot`), which is append-only — entries are added or updated, never removed.

The hookseeker also produces an events table and a scene block on each run, but those go into the bridge summary, not the lorebook. Only plot entries are written to the plot lorebook file.

### Plot Entries

Created only when the narrative state has clearly shifted — a decision made, a secret exposed, a threat escalated or resolved, a relationship dynamic changed. Routine developments that are merely continuing do not qualify.

Each entry is 2–4 sentences in past tense covering what happened and why it matters. Every entry ends with exactly one arc tag:

- **Character arc** — tracks one person's moves, position, and decisions within a specific objective: `#elara_seat`, `#thomas_escape`
- **Situation arc** — tracks the state of a shared conflict or evolving dynamic involving multiple characters: `#foundation_contest`

Once a tag is established, it is reused exactly across all entries for that arc — continuity over precision. A new tag is coined only when a development introduces entirely unrelated stakes, participants, and objectives.

---

## Merging and Deduplication

**Cross-curator conflict:** If the General Curator tentatively creates a `#person` entry, it will be detected and handed to the People Curator, which replaces it with a proper character card.

**Duplicate merging:** If two entries cover the same thing under different names, the content is merged into the better-named entry via UPDATE. The redundant entry receives a `**dup** — duplicate of [Primary Name]` marker for manual cleanup.

---

## The Lorebook Files

Both files are created automatically on first sync and start empty.

**`cnz_<character>`** — the main lorebook. Holds all General and People entries. Feeds the General RAG lane on every turn.

**`cnz_<character>_plot`** — the plot lorebook. Holds all plot arcs. Feeds the Plot RAG lane on every turn.

Both are visible and editable in SillyTavern's World Info panel. The curators diff against whatever is there at sync time, so manual edits are preserved unless a curator proposes a targeted update to that specific entry.
