/**
 * @file data/default-user/extensions/canonize/modal/lb-workshop.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role UI Builder
 * @description
 * Owns Step 2 of the review modal (Lorebook Workshop). Manages the suggestion
 * ingester UI, targeted generate, and draft staging. All entry edits go to
 * state._draftLorebook only — no disk writes until Finalize. The ingester cycles
 * through AI suggestions and lets the user apply, reject, or revert each one
 * individually, with freeform editing available at any point.
 *
 * @api-declaration
 * setLbLoading, onLbRegenClick, onLbTabSwitch, populateLbIngesterDropdown,
 * populateTargetedEntrySelect, renderLbIngesterDetail,
 * onLbSuggestionSelectChange, onLbIngesterEditorInput, onLbIngesterApply,
 * onLbIngesterReject, onLbIngesterLoadLatest, onLbIngesterLoadPrev,
 * onLbIngesterRegenerate, onLbIngesterNext, onLbApplyAllUnresolved,
 * onTargetedGenerateClick
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._lorebookLoading, state._lorebookSuggestions,
 *                       state._draftLorebook, state._lbActiveIngesterIndex,
 *                       state._lbDebounceTimer, state._lorebookData,
 *                       state._parentNodeLorebook]
 *     external_io: [generateRaw]
 */

import { callPopup } from '../../../../../script.js';
import { state, escapeHtml } from '../state.js';
import { getSettings } from '../core/settings.js';
import {
    parseLbSuggestions, enrichLbSuggestions, matchEntryByComment, nextLorebookUid,
    makeLbDraftEntry, updateLbDiff, syncFreeformFromSuggestions, revertLbSuggestion,
    deleteLbEntry,
} from '../lorebook/utils.js';
import { buildModalTranscript, buildSyncWindowTranscript } from './hooks-workshop.js';

// ─── Modal: Lorebook Workshop ─────────────────────────────────────────────────

export function setLbLoading(isLoading) {
    state._lorebookLoading = isLoading;
    $('#cnz-lb-spinner').toggleClass('cnz-hidden', !isLoading);
    $('#cnz-lb-freeform-regen').prop('disabled', isLoading);
    if (isLoading) $('#cnz-lb-freeform').val('');
}


export function showLbError(message) {
    setLbLoading(false);
    $('#cnz-lb-error').text(message).removeClass('cnz-hidden');
}

/**
 * Freeform Regen: fires a full lorebook sync AI call, resets the draft to the
 * parent node baseline, and rebuilds the suggestion list from scratch.
 * Asks for confirmation because it discards any corrections already made.
 */
export async function onLbRegenClick() {
    // Lower CNZ overlay z-index temporarily so callPopup renders above it.
    const $overlay = $('#cnz-overlay');
    $overlay.css('z-index', '1');
    let confirmed;
    try {
        confirmed = await callPopup(
            'This will run a fresh lorebook AI call and rebuild the suggestion list from scratch, resetting to the parent node baseline and discarding any corrections or previously committed lorebook changes made in this session. Continue?',
            'confirm',
        );
    } finally {
        $overlay.css('z-index', '');
    }
    if (!confirmed) return;

    setLbLoading(true);
    $('#cnz-lb-error').addClass('cnz-hidden').text('');

    // preSyncLorebook = parent anchor's lorebook — set by openReviewModal from DNA chain.
    // Falls back to state._lorebookData if no parent anchor exists (first sync).
    const preSyncLorebook = state._parentNodeLorebook
        ? structuredClone(state._parentNodeLorebook)
        : structuredClone(state._lorebookData ?? { entries: {} });

    const horizon       = getSettings().chunkEveryN ?? 20;
    const upToLatest    = $('#cnz-lb-up-to-latest').is(':checked');
    const lbRegenMsgs   = SillyTavern.getContext().chat ?? [];
    const lbRegenSet    = getSettings();
    const transcript    = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, lbRegenMsgs, lbRegenSet);

    import('../core/llm-calls.js').then(({ runLorebookSyncCall }) => {
        runLorebookSyncCall(transcript, preSyncLorebook)
            .then(text => {

                // Reset draft AND server-copy baseline to pre-sync state (captured before this
                // async call).  Both must share the same reference point so isDraftDirty only
                // fires when the AI actually produced changes — otherwise a regen that yields
                // no suggestions would compare state._draftLorebook (A) against a stale state._lorebookData
                // that reflects a previously-committed lorebook (B), producing a false dirty and
                // overwriting B with A on Finalize.
                state._draftLorebook = structuredClone(preSyncLorebook);
                state._lorebookData  = structuredClone(preSyncLorebook);

                // Parse and auto-apply new suggestions
                const suggestions = parseLbSuggestions(text);
                state._lorebookSuggestions = enrichLbSuggestions(suggestions);

                for (const s of state._lorebookSuggestions) {
                    if (s.linkedUid !== null) {
                        const entry = state._draftLorebook.entries[String(s.linkedUid)];
                        if (entry) {
                            entry.comment = s.name;
                            entry.key     = s.keys;
                            entry.content = s.content;
                        }
                    } else {
                        const uid = nextLorebookUid();
                        state._draftLorebook.entries[String(uid)] = makeLbDraftEntry(uid, s.name, s.keys, s.content);
                        s.linkedUid = uid;
                    }
                    s._applied = false;
                }

                setLbLoading(false);
                state._lbActiveIngesterIndex = Math.max(0, Math.min(state._lbActiveIngesterIndex, state._lorebookSuggestions.length - 1));
                populateLbIngesterDropdown();
                if (state._lorebookSuggestions[state._lbActiveIngesterIndex]) renderLbIngesterDetail(state._lorebookSuggestions[state._lbActiveIngesterIndex]);
                syncFreeformFromSuggestions();
            })
            .catch(err => {
                showLbError(`Regeneration failed: ${err.message}`);
            });
    });
}

/**
 * Activates the named lorebook tab (freeform / ingester).
 * @param {string} tabName  One of 'freeform', 'ingester'.
 */
export function onLbTabSwitch(tabName) {
    $('#cnz-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-lb-tab-freeform').toggleClass('cnz-hidden',  tabName !== 'freeform');
    $('#cnz-lb-tab-ingester').toggleClass('cnz-hidden',  tabName !== 'ingester');

    if (tabName === 'ingester' && !state._lorebookLoading) {
        state._lbActiveIngesterIndex = Math.max(0, Math.min(state._lbActiveIngesterIndex, state._lorebookSuggestions.length - 1));
        populateLbIngesterDropdown();
        populateTargetedEntrySelect();
        if (state._lorebookSuggestions[state._lbActiveIngesterIndex]) renderLbIngesterDetail(state._lorebookSuggestions[state._lbActiveIngesterIndex]);
    }
}

/**
 * Populates the targeted-generate entry dropdown from current state._lorebookData.
 * Preserves the current selection if the entry still exists.
 */
export function populateTargetedEntrySelect() {
    const $sel    = $('#cnz-targeted-entry-select');
    const prevVal = $sel.val();
    $sel.empty().append('<option value="">— Select entry —</option>');

    const entries = state._draftLorebook?.entries ?? {};
    const sorted  = Object.values(entries)
        .sort((a, b) => (a.comment || '').localeCompare(b.comment || ''));

    for (const entry of sorted) {
        const name = entry.comment || String(entry.uid);
        $sel.append($('<option>').val(String(entry.uid)).text(name));
    }

    $sel.val(prevVal);  // jQuery no-ops silently if prevVal no longer exists
}

export function populateLbIngesterDropdown() {
    const $sel = $('#cnz-lb-suggestion-select').empty();
    if (!state._lorebookSuggestions.length) {
        $sel.append('<option disabled selected>(no sync changes — use Lane 2 or 3 to add entries)</option>');
        $('#cnz-lb-apply-one, #cnz-lb-reject-one, #cnz-lb-delete-one, #cnz-lb-apply-all-unresolved').prop('disabled', true);
        $('#cnz-lb-editor-name, #cnz-lb-editor-keys, #cnz-lb-editor-content').val('');
        $('#cnz-lb-ingester-diff').empty();
        return;
    }
    state._lorebookSuggestions.forEach((s, i) => {
        const prefix = s._deleted  ? '\u2716 '
                     : s._applied  ? '\u2713 '
                     : s._rejected ? '\u2717 '
                     : '';
        const label  = s._deleted
            ? `${prefix}DELETE: ${s.name}`
            : `${prefix}${s.type}: ${s.name}`;
        $sel.append(`<option value="${i}">${escapeHtml(label)}</option>`);
    });
    $sel.val(state._lbActiveIngesterIndex);
    $('#cnz-lb-apply-one, #cnz-lb-apply-all-unresolved').prop('disabled', false);
}

/**
 * Populates the shared editor fields and manages all ingester button states for
 * the given suggestion. This is the single authoritative place for verdict button
 * enable/disable logic — do not add button state changes elsewhere.
 * @param {object} suggestion  A state._lorebookSuggestions entry.
 */
export function renderLbIngesterDetail(suggestion) {
    if (!suggestion) return;
    $('#cnz-lb-editor-name').val(suggestion.name);
    $('#cnz-lb-editor-keys').val(suggestion.keys.join(', '));
    $('#cnz-lb-editor-content').val(suggestion.content);
    $('#cnz-lb-error-ingester').addClass('cnz-hidden').text('');
    // ← Latest: disabled if the AI never generated anything for this entry
    const hasAiSnapshot = !!(suggestion._aiSnapshot?.content);
    $('#cnz-lb-btn-latest').prop('disabled', !hasAiSnapshot);
    // ← Prev: disabled for brand-new entries; enabled on deleted entries with a prior version
    const hasPrev = suggestion.linkedUid !== null &&
        !!(state._parentNodeLorebook?.entries?.[String(suggestion.linkedUid)]);
    $('#cnz-lb-btn-prev').prop('disabled', !hasPrev);
    // Verdict buttons: whichever verdict is active is disabled; the others are enabled
    const isDeleted  = !!suggestion._deleted;
    const isApplied  = !!suggestion._applied  && !isDeleted;
    const isRejected = !!suggestion._rejected && !isDeleted;
    $('#cnz-lb-apply-one').prop('disabled',  isApplied);
    $('#cnz-lb-reject-one').prop('disabled', isRejected);
    $('#cnz-lb-delete-one').prop('disabled', isDeleted);
    updateLbDiff();
}

export function onLbSuggestionSelectChange() {
    const idx = parseInt($('#cnz-lb-suggestion-select').val(), 10);
    if (!isNaN(idx) && state._lorebookSuggestions[idx]) {
        state._lbActiveIngesterIndex = idx;
        renderLbIngesterDetail(state._lorebookSuggestions[idx]);
    }
}

export function onLbIngesterEditorInput() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (s) {
        const newName = $('#cnz-lb-editor-name').val();
        s.name    = newName;
        s.keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
        s.content = $('#cnz-lb-editor-content').val();
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${newName}`));
        // Continuously sync state._draftLorebook so corrections are never lost
        if (s.linkedUid !== null) {
            const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
            if (entry) {
                entry.comment = s.name;
                entry.key     = s.keys;
                entry.content = s.content;
            }
        }
    }
    clearTimeout(state._lbDebounceTimer);
    state._lbDebounceTimer = setTimeout(() => { updateLbDiff(); syncFreeformFromSuggestions(); }, 300);
}

/** ← Latest: loads the most recent AI snapshot back into the editor. */
export function onLbIngesterLoadLatest() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s || !s._aiSnapshot) return;
    s.name = s._aiSnapshot.name; s.keys = [...s._aiSnapshot.keys]; s.content = s._aiSnapshot.content;
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    syncFreeformFromSuggestions();
}

/** ← Prev: loads the pre-sync version of this entry into the editor. */
export function onLbIngesterLoadPrev() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s || s.linkedUid === null) return;

    const uidStr      = String(s.linkedUid);
    const parentEntry = state._parentNodeLorebook?.entries?.[uidStr];
    if (!parentEntry) return;  // new entry — no parent-node baseline

    let entry = state._draftLorebook?.entries?.[uidStr];
    if (!entry) {
        // Entry was deleted — re-add from parent state before restoring
        if (!state._draftLorebook?.entries) return;
        state._draftLorebook.entries[uidStr] = makeLbDraftEntry(
            parseInt(uidStr, 10),
            parentEntry.comment || '',
            Array.isArray(parentEntry.key) ? [...parentEntry.key] : [],
            parentEntry.content || '',
        );
        entry = state._draftLorebook.entries[uidStr];
    }
    entry.comment = parentEntry.comment || '';
    entry.key     = Array.isArray(parentEntry.key) ? [...parentEntry.key] : [];
    entry.content = parentEntry.content || '';
    s.name    = entry.comment;
    s.keys    = [...entry.key];
    s.content = entry.content;
    s._deleted  = false;
    s._applied  = false;
    s._rejected = false;

    renderLbIngesterDetail(s);
    const prefix = s._deleted  ? '\u2716 '
                 : s._applied  ? '\u2713 '
                 : s._rejected ? '\u2717 '
                 : '';
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex)
        .text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Regenerate: fires a fresh targeted AI call for the currently loaded entry.
 * Lands in the editor, keeps the suggestion unresolved for review.
 */
export function onLbIngesterRegenerate() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s) return;

    const mode    = s.linkedUid !== null ? 'update' : 'new';
    const entry   = s.linkedUid !== null ? (state._draftLorebook?.entries?.[String(s.linkedUid)] ?? null) : null;
    const keys    = entry ? (Array.isArray(entry.key) ? entry.key.join(', ') : '') : s.keys.join(', ');
    const content = entry?.content ?? s.content;

    const horizon        = getSettings().hookseekerHorizon ?? 40;
    const upToLatest     = $('#cnz-lb-up-to-latest').is(':checked');
    const regenIngMsgs   = SillyTavern.getContext().chat ?? [];
    const regenIngSet    = getSettings();
    const transcript     = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, regenIngMsgs, regenIngSet);

    $('#cnz-lb-btn-regen').prop('disabled', true);

    import('../core/llm-calls.js').then(({ runTargetedLbCall }) => {
        runTargetedLbCall(mode, s.name, keys, content, transcript)
            .then(rawText => {
                const trimmed = rawText?.trim() ?? '';
                if (!trimmed || trimmed === 'NO CHANGES NEEDED' || trimmed === 'NO INFORMATION FOUND') {
                    toastr.info('CNZ: No changes suggested by AI.');
                    return;
                }

                const parsed = parseLbSuggestions(trimmed);
                if (!parsed.length) { toastr.warning('CNZ: Could not parse AI response.'); return; }

                const fresh = parsed[0];
                s.name    = fresh.name;
                s.keys    = [...fresh.keys];
                s.content = fresh.content;
                s._aiSnapshot = { name: fresh.name, keys: [...fresh.keys], content: fresh.content };
                s._applied  = false;
                s._rejected = false;

                renderLbIngesterDetail(s);
                $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex)
                    .text(escapeHtml(`${s.type}: ${s.name}`));
                syncFreeformFromSuggestions();
                toastr.success('CNZ: Regenerated — review in editor.');
            })
            .catch(err => {
                toastr.error(`CNZ: Regenerate failed: ${err.message}`);
            })
            .finally(() => {
                $('#cnz-lb-btn-regen').prop('disabled', false);
            });
    });
}

export function onLbIngesterNext() {
    const total = state._lorebookSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (state._lbActiveIngesterIndex + offset) % total;
        if (!state._lorebookSuggestions[i]._applied && !state._lorebookSuggestions[i]._rejected) {
            state._lbActiveIngesterIndex = i;
            $('#cnz-lb-suggestion-select').val(i);
            renderLbIngesterDetail(state._lorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All lorebook suggestions have been reviewed.');
}

export function onLbIngesterApply() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s) return;
    const name    = $('#cnz-lb-editor-name').val().trim();
    const keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#cnz-lb-editor-content').val().trim();
    if (!name || !content) return;
    s.name = name; s.keys = keys; s.content = content;
    if (s.linkedUid !== null) {
        const entry = state._draftLorebook.entries[String(s.linkedUid)];
        if (entry) { entry.comment = name; entry.key = keys; entry.content = content; }
    } else {
        const newUid = nextLorebookUid();
        state._draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
        s.linkedUid = newUid;
        // ← Prev is now enabled since we have a linked entry; update button state
        $('#cnz-lb-btn-prev').prop('disabled', !(state._parentNodeLorebook?.entries?.[String(newUid)]));
    }
    s._applied = true; s._rejected = false;

    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`\u2713 ${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

export function onLbIngesterReject() {
    revertLbSuggestion(state._lbActiveIngesterIndex);
    syncFreeformFromSuggestions();
}

export async function onLbApplyAllUnresolved() {
    const unresolved = state._lorebookSuggestions.filter(s => !s._applied && !s._rejected);
    if (!unresolved.length) { toastr.info('No unresolved lorebook suggestions to apply.'); return; }
    const count     = unresolved.length;
    const $overlay  = $('#cnz-overlay');
    $overlay.css('z-index', '1');
    let confirmed;
    try {
        confirmed = await callPopup(
            `This will apply all ${count} unreviewed suggestion${count !== 1 ? 's' : ''} to the Lorebook using the AI\'s current text. Continue?`,
            'confirm',
        );
    } finally {
        $overlay.css('z-index', '');
    }
    if (!confirmed) return;
    for (const s of unresolved) {
        const name = s.name.trim(), keys = [...s.keys], content = s.content.trim();
        if (!name || !content) continue;
        if (s.linkedUid !== null) {
            const entry = state._draftLorebook.entries[String(s.linkedUid)];
            if (entry) { entry.comment = name; entry.key = keys; entry.content = content; }
        } else {
            const newUid = nextLorebookUid();
            state._draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
            s.linkedUid = newUid;
        }
        s._applied = true; s._rejected = false;
    }
    populateLbIngesterDropdown();
    if (state._lorebookSuggestions[state._lbActiveIngesterIndex]) renderLbIngesterDetail(state._lorebookSuggestions[state._lbActiveIngesterIndex]);
    syncFreeformFromSuggestions();
    toastr.success(`Applied ${count} lorebook suggestion${count !== 1 ? 's' : ''} — will be saved on Finalize.`);
}

/**
 * Lane 2 — Generate: fires a targeted NEW-entry AI call for the supplied keyword.
 * The result is added as a new suggestion and loaded into the shared editor.
 */
export function onTargetedGenerateClick() {
    const keyword = $('#cnz-targeted-keyword').val().trim();
    if (!keyword) {
        $('#cnz-targeted-error').text('Enter a concept name.').removeClass('cnz-hidden');
        return;
    }
    $('#cnz-targeted-error').addClass('cnz-hidden').text('');

    const horizon     = getSettings().hookseekerHorizon ?? 40;
    const upToLatest  = $('#cnz-lb-up-to-latest').is(':checked');
    const tgtMessages = SillyTavern.getContext().chat ?? [];
    const tgtSettings = getSettings();
    const transcript  = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, tgtMessages, tgtSettings);

    $('#cnz-targeted-spinner').removeClass('cnz-hidden');
    $('#cnz-targeted-generate').prop('disabled', true);

    import('../core/llm-calls.js').then(({ runTargetedLbCall }) => {
        runTargetedLbCall('new', keyword, '', '', transcript)
            .then(rawText => {
                const trimmed = rawText?.trim() ?? '';
                if (!trimmed || trimmed === 'NO INFORMATION FOUND') {
                    $('#cnz-targeted-error')
                        .text(trimmed || 'AI returned no output.')
                        .removeClass('cnz-hidden');
                    return;
                }

                const parsed = parseLbSuggestions(trimmed);
                if (!parsed.length) {
                    $('#cnz-targeted-error').text('Could not parse AI response.').removeClass('cnz-hidden');
                    return;
                }

                const fresh = parsed[0];
                const newSuggestion = {
                    type:        fresh.type || 'NEW',
                    name:        fresh.name || keyword,
                    keys:        fresh.keys,
                    content:     fresh.content,
                    linkedUid:   null,
                    _applied:    false,
                    _rejected:   false,
                    _deleted:    false,
                    _aiSnapshot: { name: fresh.name || keyword, keys: [...fresh.keys], content: fresh.content },
                };

                state._lorebookSuggestions.push(newSuggestion);
                state._lbActiveIngesterIndex = state._lorebookSuggestions.length - 1;
                populateLbIngesterDropdown();
                renderLbIngesterDetail(newSuggestion);
                syncFreeformFromSuggestions();

                toastr.success('CNZ: New entry generated — review in editor.');
            })
            .catch(err => {
                $('#cnz-targeted-error').text(`Generate failed: ${err.message}`).removeClass('cnz-hidden');
            })
            .finally(() => {
                $('#cnz-targeted-spinner').addClass('cnz-hidden');
                $('#cnz-targeted-generate').prop('disabled', false);
            });
    });
}
