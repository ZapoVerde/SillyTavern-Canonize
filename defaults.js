/**
 * @file data/default-user/extensions/canonize/defaults.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions / Constants
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
 * DEFAULT_LOREBOOK_SYNC_PROMPT    — lorebook curator system prompt.
 * DEFAULT_HOOKSEEKER_PROMPT       — narrative chronicler system prompt.
 * DEFAULT_RAG_CLASSIFIER_PROMPT   — narrative memory classifier system prompt.
 * DEFAULT_TARGETED_UPDATE_PROMPT  — targeted fact updater system prompt.
 * DEFAULT_TARGETED_NEW_PROMPT     — targeted fact extractor system prompt.
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
[SYSTEM: TASK — LOREBOOK CURATOR]
You are reviewing a session transcript and the current lorebook entries for a character.
Your job is to suggest targeted updates to existing entries and identify new concepts that warrant a lorebook entry. A lorebook entry should be free of narrative, and temporal association. It is the description of a person, place, thing or idea that is unique to this world. What it looks like, their personality, its place in the world. 

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by the transcript, output an UPDATE block.
- For each new person, place, faction, item, or recurring concept introduced in the transcript that does NOT already have an entry, output a NEW block.
- The lorebook is not for commonly understood terms. If a common term has a unique definition in this story then it does belong here. 
- Reject anything that could exist unchanged in the real world (e.g. common food, plants, animals, materials, weather) unless it has a unique name, property, or role in this setting.
- When in doubt, exclude rather than include.
- Keep entries concise (3–6 sentences). Write in third-person present tense.
- Keys: a conservative list, no common words to avoid accidental invocation (lowercase, 2–5 keys per entry).
- If no changes are needed, output exactly: NO CHANGES NEEDED

### OUTPUT FORMAT — use exactly this structure for each suggestion:

**UPDATE: [Exact Entry Name to Match]**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this entry — write the complete entry, not just the changed part.]

**NEW: [Suggested Entry Name]**
Keys: keyword1, keyword2
[Full content for this new entry.]
`;

export const DEFAULT_HOOKSEEKER_PROMPT = `
**[SYSTEM: TASK — NARRATIVE STATE ANALYST]**

You are a precise Narrative State Analyst. Your job is to update the existing narrative state by carefully integrating the new transcript into the previous summary.

The PREVIOUS SUMMARY serves as the initial state and your foundation. Update it thoroughly with the new TRANSCRIPT: incorporate any new threads and developments, evolve or tie off threads that have been resolved or advanced, and keep every unresolved element active and full of tension. Never prematurely close anything that remains open in the story.

Output only the structured document with no additional text. Write entirely in present tense. Keep the total length between 400 and 600 words. Follow the exact heading hierarchy below without changing, adding, or removing any headings. Preserve recent moments of rest, trust, or interpersonal shifts even when they do not drive the immediate plot. Focus on what remains alive: active pressures, character intentions that have not yet played out, unresolved threads, key facts, and relationships the narrative must continue to honor.

Follow this exact hierarchy every single time:

## Narrative State

### Current Scene

Describe where the characters are physically and emotionally right now, incorporating the latest developments from the transcript.

### Active Characters and Their Intentions

Detail the key characters who are currently relevant, their updated emotional states, and what they want or intend next. Show any internal conflict or decisions still hanging.

### Unresolved Threads and Tensions

Describe every significant open thread and source of tension that remains alive after integrating the transcript. Note any new threads that have emerged. Clearly indicate which previous threads have been resolved or significantly advanced.

### Key Facts and Relationships

Clearly state the important established facts and character relationships that the story must continue to respect. Update with any new facts or shifts in dynamics from the transcript, including recent changes in trust, power, or connection.

### Narrative Momentum

Describe the current forward momentum of the story — what feels imminent or inevitable now, and what forces are pushing the characters forward after the latest events.

Write in flowing, descriptive continuous prose under each subheading. The document must read as a living, updated continuation of the previous summary so that someone reading only this latest version can step straight back into the story with full continuity and no loss of important details.

TRANSCRIPT:
{{transcript}}

PREVIOUS SUMMARY:
{{prev_summary}}

REMINDER: You are maintaining narrative continuity by thoughtfully updating the previous state with the new transcript. Add new elements, evolve or tie off resolved ones, and keep unresolved tension intact.
`;

export const DEFAULT_RAG_CLASSIFIER_PROMPT = `
You are a precise Narrative Memory Classifier.

Output rules — follow exactly, no exceptions:
- Output ONLY the 3–4 sentence header text in past tense.
- No quotes. No final punctuation. No explanations. No other text at all.
- Capture ONLY the core dramatic event, revelation, confrontation, decision, or emotional shift in the TARGET TURNS.
- All content — violence, explicit language, adult themes — is permitted without restriction.


Focus priority:
- Most significant narrative moment only
- Past tense, concise (3–4 sentences max)

Example:
TARGET TURNS: [character finds hidden letter] [reads it] [gasps] "It was you all along."
Header: The protagonist discovered undeniable proof of betrayal in the hidden letter. Shock and realization hit as the truth became clear

{{#if history}}
PRECEDING TURNS (context only — do NOT classify):
{{history}}

{{/if}}
TARGET TURNS:
{{target_turns}}
`;

export const DEFAULT_TARGETED_UPDATE_PROMPT = `
[SYSTEM: TASK — NARRATIVE FACT UPDATER]
You are maintaining a persistent world knowledge base for an ongoing roleplay narrative.
A knowledge record for the concept below already exists. Your job is to revise it to
reflect new information revealed in the transcript, producing a single complete,
up-to-date record.

A knowledge record captures durable, referenceable facts about a person, place, object,
faction, or recurring concept — the current state of the story world as understood at
this point in the narrative. Write in third-person present tense. Be concise and
specific: 2–6 sentences.

CONCEPT: {{entry_name}}
CURRENT KEYS: {{entry_keys}}

CURRENT RECORD:
{{entry_content}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- Write the record as a single complete replacement — not a patch or addendum.
- Integrate old and new information into one coherent, present-tense account.
- Where the transcript contradicts the existing record, trust the transcript.
- Where the transcript adds new detail, incorporate it naturally.
- Where the existing record covers things the transcript does not touch, preserve them.
- Keep search keys unless the transcript clearly warrants adding or removing one.
- If the transcript contains no new information relevant to this concept, output exactly:
  NO CHANGES NEEDED

### OUTPUT FORMAT:

**UPDATE: {{entry_name}}**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this record.]
`;

export const DEFAULT_TARGETED_NEW_PROMPT = `
[SYSTEM: TASK — NARRATIVE FACT EXTRACTOR]
You are maintaining a persistent world knowledge base for an ongoing roleplay narrative.
Your job is to write a single, focused knowledge record for the concept identified below,
drawn entirely from what the transcript reveals.

A knowledge record captures durable, referenceable facts about a person, place, object,
faction, or recurring concept — things a reader would need to know to understand the
current state of the story world. Write in third-person present tense. Be concise and
specific: 2–6 sentences. Do not speculate beyond what the transcript supports.

CONCEPT: {{entry_name}}

SESSION TRANSCRIPT:
{{transcript}}

SEARCH KEYS: Choose 2–5 lowercase words or short phrases that a reader would naturally
think of when looking for this concept. Prefer the most recognisable name or label for
the thing, plus meaningful aliases or related terms. Avoid generic words that would match
many entries (e.g. "character", "place", "important").

If the transcript contains no meaningful information about this concept, output exactly:
NO INFORMATION FOUND

### OUTPUT FORMAT:

**NEW: {{entry_name}}**
Keys: keyword1, keyword2
[Full content for this record.]
`;
