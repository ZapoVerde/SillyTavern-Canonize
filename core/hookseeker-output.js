/**
 * @file data/default-user/extensions/canonize/core/hookseeker-output.js
 * @stamp {"utc":"2026-05-28T00:00:00.000Z"}
 * @architectural-role Pure Functions
 * @description
 * Parses the two-part output produced by the hookseeker prompt: a SCENE prose
 * block followed by zero or more **NEW:** lorebook entry blocks.
 *
 * The SCENE block is the thin narrative anchor written to the CNZ Summary prompt.
 * The entry blocks are appended to the plot lorebook as an event-log record of
 * what happened in this sync window.
 *
 * @api-declaration
 * parseHookseekerOutput(rawText) → { scene: string, entries: PlotEntry[] }
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     [none]
 */

/**
 * @typedef {{ name: string, content: string }} PlotEntry
 */

/**
 * Splits hookseeker output into the SCENE prose and any **NEW:** entry blocks.
 *
 * Expected format:
 *   SCENE:
 *   [one or two paragraphs of prose]
 *
 *   **NEW: Thread Name**
 *   Keys: key1, key2
 *   [content]
 *   #plot #thread_tag
 *
 * The SCENE: header is stripped; everything up to the first **NEW:** block is
 * the scene text. If no SCENE: header is present the entire text is treated as
 * scene prose and entries is []. If the output contains no **NEW:** blocks only
 * the scene is returned.
 *
 * @param {string} rawText
 * @returns {{ scene: string, entries: PlotEntry[] }}
 */
export function parseHookseekerOutput(rawText) {
    if (!rawText?.trim()) return { scene: '', entries: [] };

    // Locate the first **NEW:** block — everything before it is the scene.
    const firstEntryIdx = rawText.search(/\*\*NEW:/i);

    let scenePart  = firstEntryIdx === -1 ? rawText : rawText.slice(0, firstEntryIdx);
    const entryPart = firstEntryIdx === -1 ? ''      : rawText.slice(firstEntryIdx);

    // Strip the optional SCENE: header line.
    scenePart = scenePart.replace(/^SCENE:\s*/i, '').trim();

    const entries = _parseEntryBlocks(entryPart);
    return { scene: scenePart, entries };
}

/**
 * Parses **NEW:** blocks into PlotEntry objects.
 * Reuses the same block format as the lorebook curators (parseLbSuggestions)
 * but restricted to NEW blocks only — plot entries are never updated in-place.
 * @param {string} text
 * @returns {PlotEntry[]}
 */
function _parseEntryBlocks(text) {
    if (!text.trim()) return [];
    const entries = [];
    const parts   = text.split(/(?=\*\*NEW:)/i);

    for (const part of parts) {
        const headerMatch = part.match(/^\*\*NEW:\s*(.+?)(?:\s*\*{0,2})?\s*[\r\n]/i);
        if (!headerMatch) continue;
        const name = headerMatch[1].trim().replace(/\*+$/, '').trim();
        if (!name) continue;

        const rest    = part.slice(headerMatch[0].length);
        const content = rest.replace(/^Keys:\s*.+$/im, '').trim();
        if (!content) continue;

        entries.push({ name, content });
    }

    return entries;
}
