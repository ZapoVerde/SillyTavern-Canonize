/**
 * @file data/default-user/extensions/canonize/lorebook/utils.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.18
 * @architectural-role Pure Functions
 * @description
 * Pure data manipulation functions for lorebook state. Covers parsing AI
 * suggestion text into structured objects, enriching suggestions with anchor-diff
 * context, diffing entry content, constructing new draft entries from canonical
 * defaults, and managing draft state (deleteLbEntry, revertLbSuggestion,
 * isDraftDirty). No fetch calls; callers supply all inputs via `state`.
 *
 * Updated to support PersonaLyze "Pull-from-Sync" Identity Anchor protection.
 *
 * @api-declaration
 * formatLorebookEntries, parseLbSuggestions, enrichLbSuggestions,
 * deriveSuggestionsFromAnchorDiff, matchEntryByComment, nextLorebookUid,
 * makeLbDraftEntry, toVirtualDoc, updateLbDiff, isDraftDirty,
 * deleteLbEntry, revertLbSuggestion, serialiseSuggestionsToFreeform,
 * syncFreeformFromSuggestions, PLZ_DELIMITER, stripPlzAnchor, getPlzAnchor,
 * stitchPlzAnchor
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookSuggestions, state._draftLorebook,
 *                       state._parentNodeLorebook, state._lbActiveIngesterIndex]
 *     external_io: [SillyTavern.getContext (for char mapping)]
 */

import { state, escapeHtml } from '../state.js';
import { extension_settings } from '../../../../extensions.js';

// ─── PersonaLyze Integration ──────────────────────────────────────────────────

export const PLZ_DELIMITER = '\n\n### Physical Identity\n';
const PLZ_DELIMITER_REGEX = /(?:\r?\n)*### Physical Identity\b/i;

/**
 * Strips the protected PersonaLyze physical identity block from a lorebook entry.
 * Ensures the AI curator only sees and edits the narrative portion.
 * @param {string} content 
 * @returns {string}
 */
export function stripPlzAnchor(content) {
    if (!content) return '';
    const parts = content.split(PLZ_DELIMITER_REGEX);
    return parts[0].trim();
}

/**
 * Reaches into PersonaLyze's settings to find a matching Identity Anchor.
 * Uses strict avatar mapping first, falling back to case-insensitive slug and fuzzy matches.
 * @param {string} entryName 
 * @returns {string} The raw Identity Anchor text, or empty string if not found.
 */
export function getPlzAnchor(entryName) {
    const plzRoot = extension_settings?.personalyze;
    if (!plzRoot?.characters) return '';

    const lowerName = String(entryName || '').trim().toLowerCase();
    if (!lowerName) return '';

    // 1. Try to match against live ST characters by name to get the exact PLZ avatar key
    const ctx = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : null;
    const stChars = ctx?.characters || [];
    const matchedChar = stChars.find(c => String(c.name || '').trim().toLowerCase() === lowerName);

    if (matchedChar && matchedChar.avatar) {
        const avatarSlug = matchedChar.avatar.replace(/[^a-zA-Z0-9_\-]/g, '_');
        if (plzRoot.characters[avatarSlug]?.identityAnchor) {
            return plzRoot.characters[avatarSlug].identityAnchor.trim();
        }
    }

    // 2. Direct key match (slugified name)
    const slug = lowerName.replace(/\s+/g, '_').replace(/[^a-z0-9_\-]/g, '');
    if (plzRoot.characters[slug]?.identityAnchor) {
        return plzRoot.characters[slug].identityAnchor.trim();
    }

    // 3. Fallback: fuzzy match against all PLZ keys
    for (const [key, data] of Object.entries(plzRoot.characters)) {
        if (key.toLowerCase() === slug || key.toLowerCase().replace(/_/g, ' ') === lowerName) {
            if (data.identityAnchor) return data.identityAnchor.trim();
        }
    }

    return '';
}

/**
 * Combines a narrative text with the fresh PLZ anchor for the given character.
 * Returns the combined string (narrative + delimiter + anchor), or just the
 * narrative if no anchor is found.
 * @param {string} entryName
 * @param {string} narrative  Pure narrative text (no PLZ block).
 * @returns {string}
 */
export function stitchPlzAnchor(entryName, narrative) {
    const anchor = getPlzAnchor(entryName);
    if (!anchor) return narrative;
    return `${narrative}${PLZ_DELIMITER}${anchor}`;
}

// ─── Lorebook Utilities ───────────────────────────────────────────────────────

export function formatLorebookEntries(data) {
    const entries = data?.entries ?? {};
    const items   = Object.values(entries);
    if (!items.length) return '(no entries yet)';
    return items.map(e => {
        const label = e.comment || String(e.uid);
        const keys  = Array.isArray(e.key) ? e.key.join(', ') : (e.key || '');
        // Strip the PLZ block before sending to the AI
        const narrativeContent = stripPlzAnchor(e.content);
        return `--- Entry: ${label} ---\nKeys: ${keys}\n${narrativeContent}`;
    }).join('\n\n');
}

/**
 * Parses raw Fact-Finder / lorebook curator output into suggestion objects.
 * Splits on **UPDATE:** / **NEW:** block headers.
 */
export function parseLbSuggestions(rawText) {
    const suggestions = [];
    const parts = rawText.split(/(?=\*\*(UPDATE|NEW):\s)/i);
    for (const part of parts) {
        const headerMatch = part.match(/^\*\*(UPDATE|NEW):\s*(.+?)(?:\s*\*{0,2})?\s*[\r\n]/i);
        if (!headerMatch) continue;
        const type = headerMatch[1].toUpperCase();
        const name = headerMatch[2].trim().replace(/\*+$/, '').trim();
        if (!name) continue;

        const rest = part.slice(headerMatch[0].length);

        const keysMatch = rest.match(/^Keys:\s*(.+)$/im);
        const keys = keysMatch
            ? keysMatch[1].split(',').map(k => k.trim()).filter(Boolean)
            : [];

        const afterKeys = keysMatch
            ? rest.slice(rest.indexOf(keysMatch[0]) + keysMatch[0].length)
            : rest;
        const reasonIdx = afterKeys.search(/^\*Reason:/im);
        const content = (reasonIdx !== -1
            ? afterKeys.slice(0, reasonIdx)
            : afterKeys
        ).trim();

        if (!content) continue;
        suggestions.push({ type, name, keys, content });
    }
    return suggestions;
}

/**
 * Inverse of parseLbSuggestions. Serialises the suggestion list into the
 * standard **UPDATE:** / **NEW:** block format used by the Freeform overview.
 * Deleted entries emit a single `**DELETE: name**` tombstone line.
 * Rejected suggestions are excluded entirely.
 * Entry content is read from `draftLorebook` (the single source of truth).
 * @param {object[]} suggestions
 * @param {object}   draftLorebook
 * @returns {string}
 */
export function serialiseSuggestionsToFreeform(suggestions, draftLorebook) {
    return suggestions
        .map(s => {
            if (s.status === 'deleted')  return `**DELETE: ${s.name}**`;
            if (s.status === 'rejected') return null;
            const entry = draftLorebook?.entries?.[String(s.linkedUid)];
            if (!entry) return null;
            const lines = [`**${s.type}: ${entry.comment || s.name}**`];
            if (entry.key?.length) lines.push(`Keys: ${entry.key.join(', ')}`);
            lines.push(entry.content ?? '');
            return lines.join('\n');
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Writes the current state._lorebookSuggestions to the Freeform textarea.
 * Called after any action that changes the suggestion list or editor content.
 */
export function syncFreeformFromSuggestions() {
    $('#cnz-lb-freeform').val(serialiseSuggestionsToFreeform(state._lorebookSuggestions, state._draftLorebook));
}

/**
 * Searches state._draftLorebook.entries for an entry whose comment matches `name`.
 * Returns the string uid key, or null if not found.
 */
export function matchEntryByComment(name) {
    const lower = name.toLowerCase();
    for (const [uid, entry] of Object.entries(state._draftLorebook?.entries ?? {})) {
        if ((entry.comment ?? '').toLowerCase() === lower) return uid;
    }
    return null;
}

/**
 * Returns the next available numeric uid for a new lorebook entry.
 */
export function nextLorebookUid() {
    const keys = Object.keys(state._draftLorebook?.entries ?? {}).map(Number).filter(n => !isNaN(n));
    return keys.length ? Math.max(...keys) + 1 : 0;
}

/**
 * Builds a complete ST worldinfo entry object for a new lorebook entry.
 */
export function makeLbDraftEntry(uid, name, keys, content) {
    return {
        uid,
        key:                       keys,
        keysecondary:              [],
        comment:                   name,
        content,
        constant:                  false,
        vectorized:                false,
        selective:                 true,
        selectiveLogic:            0,
        addMemo:                   true,
        order:                     100,
        position:                  0,
        disable:                   false,
        ignoreBudget:              false,
        excludeRecursion:          false,
        preventRecursion:          false,
        matchPersonaDescription:   false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario:             false,
        matchCreatorNotes:         false,
        delayUntilRecursion:       0,
        probability:               100,
        useProbability:            true,
        depth:                     4,
        outletName:                '',
        group:                     '',
        groupOverride:             false,
        groupWeight:               100,
        scanDepth:                 null,
        caseSensitive:             null,
        matchWholeWords:           null,
        useGroupScoring:           null,
        automationId:              '',
        role:                      0,
        sticky:                    null,
        cooldown:                  null,
        delay:                     null,
        triggers:                  [],
        displayIndex:              uid,
    };
}

/**
 * Builds a "Virtual Document" string from a lorebook entry's three editable fields.
 * Pure function — no DOM or module dependencies.
 */
export function toVirtualDoc(name, keys, content) {
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    const keyLines   = sortedKeys.length ? sortedKeys.map(k => `KEY: ${k}`).join('\n') : 'KEY: (none)';
    return `NAME: ${name}\n${keyLines}\n\n${content}`;
}

/**
 * Reconciles a freshly-parsed suggestion list against the existing
 * state._lorebookSuggestions array, preserving UID anchors and verdict flags.
 * All returned objects initialise status to 'pending'
 * except when carrying forward a previously rejected state from an existing entry.
 */
export function enrichLbSuggestions(freshParsed) {
    const enriched = freshParsed.map(fresh => {
        const existing = state._lorebookSuggestions.find(
            s => s._aiSnapshot.name.toLowerCase() === fresh.name.toLowerCase(),
        );

        if (existing) {
            if (existing.status === 'applied') {
                // Preserve user-edited name; keys/content in draft are the source of truth.
                // _aiSnapshot updated to fresh so ← Latest reflects the new AI output.
                return {
                    type:        fresh.type,
                    name:        existing.name,
                    linkedUid:   existing.linkedUid,
                    status:      'pending',
                    _aiSnapshot: { name: fresh.name, keys: [...fresh.keys], content: fresh.content },
                };
            } else {
                return {
                    type:        fresh.type,
                    name:        fresh.name,
                    linkedUid:   existing.linkedUid,
                    status:      existing.status === 'rejected' ? 'rejected' : 'pending',
                    _aiSnapshot: { name: fresh.name, keys: [...fresh.keys], content: fresh.content },
                };
            }
        } else {
            const uidStr    = matchEntryByComment(fresh.name);
            const linkedUid = uidStr !== null ? parseInt(uidStr, 10) : null;
            return {
                type:        fresh.type,
                name:        fresh.name,
                linkedUid,
                status:      'pending',
                _aiSnapshot: { name: fresh.name, keys: [...fresh.keys], content: fresh.content },
            };
        }
    });

    const seenUids = new Set();
    for (const s of enriched) {
        if (s.linkedUid === null) continue;
        if (seenUids.has(s.linkedUid)) {
            console.warn(`[CNZ] Two lorebook suggestions resolved to uid ${s.linkedUid}; treating second as NEW.`);
            s.linkedUid = null;
        } else {
            seenUids.add(s.linkedUid);
        }
    }

    return enriched;
}

/**
 * Derives a suggestion list by diffing two lorebook states.
 * Used by openReviewModal to reconstruct what changed in the last sync
 * entirely from the head anchor — no ephemeral sync-cycle variables needed.
 *
 * Entries present in `after` but not in `before` → type NEW, status 'pending'.
 * Entries present in both but with changed content/keys → type UPDATE, status 'pending'.
 * Entries present in `before` but removed from `after` → skipped (deletions not surfaced).
 *
 * All returned suggestions are marked status 'pending' so the user can review
 * them via Apply/Reject. The underlying lorebook data is already committed to
 * disk; Apply/Reject only set the UI label and control Next Unresolved skipping.
 *
 * @param {object|null} before  Pre-sync lorebook (parent node state.lorebook), or null.
 * @param {object|null} after   Post-sync lorebook (head node state.lorebook).
 * @returns {object[]}          Suggestion objects compatible with the ingester pipeline.
 */
export function deriveSuggestionsFromAnchorDiff(before, after) {
    const beforeEntries = before?.entries ?? {};
    const afterEntries  = after?.entries  ?? {};
    const suggestions   = [];

    for (const [uid, afterEntry] of Object.entries(afterEntries)) {
        const beforeEntry = beforeEntries[uid];
        const name    = afterEntry.comment || String(afterEntry.uid ?? uid);
        const keys    = Array.isArray(afterEntry.key) ? [...afterEntry.key] : [];
        const content = afterEntry.content ?? '';

        if (!beforeEntry) {
            // New entry — content lives in _draftLorebook; _aiSnapshot is the reference copy.
            suggestions.push({
                type:        'NEW',
                name,
                linkedUid:   parseInt(uid, 10),
                status:      'pending',
                _aiSnapshot: { name, keys: [...keys], content },
            });
        } else {
            // Check for changes
            const contentChanged = beforeEntry.content !== afterEntry.content;
            const keysChanged    = JSON.stringify([...(beforeEntry.key ?? [])].sort())
                                !== JSON.stringify([...keys].sort());
            if (contentChanged || keysChanged) {
                suggestions.push({
                    type:        'UPDATE',
                    name,
                    linkedUid:   parseInt(uid, 10),
                    status:      'pending',
                    _aiSnapshot: { name, keys: [...keys], content },
                });
            }
        }
    }

    return suggestions;
}

/**
 * Recomputes and renders the ingester diff panel.
 * Reads editor field values and compares against parent-node baseline.
 */
export function updateLbDiff() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    const uid = s?.linkedUid != null
        ? String(s.linkedUid)
        : $('#cnz-targeted-entry-select').val() || null;
    if (!uid && !s) return;

    const name    = $('#cnz-lb-editor-name').val();
    const keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = stripPlzAnchor($('#cnz-lb-editor-content').val());
    const proposed = toVirtualDoc(name, keys, content);

    let base = '';
    if (uid) {
        const parentEntry = state._parentNodeLorebook?.entries?.[uid];
        if (parentEntry) {
            base = toVirtualDoc(
                parentEntry.comment || '',
                Array.isArray(parentEntry.key) ? parentEntry.key : [],
                stripPlzAnchor(parentEntry.content || ''),
            );
        }
        // no parentEntry → entry is new this sync → base stays ''
    }

    $('#cnz-lb-ingester-diff').html(wordDiff(base, proposed));
}

/**
 * Returns true if draft lorebook differs from base (content, keys, or comment changed).
 * @param {object} draft
 * @param {object} base
 * @returns {boolean}
 */
export function isDraftDirty(draft, base) {
    if (!draft || !base) return false;
    const d = draft.entries  ?? {};
    const b = base.entries ?? {};
    if (Object.keys(d).length !== Object.keys(b).length) return true;
    for (const [uid, entry] of Object.entries(d)) {
        const orig = b[uid];
        if (!orig) return true;
        if (orig.content !== entry.content) return true;
        if (JSON.stringify(orig.key) !== JSON.stringify(entry.key)) return true;
        if ((orig.comment ?? '') !== (entry.comment ?? '')) return true;
    }
    return false;
}

/**
 * Marks the suggestion at `idx` as deleted: removes the entry from
 * state._draftLorebook.entries so Finalize will not write it, clears keys and content
 * on the suggestion object, and sets status to 'deleted'. s.name is preserved as a
 * display label. Memory-only — no disk write.
 * @param {number} idx  Index into state._lorebookSuggestions.
 */
export function deleteLbEntry(idx) {
    const s = state._lorebookSuggestions[idx];
    if (!s) return;

    // Remove from draft lorebook
    if (s.linkedUid !== null) {
        if (state._draftLorebook?.entries) {
            delete state._draftLorebook.entries[String(s.linkedUid)];
        }
    }

    // Update suggestion state — name preserved as dropdown label
    s.status = 'deleted';

    // Update dropdown
    $('#cnz-lb-suggestion-select option')
        .eq(idx)
        .text(escapeHtml(`\u2716 DELETE: ${s.name}`));

    if (state._lbActiveIngesterIndex === idx) {
        renderLbIngesterDetail(s);
        updateLbDiff();
    }

    syncFreeformFromSuggestions();
}

/**
 * Reverts the suggestion at `idx` to its parent-node state in state._draftLorebook.
 * Restores entry content/keys in the draft if the entry existed before the sync;
 * removes it from the draft if it didn't. Syncs s.name to the parent entry's
 * comment so the dropdown label stays accurate. Memory-only — no disk write.
 * @param {number} idx  Index into state._lorebookSuggestions.
 */
export function revertLbSuggestion(idx) {
    const s = state._lorebookSuggestions[idx];
    if (!s) return;

    const uidStr = s.linkedUid !== null ? String(s.linkedUid) : null;

    if (uidStr !== null) {
        const parentEntry = state._parentNodeLorebook?.entries?.[uidStr];
        if (parentEntry) {
            // Entry existed before this sync — restore to parent node state
            const entry = state._draftLorebook?.entries?.[uidStr];
            if (entry) {
                entry.comment = parentEntry.comment || '';
                entry.key     = Array.isArray(parentEntry.key) ? [...parentEntry.key] : [];
                entry.content = parentEntry.content || '';
            }
        } else {
            // Entry did not exist before this sync — remove it
            if (state._draftLorebook?.entries) delete state._draftLorebook.entries[uidStr];
        }
    }

    if (uidStr !== null) {
        const parentEntry = state._parentNodeLorebook?.entries?.[uidStr];
        // Keep s.name in sync with what the draft now shows (for the dropdown label).
        // keys/content live in _draftLorebook; no fields to clear here.
        if (parentEntry) s.name = parentEntry.comment || '';
    }

    s.status = 'rejected';

    // Update ingester dropdown label
    $('#cnz-lb-suggestion-select option')
        .eq(idx)
        .text(escapeHtml(`\u2717 ${s.type}: ${s.name}`));

    // Refresh both panels if visible
    if (state._lbActiveIngesterIndex === idx) {
        renderLbIngesterDetail(s);
        updateLbDiff();
    }
}

// ─── Internal dependency (forward reference) ─────────────────────────────────
// renderLbIngesterDetail lives in modal/lb-workshop.js; import is deferred to
// avoid circular dependencies at module evaluation time.

async function renderLbIngesterDetail(suggestion) {
    try {
        const { renderLbIngesterDetail: fn } = await import('../modal/lb-workshop.js');
        fn(suggestion);
    } catch (err) {
        console.error('[CNZ] renderLbIngesterDetail deferred import failed:', err);
    }
}

/**
 * LCS-based word diff. Returns an HTML string with del/ins spans.
 * @param {string} base
 * @param {string} proposed
 * @returns {string}
 */
export function wordDiff(base, proposed) {
    const tokenise = str => str.match(/[^\s]+\s*|\s+/g) || [];
    const bt = tokenise(base);
    const pt = tokenise(proposed);
    const m  = bt.length, n = pt.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = bt[i] === pt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = []; let del = [], ins = [];
    const flush = () => {
        if (del.length) { out.push(`<span class="cnz-diff-del">${escapeHtml(del.join(''))}</span>`); del = []; }
        if (ins.length) { out.push(`<span class="cnz-diff-ins">${escapeHtml(ins.join(''))}</span>`); ins = []; }
    };
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && bt[i] === pt[j]) { flush(); out.push(escapeHtml(bt[i])); i++; j++; }
        else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { ins.push(pt[j]); j++; }
        else { del.push(bt[i]); i++; }
    }
    flush();
    return out.join('');
}