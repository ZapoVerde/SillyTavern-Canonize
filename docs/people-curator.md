# The People Curator

Characters are dynamic — they change their appearance, update their motivations, and form relationships over time. Canonize handles them with a dedicated sync lane separate from the General Curator (places, things, concepts).

## Two Lorebook Lanes

Every sync cycle runs two prompts against your new conversation block:

1. **General Curator** — Extracts `#place`, `#thing`, and `#concept` entries. Ignores people entirely to avoid formatting noise.
2. **People Curator** — Deals exclusively with `#person` entries. Evaluates dialogue, actions, and subtext to update character profiles.

## Category Tags (MECE System)

Every lorebook entry carries exactly one category tag:

| Tag | Covers |
|---|---|
| `#place` | Locations, buildings, geographic features |
| `#thing` | Objects, items, creatures, physical materials |
| `#concept` | Factions, magic systems, organizations, historical events |
| `#person` | Characters and individuals |

Additional tags (`#deceased`, `#King's_Household`, `#ally`) can be added freely. The core category tag is strictly enforced so entries route to the correct lane.

## Character Tiers

The People Curator automatically assigns one of two treatment levels based on how prominent a character is in the story.

### Surface NPC

For peripheral characters who appear briefly with no major dialogue or relationship arc. A single paragraph covering identity, role, and immediate physical appearance.

### Full Treatment

Triggered when a character recurs, engages in meaningful dialogue, or develops a closer relationship. The entry is structured into four subheadings:

- **Appearance** — Physically inherent traits (height, natural hair color, scars, facial features). Clothes, current injuries, and temporary hairstyles are excluded — those belong in the Summary.
- **Personality** — Evaluated on 3–5 polar spectrum axes. Example: *Warm ↔ Guarded: Leans guarded — slow to trust, but fiercely loyal once earned.*
- **Relationship with {{user}}** — Continuous prose on their *current* emotional stance, power dynamic, active tensions, or trust level. Avoids narrating past events.
- **Goals** — One major goal (core long-term drive) and exactly three minor goals (immediate short-term plans or concerns).

## Automatic Upgrades and Merging

- **Dynamic upgrades** — If a Surface NPC has a meaningful interaction in the chat, the People Curator automatically rewrites them into Full Treatment format on the next sync.
- **Conflict resolution** — If the General Curator tentatively creates a record for a person, the Reconciliation Step scraps the redundant entry and hands it to the People Curator.
- **Duplicate merging** — If two entries exist for the same character under different names (alias vs. full name), they are merged into the primary entry. The redundant entry is tagged `**dup** — duplicate of [Name]` for easy cleanup.
