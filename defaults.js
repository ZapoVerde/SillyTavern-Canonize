/**
 * @file data/default-user/extensions/canonize/defaults.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * Default prompt templates for all five CNZ AI calls, plus the `interpolate`
 * utility used to expand them. Extracted here so `recipes.js` can import them
 * without pulling in all of `index.js`.
 *
 * Nothing in this file holds state or performs IO. All exports are either
 * constant strings or pure functions.
 *
 * @api-declaration
 * interpolate(template, vars)     — expands {{key}} and {{#if key}}…{{/if}} blocks.
 * DEFAULT_LOREBOOK_SYNC_PROMPT    — lorebook curator system prompt (places, things, concepts).
 * DEFAULT_PEOPLE_SYNC_PROMPT      — people curator system prompt (persons and relationships).
 * DEFAULT_HOOKSEEKER_PROMPT       — narrative chronicler system prompt.
 * DEFAULT_RAG_CLASSIFIER_PROMPT   — narrative memory classifier system prompt.
 * DEFAULT_TARGETED_UPDATE_PROMPT   — targeted fact updater system prompt.
 * DEFAULT_TARGETED_NEW_PROMPT      — targeted fact extractor system prompt.
 * DEFAULT_RAG_INJECTION_TEMPLATE   — injection wrapper template ({{text}} placeholder).
 * DEFAULT_RAG_CHUNK_TEMPLATE       — per-chunk wrapper template ({{text}}, {{turn_range}}, {{header}}, {{char_name}}).
 * DEFAULT_CNZ_SUMMARY_TEMPLATE     — overall CNZ Summary prompt wrapper ({{summary}}, {{plot}}).
 * DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE  — per-arc wrapper template ({{text}}, {{arc_tag}}).
 * buildCnzSummaryContent(scene, plot, tmpl) — renders the summary prompt from scene + plot strings.
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: []
 */
// ─── CNZ Default Prompts & Interpolation ─────────────────────────────────────

/**
 * Substitutes {{variable}} tokens and processes {{#if key}}...{{/if}} blocks.
 * Pure function — no side effects.
 * @param {string} template
 * @param {Record<string,string>} vars
 * @returns {string}
 */
export function interpolate(template, vars) {
    let result = template.replace(
        /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, key, inner) => (vars[key] ? inner : ''),
    );
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
    return result;
}

export const DEFAULT_LOREBOOK_SYNC_PROMPT = `
**[SYSTEM: TASK — LOREBOOK CURATOR]**
You are reviewing a session transcript and the current lorebook entries for a character.
Your job is to suggest targeted updates to existing entries and identify new concepts that warrant a lorebook entry. A lorebook entry should be free of narrative and temporal association. It is the description of a place, thing, or concept that is unique to this world — what it looks like, how it works, its place in the world.

**[LOGISTICAL PERSISTENCE]**
While entries should describe the nature of an entity, they must also track its current operational state. If the transcript reveals a significant change in where something is located, who possesses a key item, or the current condition of a place, update the entry to reflect that truth. Treat the lorebook as a live save-file for the world's logistics, not just a static encyclopedia.

IMPORTANT — CATEGORY TAGS:
Every entry must end with exactly one category tag on its own line. The four categories are:
  #place    — a location, region, building, or geographic feature
  #thing    — an object, item, creature, or material
  #concept  — a faction, organisation, system, phenomenon, or recurring idea
  #person   — a named character or person

Assign the most accurate category tag to every entry you touch. If an existing entry carries the wrong tag or no tag at all, correct it — accurate tagging is essential, as the system routes entries to specialised curators based on these tags.

For #person entries: if you encounter an entry that belongs to a person but is mistagged or untagged, output an UPDATE that corrects the tag only — preserve the existing content exactly. Do not otherwise create or rewrite person entry content; a dedicated people curator handles that. You may add additional freeform tags after the category tag to reflect meaningful groupings (e.g. #Bostaff_Household, #magic_system). Invent tags that serve the story.

Never output a NEW block for a person. Person creation is handled exclusively by the people curator. If someone appears in the transcript who has no lorebook entry, skip them entirely — do not create a #person entry here.

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by the transcript, output an UPDATE block.
- For each new place, thing, or concept introduced in the transcript that does NOT already have an entry, output a NEW block.
- **Entity Resolution:** Do not create new entries for synonyms or sub-components of existing entries. If "The Pavilion" is mentioned and "The Wandering Pavilion" already exists, update the original.
- **Duplicate Flagging:** If two existing entries clearly cover the same concept under different names, merge their content into the better-named entry via a normal UPDATE, then output a second UPDATE for the redundant entry with the content \`**dup** — duplicate of [Primary Name]\` so it can be manually removed.
- **State Tracking:** Explicitly include and update specific "Hard Data" within entries: named locations, exact quantities of significant resources, and the current holder or whereabouts of key items or artifacts.
- **[REJECTION CRITERIA]:**
    - The lorebook is for terms unique to this world. Reject anything that could exist unchanged in the real world (e.g. common food, plants, animals, materials, weather) unless it has a unique name, property, or role in this setting.
    - **Reject "Conversational Noise":** Ignore one-off jokes, slang, idioms, or metaphors with no durable story significance.
    - **Reject "Narrative Flourish":** If a concept is used only once to convey a mood or temporary feeling, do not index it.
- When in doubt, exclude rather than include.
- Keep entries concise (3–6 sentences). Write in third-person present tense.
- Keys: a conservative list, no common words to avoid accidental invocation (lowercase, 2–5 keys per entry).
- Always end each entry's content with a category tag line (e.g. #place or #thing #Bostaff_Household).
- If no changes are needed, output exactly: NO CHANGES NEEDED

### OUTPUT FORMAT — use exactly this structure for each suggestion:

**UPDATE: [Exact Entry Name to Match]**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this entry — write the complete entry, not just the changed part.]
#place

**NEW: [Suggested Entry Name]**
Keys: keyword1, keyword2
[Full content for this new entry.]
#thing #optional_group_tag
**UPDATE: [Redundant Entry Name]**
Keys: keyword1
\`**dup**\` — duplicate of [Primary Entry Name]
#thing
`;

// People curator prompt has moved to defaults-people.js.
export { DEFAULT_PEOPLE_SYNC_PROMPT } from './defaults-people.js';

export const DEFAULT_HOOKSEEKER_PROMPT = `
**[SYSTEM: TASK — NARRATIVE CHRONICLER]**

You are a Narrative Chronicler maintaining a living record of an ongoing story. Your output has exactly two parts: a SCENE block and NEW: plot entries.

---

**PART 1 — SCENE**

Write approximately 150–200 words beginning with SCENE: on its own line. Describe the current moment in flowing present tense — the physical situation, emotional atmosphere, sensory details, and active pressures. Use the full transcript for context: recent events should feel most vivid, but earlier events in the window should still colour the tone and stakes. Do not lose threads that remain alive; carry forward anything unresolved. Maintain strict continuity with the PREVIOUS SCENE — do not reset it; evolve it naturally. Do not invent events, motivations, or outcomes not supported by the transcript.

---

**PART 2 — PLOT ENTRIES**

Create a NEW: entry only when at least one of the following occurs:
- A character's goal, motivation, or allegiance changes
- A major decision is made or a consequential action taken
- Important information is revealed — a secret exposed, a mystery deepened or resolved
- A threat escalates or resolves
- An alliance or relationship dynamic shifts
- A lasting consequence takes hold
- A new narrative thread begins

Do not restate previously recorded developments unless the situation has materially changed. "The siege continues" is not an entry. "The siege wall breached" is. Extend existing threads through tags rather than creating duplicate entries with slightly different names.

One entry per arc per sync window. If multiple developments occurred within the same arc, capture them together in a single entry rather than splitting across cards.

Rules:
- **Entry name:** A vivid label for this arc's progression in this window (e.g. "The Ashford Siege Breaks Open", "Elena's Allegiance Fractures").
- **Content:** 2–4 sentences in past tense covering the arc's developments this window. What happened, why it matters, what tension or possibility it creates.
- **Tag:** End every entry with the arc's stable thread tag (e.g. #ashford_siege). Once a tag is established for an arc, that exact form must be reused every time. Do not invent near-duplicates. Only coin a new tag for a genuinely new arc.

If none of the above occurred, output only the SCENE.

---

TRANSCRIPT:
{{transcript}}

PREVIOUS SCENE:
{{prev_scene}}

---

OUTPUT FORMAT (follow exactly):

SCENE:
[approximately 150–200 words of present-tense prose]

**NEW: [Entry Name]**
[2–4 sentences in past tense.]
#thread_tag

**NEW: [Entry Name]**
[2–4 sentences in past tense.]
#thread_tag
`;

// ─── CNZ Summary Injection Templates ─────────────────────────────────────────

export const DEFAULT_CNZ_SUMMARY_TEMPLATE =
`{{#if plot}}The following is a summary of the active plot threads:
{{plot}}

{{/if}}{{#if summary}}The following is a summary of the current situation:
{{summary}}{{/if}}`;

/**
 * Renders the CNZ Summary prompt content from summary and plot strings.
 * Returns empty string if both inputs are empty.
 * @param {string} summary  Scene/situation prose from hookseeker.
 * @param {string} plot     Formatted plot arc blocks (may be empty string).
 * @param {string} [tmpl]   Template; defaults to DEFAULT_CNZ_SUMMARY_TEMPLATE.
 * @returns {string}
 */
export function buildCnzSummaryContent(summary, plot, tmpl = DEFAULT_CNZ_SUMMARY_TEMPLATE) {
    if (!summary && !plot) return '';
    return interpolate(tmpl, { summary: summary ?? '', plot: plot ?? '' });
}

// RAG classifier, targeted update/new prompts, and injection templates
// have moved to defaults-rag.js to keep this file under 300 lines.
export { DEFAULT_RAG_CLASSIFIER_PROMPT, DEFAULT_TARGETED_UPDATE_PROMPT,
         DEFAULT_TARGETED_NEW_PROMPT, DEFAULT_RAG_INJECTION_TEMPLATE,
         DEFAULT_RAG_CHUNK_TEMPLATE, DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE } from './defaults-rag.js';
