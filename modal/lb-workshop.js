/**
 * @file data/default-user/extensions/canonize/modal/lb-workshop.js
 * @stamp {"utc":"2026-03-28T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role UI Builder
 * @description
 * Owns Step 2 of the review modal (Lorebook Workshop). Manages the suggestion
 * ingester UI, targeted generate, and draft staging. All entry edits go to
 * state._draftLorebook only — no disk writes until Finalize. The ingester cycles
 * through AI suggestions and lets the user apply, reject, or revert each one
 * individually, with freeform editing available at any point.
 *
 * Single source of truth: _draftLorebook is the only store for entry content.
 * Suggestion objects carry { type, name, status, linkedUid, _aiSnapshot } only.
 * name stays on the suggestion for the dropdown label (needed even when the draft
 * entry is gone, e.g. deleted entries). _aiSnapshot is the "what the AI said"
 * reference for the ← Latest button.
 *
 * Editor → draft write pattern:
 *   On every keystroke: s.name is updated synchronously (keeps dropdown label live),
 *   and {uid, name, keys, content} are captured into state._lbPendingWrite.
 *   On blur (user clicks away from any editor field): flushLbEditorToDraft() writes
 *   the captured values to _draftLorebook and refreshes the diff + freeform panels.
 *   Any action that commits or navigates (Apply, Reject, Switch suggestion, Load
 *   Latest/Prev, Regen) either flushes or cancels the pending write first.
 *
 * @api-declaration
 * setLbLoading, flushLbEditorToDraft,
 * onLbRegenClick, onLbTabSwitch, populateLbIngesterDropdown,
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
 *                       state._lbPendingWrite, state._lorebookData,
 *                       state._parentNodeLorebook, state._lbRegenGen]
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
 * Writes the staged editor values (captured at last keystroke) to _draftLorebook,
 * then refreshes the diff panel and freeform. No-op if nothing is pending.
 * Called on: blur from any editor field, suggestion switch, Apply, Apply All,
 * Regen, and any action that reads draft content before acting.
 */
export function flushLbEditorToDraft() {
    if (!state._lbPendingWrite) return;
    const { uid, name, keys, content } = state._lbPendingWrite;
    state._lbPendingWrite = null;
    if (uid === null) return;
    const entry = state._draftLorebook?.entries?.[String(uid)];
    if (entry) {
        entry.comment = name;
        entry.key     = keys;
        entry.content = content;
    }
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Freeform Regen: fires a full lorebook sync AI call, resets the draft to the
 * parent node baseline, and rebuilds the suggestion list from scratch.
 * Asks for confirmation because it discards any corrections already made.
 */
export async function onLbRegenClick() {
    setLbLoading(true);
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
    if (!confirmed) {
        setLbLoading(false);
        return;
    }
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

    const thisGen = ++state._lbRegenGen;
    import('../core/llm-calls.js').then(({ runLorebookSyncCall }) => {
        runLorebookSyncCall(transcript, preSyncLorebook)
            .then(text => {
                if (state._lbRegenGen !== thisGen) return;

                // Reset draft AND server-copy baseline to pre-sync state (captured before this
                // async call).  Both must share the same reference point so isDraftDirty only
                // fires when the AI actually produced changes — otherwise a regen that yields
                // no suggestions would compare state._draftLorebook (A) against a stale state._lorebookData
                // that reflects a previously-committed lorebook (B), producing a false dirty and
                // overwriting B with A on Finalize.
                state._draftLorebook = structuredClone(preSyncLorebook);
                state._lorebookData  = structuredClone(preSyncLorebook);
                state._lbPendingWrite = null;

                // Parse and enrich suggestions (objects now carry no keys/content).
                const suggestions = parseLbSuggestions(text);
                state._lorebookSuggestions = enrichLbSuggestions(suggestions);

                // Provision draft entries: update existing entries with AI content,
                // create new draft entries for suggestions not yet in the lorebook.
                for (const s of state._lorebookSuggestions) {
                    if (s.linkedUid !== null) {
                        const entry = state._draftLorebook.entries[String(s.linkedUid)];
                        if (entry) {
                            entry.comment = s.name;
                            entry.key     = [...s._aiSnapshot.keys];
                            entry.content = s._aiSnapshot.content;
                        }
                    } else {
                        const uid = nextLorebookUid();
                        state._draftLorebook.entries[String(uid)] = makeLbDraftEntry(
                            uid, s.name, s._aiSnapshot.keys, s._aiSnapshot.content,
                        );
                        s.linkedUid = uid;
                    }
                    s.status = 'pending';
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
        const prefix = s.status === 'deleted'  ? '\u2716 '
                     : s.status === 'applied'  ? '\u2713 '
                     : s.status === 'rejected' ? '\u2717 '
                     : '';
        const label  = s.status === 'deleted'
            ? `${prefix}DELETE: ${s.name}`
            : `${prefix}${s.type}: ${s.name}`;
        $sel.append(`<option value="${i}">${escapeHtml(label)}</option>`);
    });
    $sel.val(state._lbActiveIngesterIndex);
    $('#cnz-lb-apply-one, #cnz-lb-apply-all-unresolved').prop('disabled', false);
}

/**
 * Populates the shared editor fields and manages all ingester button states for
 * the given suggestion. Reads entry content from _draftLorebook — the single
 * source of truth. This is the single authoritative place for verdict button
 * enable/disable logic — do not add button state changes elsewhere.
 * @param {object} suggestion  A state._lorebookSuggestions entry.
 */
export function renderLbIngesterDetail(suggestion) {
    if (!suggestion) return;
    const isDeleted = suggestion.status === 'deleted';

    if (isDeleted) {
        $('#cnz-lb-editor-name').val(suggestion.name);
        $('#cnz-lb-editor-keys').val('');
        $('#cnz-lb-editor-content').val('');
    } else {
        const entry = state._draftLorebook?.entries?.[String(suggestion.linkedUid)];
        $('#cnz-lb-editor-name').val(entry?.comment ?? suggestion.name);
        $('#cnz-lb-editor-keys').val(entry?.key?.join(', ') ?? '');
        $('#cnz-lb-editor-content').val(entry?.content ?? '');
    }
    $('#cnz-lb-error-ingester').addClass('cnz-hidden').text('');

    const isLoading  = !!state._lorebookLoading;
    const isApplied  = suggestion.status === 'applied';
    const isRejected = suggestion.status === 'rejected';

    // Editor is readonly while a regen is in-flight or the entry is deleted
    $('#cnz-lb-editor-name, #cnz-lb-editor-keys, #cnz-lb-editor-content').prop('readonly', isDeleted || isLoading);

    // ← Latest / Regen: meaningless once the entry is marked for deletion
    const hasAiSnapshot = !!(suggestion._aiSnapshot?.content);
    $('#cnz-lb-btn-latest').prop('disabled', !hasAiSnapshot || isDeleted || isLoading);
    $('#cnz-lb-btn-regen').prop('disabled', isDeleted || isLoading);

    // ← Prev: the only way to un-delete — enabled when a parent-node baseline exists
    const hasPrev = suggestion.linkedUid !== null &&
        !!(state._parentNodeLorebook?.entries?.[String(suggestion.linkedUid)]);
    $('#cnz-lb-btn-prev').prop('disabled', !hasPrev || isLoading);

    // Verdict buttons: Apply and Reject are both disabled for deleted entries.
    // Use ← Prev to restore the entry to its parent-node state.
    $('#cnz-lb-apply-one').prop('disabled',  isApplied  || isDeleted || isLoading);
    $('#cnz-lb-reject-one').prop('disabled', isRejected || isDeleted || isLoading);
    $('#cnz-lb-delete-one').prop('disabled', isDeleted || isLoading);
    updateLbDiff();
}

export function onLbSuggestionSelectChange() {
    flushLbEditorToDraft();
    const idx = parseInt($('#cnz-lb-suggestion-select').val(), 10);
    if (!isNaN(idx) && state._lorebookSuggestions[idx]) {
        state._lbActiveIngesterIndex = idx;
        renderLbIngesterDetail(state._lorebookSuggestions[idx]);
    }
}

/**
 * On every keystroke: update s.name synchronously (dropdown label stays live),
 * and capture all three values into state._lbPendingWrite for flush-on-blur.
 * The actual draft write happens in flushLbEditorToDraft(), called on blur.
 */
export function onLbIngesterEditorInput() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s || s.status === 'deleted') return;

    const name    = $('#cnz-lb-editor-name').val();
    const keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#cnz-lb-editor-content').val();

    // Sync dropdown label immediately so it tracks the user's typing.
    s.name = name;
    const prefix = s.status === 'applied' ? '\u2713 ' : s.status === 'rejected' ? '\u2717 ' : '';
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${name}`));

    // Capture for flush-on-blur. uid captured at keystroke time to avoid
    // writing stale values if the suggestion changes before blur fires.
    state._lbPendingWrite = { uid: s.linkedUid, name, keys, content };
}

/** ← Latest: loads the most recent AI snapshot into the draft and editor. */
export function onLbIngesterLoadLatest() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s || !s._aiSnapshot) return;
    state._lbPendingWrite = null; // discard pending edit — we're overwriting the draft
    s.name = s._aiSnapshot.name;
    const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
    if (entry) {
        entry.comment = s._aiSnapshot.name;
        entry.key     = [...s._aiSnapshot.keys];
        entry.content = s._aiSnapshot.content;
    }
    renderLbIngesterDetail(s);
    const prefix = s.status === 'applied' ? '\u2713 ' : s.status === 'rejected' ? '\u2717 ' : '';
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    syncFreeformFromSuggestions();
}

/** ← Prev: loads the pre-sync version of this entry into the draft and editor. */
export function onLbIngesterLoadPrev() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s || s.linkedUid === null) return;

    const uidStr      = String(s.linkedUid);
    const parentEntry = state._parentNodeLorebook?.entries?.[uidStr];
    if (!parentEntry) return;  // new entry — no parent-node baseline

    state._lbPendingWrite = null; // discard pending edit — we're overwriting the draft

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
    s.name   = entry.comment;
    s.status = 'pending';

    renderLbIngesterDetail(s);
    const prefix = s.status === 'deleted'  ? '\u2716 '
                 : s.status === 'applied'  ? '\u2713 '
                 : s.status === 'rejected' ? '\u2717 '
                 : '';
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex)
        .text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Regenerate: fires a fresh targeted AI call for the currently loaded entry.
 * Lands in the draft and editor, keeps the suggestion unresolved for review.
 */
export function onLbIngesterRegenerate() {
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s) return;

    flushLbEditorToDraft(); // ensure draft is current before reading it for the AI call

    // Mode: 'new' for brand-new entries (no parent-node baseline), 'update' otherwise.
    const hasParent = !!(state._parentNodeLorebook?.entries?.[String(s.linkedUid)]);
    const mode      = (s.type === 'NEW' && !hasParent) ? 'new' : 'update';

    const entry   = state._draftLorebook?.entries?.[String(s.linkedUid)] ?? null;
    const keys    = entry ? (Array.isArray(entry.key) ? entry.key.join(', ') : '') : s._aiSnapshot.keys.join(', ');
    const content = entry?.content ?? s._aiSnapshot.content;

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
                s.name        = fresh.name;
                s._aiSnapshot = { name: fresh.name, keys: [...fresh.keys], content: fresh.content };
                s.status      = 'pending';

                // Write AI result directly to draft (single source of truth).
                const draftEntry = state._draftLorebook?.entries?.[String(s.linkedUid)];
                if (draftEntry) {
                    draftEntry.comment = fresh.name;
                    draftEntry.key     = [...fresh.keys];
                    draftEntry.content = fresh.content;
                }

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
        if (state._lorebookSuggestions[i].status === 'pending') {
            state._lbActiveIngesterIndex = i;
            $('#cnz-lb-suggestion-select').val(i);
            renderLbIngesterDetail(state._lorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All lorebook suggestions have been reviewed.');
}

/**
 * Apply: flush any pending editor write, then mark the suggestion applied.
 * All entry data lives in _draftLorebook — no data copying needed.
 */
export function onLbIngesterApply() {
    flushLbEditorToDraft();
    const s = state._lorebookSuggestions[state._lbActiveIngesterIndex];
    if (!s) return;
    const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
    if (!entry?.comment || !entry?.content) return;
    s.name   = entry.comment; // keep in sync with what the draft shows
    s.status = 'applied';
    $('#cnz-lb-suggestion-select option').eq(state._lbActiveIngesterIndex).text(escapeHtml(`\u2713 ${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Reject: cancel any pending editor write (revert will overwrite the draft),
 * then revert the draft entry to its parent-node baseline.
 */
export function onLbIngesterReject() {
    state._lbPendingWrite = null; // cancel — revertLbSuggestion overwrites draft anyway
    revertLbSuggestion(state._lbActiveIngesterIndex);
    syncFreeformFromSuggestions();
}

/**
 * Apply All Unresolved: flush the active suggestion's pending write, then mark
 * all pending suggestions applied. Draft already has all content from provisioning —
 * no data copying needed.
 */
export async function onLbApplyAllUnresolved() {
    const unresolved = state._lorebookSuggestions.filter(s => s.status === 'pending');
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

    flushLbEditorToDraft(); // flush the active suggestion's pending edit before iterating

    for (const s of unresolved) {
        const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
        if (!entry?.comment || !entry?.content) continue;
        s.name   = entry.comment; // keep in sync with draft
        s.status = 'applied';
    }
    populateLbIngesterDropdown();
    if (state._lorebookSuggestions[state._lbActiveIngesterIndex]) renderLbIngesterDetail(state._lorebookSuggestions[state._lbActiveIngesterIndex]);
    syncFreeformFromSuggestions();
    toastr.success(`Applied ${count} lorebook suggestion${count !== 1 ? 's' : ''} — will be saved on Finalize.`);
}

/**
 * Lane 2 — Generate: fires a targeted NEW-entry AI call for the supplied keyword.
 * The result is provisioned immediately into _draftLorebook (uid assigned at once)
 * then loaded into the shared editor.
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
                const name  = fresh.name || keyword;

                // Provision draft entry immediately — no suggestion ever lives without a uid.
                const uid = nextLorebookUid();
                state._draftLorebook.entries[String(uid)] = makeLbDraftEntry(uid, name, fresh.keys, fresh.content);

                const newSuggestion = {
                    type:        fresh.type || 'NEW',
                    name,
                    linkedUid:   uid,
                    status:      'pending',
                    _aiSnapshot: { name, keys: [...fresh.keys], content: fresh.content },
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
