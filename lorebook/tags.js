/**
 * @file data/default-user/extensions/canonize/lorebook/tags.js
 * @stamp {"utc":"2026-05-27T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions
 * @description
 * MECE category tag system for lorebook entries. Every entry carries exactly one
 * of four mutually-exclusive category tags in its narrative content: #person,
 * #place, #thing, or #concept. These tags drive lane routing in the sync
 * pipeline and provide semantic grouping for RAG retrieval. Additional freeform
 * tags (e.g. #Bostaff_Household, #deceased) are AI-controlled and unrestricted.
 *
 * @api-declaration
 * MECE_TAGS                                    — the four canonical category tags
 * extractMeceTag(content)                      — returns the first MECE tag found, or null
 * stitchMeceTag(newNarrative, origNarrative, defaultTag) — re-injects MECE tag if AI dropped it
 * filterEntriesByTag(lorebookData, tag)        — returns lorebook subset matching tag
 * formatFilteredLorebookEntries(data, tag)     — formats a lane-filtered entry list for LLM input
 *
 * @contract
 *   assertions:
 *     purity: pure
 *     state_ownership: []
 *     external_io: [none]
 */

// ─── MECE Tag System ──────────────────────────────────────────────────────────

export const MECE_TAGS = ['#person', '#place', '#thing', '#concept'];

/**
 * Returns the first MECE category tag found in `content`, or null if none present.
 * @param {string} content
 * @returns {string|null}
 */
export function extractMeceTag(content) {
    if (!content) return null;
    for (const tag of MECE_TAGS) {
        if (content.includes(tag)) return tag;
    }
    return null;
}

/**
 * Ensures a MECE category tag is present in `newNarrative`.
 * If the AI kept or changed the MECE tag, the new content is returned unchanged.
 * If the AI dropped it, the tag is recovered from `origNarrative`.
 * If neither has one (new entry), `defaultTag` is appended.
 * @param {string} newNarrative   AI-produced narrative (no protected block).
 * @param {string} origNarrative  Pre-sync narrative (no protected block).
 * @param {string} defaultTag     Fallback MECE tag for new entries with no prior tag.
 * @returns {string}
 */
export function stitchMeceTag(newNarrative, origNarrative, defaultTag) {
    if (extractMeceTag(newNarrative)) return newNarrative;
    const recovered = extractMeceTag(origNarrative) ?? defaultTag;
    return newNarrative.trimEnd() + '\n' + recovered;
}

/**
 * Returns a lorebook-shaped object containing only entries matching the filter:
 *   tag = '#person'  → entries whose content includes '#person'
 *   tag = null       → entries that do NOT include any MECE tag (untagged legacy entries)
 *   tag = 'other'    → entries that include the tag but are not '#person'
 *
 * For the main lane, pass `isPeopleLane = false` to get everything except #person
 * (tagged non-person + all untagged entries). Callers use `formatFilteredLorebookEntries`.
 * @param {object}      lorebookData
 * @param {string|null} tag           MECE tag to match, or null for untagged.
 * @param {boolean}     [negate=false] When true, returns entries that do NOT match tag.
 * @returns {object}  Lorebook-shaped { entries: {} }
 */
export function filterEntriesByTag(lorebookData, tag, negate = false) {
    const entries = lorebookData?.entries ?? {};
    const filtered = {};
    for (const [uid, entry] of Object.entries(entries)) {
        const meceTag = extractMeceTag(entry.content ?? '');
        const matches = tag === null ? meceTag === null : meceTag === tag;
        if (negate ? !matches : matches) {
            filtered[uid] = entry;
        }
    }
    return { entries: filtered };
}

/**
 * Formats lorebook entries for a specific sync lane.
 * People lane: tag = '#person', negate = false.
 * Main lane:   tag = '#person', negate = true  (all non-person + untagged entries).
 * Strips protected blocks before sending to the LLM (same as formatLorebookEntries).
 * @param {object}  lorebookData
 * @param {string}  tag
 * @param {boolean} negate
 * @returns {string}
 */
export function formatFilteredLorebookEntries(lorebookData, tag, negate = false) {
    const subset = filterEntriesByTag(lorebookData, tag, negate);
    const items  = Object.values(subset.entries ?? {});
    if (!items.length) return '(no entries)';
    return items.map(e => {
        const label   = e.comment || String(e.uid);
        const keys    = Array.isArray(e.key) ? e.key.join(', ') : (e.key || '');
        // Strip protected block — same as lorebook/utils.js formatLorebookEntries
        const content = (e.content ?? '').split(/[ \t]*-\*-\*-[ \t]*/)[0].trimEnd();
        return `--- Entry: ${label} ---\nKeys: ${keys}\n${content}`;
    }).join('\n\n');
}
