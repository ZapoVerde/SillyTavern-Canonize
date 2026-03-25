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
Your job is to suggest targeted updates to existing entries and identify new concepts
that warrant a lorebook entry.

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by
  the transcript, output an UPDATE block.
- For each new person, place, faction, item, or recurring concept introduced in the
  transcript that does NOT already have an entry, output a NEW block.
- Keep entries concise (2–6 sentences). Write in third-person present tense.
- Keys: the most natural words a reader would search for (lowercase, 2–5 keys per entry).
- If no changes are needed, output exactly: NO CHANGES NEEDED

### OUTPUT FORMAT — use exactly this structure for each suggestion:

**UPDATE: [Exact Entry Name to Match]**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this entry — write the complete entry, not just the changed part.]
*Reason: One sentence explaining what changed and why.*

**NEW: [Suggested Entry Name]**
Keys: keyword1, keyword2
[Full content for this new entry.]
*Reason: One sentence explaining why this warrants a new entry.*
`;

export const DEFAULT_HOOKSEEKER_PROMPT = `
[SYSTEM: TASK — NARRATIVE CHRONICLER]
Analyze the TRANSCRIPT below and write a concise (150–300 word) present-tense summary
of: active plot threads, unresolved tensions, immediate threats or stakes, and current
character emotional states and intentions.

Constraints:
- No preamble. No "This is a summary." No bullet points.
- Write as flowing narrative prose in present tense.
- Focus on what is actively unresolved or in motion — not what has been settled.

TRANSCRIPT:
{{transcript}}
`;

export const DEFAULT_RAG_CLASSIFIER_PROMPT = `
You are a precise Narrative Memory Classifier.

Output rules — follow exactly, no exceptions:
- Output ONLY the 2–3 sentence header text in present tense.
- No quotes. No final punctuation. No explanations. No other text at all.
- Capture ONLY the core dramatic event, revelation, confrontation, decision, or emotional shift in the TARGET TURNS.
- Ignore any history and global summary except as loose context.

Focus priority:
- Most significant narrative moment only
- Present tense, concise (2–3 sentences max)

Example:
TARGET TURNS: [character finds hidden letter] [reads it] [gasps] "It was you all along."
Header: The protagonist discovers undeniable proof of betrayal in the hidden letter. Shock and realization hit as the truth becomes clear

GLOBAL CHAPTER SUMMARY (context only — do NOT classify):
{{summary}}

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
