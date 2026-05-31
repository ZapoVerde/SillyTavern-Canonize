/**
 * @file data/default-user/extensions/canonize/modal/plot-lb-workshop.js
 * @stamp {"utc":"2026-05-31T00:00:00.000Z"}
 * @architectural-role Orchestrator
 * @description
 * Owns Step 3 of the review modal (Plot Lorebook Workshop). Two views:
 *
 * Ingester tab — shows only the entries written by the last hookseeker sync
 *   (from state._plotLorebookSuggestions, derived from anchor.plotEntries).
 *   Apply keeps the entry as-is; Delete removes it from the draft; Edit saves
 *   to draft on blur.
 *
 * Freeform tab — read-only serialisation of the same suggestion entries.
 *
 * "Load any entry" picker — secondary explorer for the full plot lorebook
 *   history; loads any entry into the editor without changing the suggestion list.
 *
 * No per-entry AI regen (hookseeker is the write path, not a lorebook curator).
 *
 * @api-declaration
 * populatePlotLbDropdown, populatePlotLbFullEntrySelect, renderPlotLbEntryDetail,
 * flushPlotLbEditorToDraft, onPlotLbTabSwitch,
 * onPlotLbEditorInput, onPlotLbApply, onPlotLbDelete,
 * onPlotLbAddEntry, onPlotLbFullEntrySelectChange, syncPlotLbFreeform,
 * onPlotLbIngesterNext
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._draftPlotLorebook, state._plotLorebookSuggestions,
 *                       state._plotLbActiveIngesterIndex, state._plotLbPendingWrite]
 *     external_io: [DOM]
 */

import { state, escapeHtml } from '../state.js';
import { makeLbDraftEntry }  from '../lorebook/utils.js';

// ─── Serialise suggestions to freeform text ───────────────────────────────────

export function syncPlotLbFreeform() {
    const lines = state._plotLorebookSuggestions
        .filter(s => s.status !== 'deleted')
        .map(s => {
            const entry = state._draftPlotLorebook?.entries?.[String(s.uid)];
            if (!entry) return null;
            return `**${entry.comment || s.name}**\n${entry.content ?? ''}`;
        })
        .filter(Boolean);
    $('#cnz-plot-lb-freeform').val(lines.join('\n\n'));
}

// ─── Tab switch ───────────────────────────────────────────────────────────────

export function onPlotLbTabSwitch(tabName) {
    $('#cnz-plot-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-plot-lb-tab-entries').toggleClass('cnz-hidden', tabName !== 'entries');
    $('#cnz-plot-lb-tab-freeform').toggleClass('cnz-hidden', tabName !== 'freeform');
    if (tabName === 'freeform') syncPlotLbFreeform();
}

// ─── Suggestion dropdown (last-sync entries) ──────────────────────────────────

export function populatePlotLbDropdown() {
    const $sel = $('#cnz-plot-lb-entry-select').empty();
    const sugs = state._plotLorebookSuggestions;

    if (!sugs.length) {
        $sel.append('<option disabled selected>(no new entries this sync)</option>');
        $('#cnz-plot-lb-apply, #cnz-plot-lb-delete').prop('disabled', true);
        $('#cnz-plot-lb-editor-name, #cnz-plot-lb-editor-content').val('').prop('readonly', true);
        return;
    }

    sugs.forEach((s, i) => {
        const prefix = s.status === 'deleted' ? '✖ ' : s.status === 'applied' ? '✓ ' : '';
        $sel.append(`<option value="${i}">${escapeHtml(prefix + s.name)}</option>`);
    });

    const idx = Math.min(state._plotLbActiveIngesterIndex, sugs.length - 1);
    state._plotLbActiveIngesterIndex = idx;
    $sel.val(idx);
    _renderFromSuggestion(sugs[idx]);
}

/** Populates the "Load any entry" picker from the full draft lorebook. */
export function populatePlotLbFullEntrySelect() {
    const $sel   = $('#cnz-plot-lb-full-entry-select').empty();
    $sel.append('<option value="">Load from history...</option>');
    const sorted = Object.values(state._draftPlotLorebook?.entries ?? {})
        .sort((a, b) => a.uid - b.uid);
    for (const e of sorted) {
        $sel.append(`<option value="${e.uid}">${escapeHtml(e.comment || String(e.uid))}</option>`);
    }
}

// ─── Editor ───────────────────────────────────────────────────────────────────

function _renderFromSuggestion(s) {
    if (!s) return;
    const isDeleted = s.status === 'deleted';
    const entry     = state._draftPlotLorebook?.entries?.[String(s.uid)];
    $('#cnz-plot-lb-editor-name').val(isDeleted ? s.name : (entry?.comment ?? s.name)).prop('readonly', isDeleted);
    $('#cnz-plot-lb-editor-content').val(isDeleted ? '' : (entry?.content ?? '')).prop('readonly', isDeleted);
    $('#cnz-plot-lb-apply').prop('disabled',  s.status === 'applied'  || isDeleted);
    $('#cnz-plot-lb-delete').prop('disabled', isDeleted);
}

export function renderPlotLbEntryDetail(entry) {
    if (!entry) return;
    $('#cnz-plot-lb-editor-name').val(entry.comment ?? '').prop('readonly', false);
    $('#cnz-plot-lb-editor-content').val(entry.content ?? '').prop('readonly', false);
    $('#cnz-plot-lb-apply, #cnz-plot-lb-delete').prop('disabled', false);
}

export function flushPlotLbEditorToDraft() {
    if (!state._plotLbPendingWrite) return;
    const { uid, name, content } = state._plotLbPendingWrite;
    state._plotLbPendingWrite = null;
    if (uid === null) return;
    const entry = state._draftPlotLorebook?.entries?.[String(uid)];
    if (!entry) return;
    entry.comment = name;
    entry.content = content;

    // Keep suggestion label in sync
    const s = state._plotLorebookSuggestions.find(x => x.uid === uid);
    if (s) s.name = name;
}

// ─── Input handlers ───────────────────────────────────────────────────────────

export function onPlotLbEditorInput() {
    const s = state._plotLorebookSuggestions[state._plotLbActiveIngesterIndex];
    const uid = s?.uid ?? _loadedUid();
    if (uid === null) return;

    const name    = $('#cnz-plot-lb-editor-name').val();
    const content = $('#cnz-plot-lb-editor-content').val();

    if (s) {
        s.name = name;
        $('#cnz-plot-lb-entry-select option').eq(state._plotLbActiveIngesterIndex)
            .text(escapeHtml((s.status === 'applied' ? '✓ ' : '') + name));
    }
    state._plotLbPendingWrite = { uid, name, content };
}

/** Returns the uid of the entry currently loaded from the full-entry picker, if any. */
function _loadedUid() {
    const val = parseInt($('#cnz-plot-lb-full-entry-select').val(), 10);
    return isNaN(val) ? null : val;
}

export function onPlotLbIngesterNext() {
    const total = state._plotLorebookSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (state._plotLbActiveIngesterIndex + offset) % total;
        if (state._plotLorebookSuggestions[i].status === 'pending') {
            flushPlotLbEditorToDraft();
            state._plotLbActiveIngesterIndex = i;
            $('#cnz-plot-lb-entry-select').val(i);
            _renderFromSuggestion(state._plotLorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All plot entries have been reviewed.');
}

export function onPlotLbSuggestionSelectChange() {
    flushPlotLbEditorToDraft();
    const idx = parseInt($('#cnz-plot-lb-entry-select').val(), 10);
    if (isNaN(idx) || !state._plotLorebookSuggestions[idx]) return;
    state._plotLbActiveIngesterIndex = idx;
    _renderFromSuggestion(state._plotLorebookSuggestions[idx]);
    $('#cnz-plot-lb-full-entry-select').val('');
}

export function onPlotLbFullEntrySelectChange() {
    flushPlotLbEditorToDraft();
    const uid = parseInt($('#cnz-plot-lb-full-entry-select').val(), 10);
    if (isNaN(uid)) return;
    const entry = state._draftPlotLorebook?.entries?.[String(uid)];
    if (!entry) return;
    // Deselect the suggestion list — this is a history browse, not a suggestion action
    $('#cnz-plot-lb-entry-select').val('');
    state._plotLbActiveIngesterIndex = -1;
    renderPlotLbEntryDetail(entry);
    state._plotLbPendingWrite = { uid: entry.uid, name: entry.comment ?? '', content: entry.content ?? '' };
}

// ─── Actions ──────────────────────────────────────────────────────────────────

/** Apply: flush and mark the suggestion confirmed. */
export function onPlotLbApply() {
    flushPlotLbEditorToDraft();
    const s = state._plotLorebookSuggestions[state._plotLbActiveIngesterIndex];
    if (!s || s.status === 'deleted') return;
    s.status = 'applied';
    $('#cnz-plot-lb-entry-select option').eq(state._plotLbActiveIngesterIndex)
        .text(escapeHtml('✓ ' + s.name));
    $('#cnz-plot-lb-apply').prop('disabled', true);
    syncPlotLbFreeform();
}

/** Delete: remove the active entry from the draft. */
export function onPlotLbDelete() {
    flushPlotLbEditorToDraft();
    state._plotLbPendingWrite = null;

    const s = state._plotLorebookSuggestions[state._plotLbActiveIngesterIndex];
    if (s) {
        delete state._draftPlotLorebook?.entries?.[String(s.uid)];
        s.status = 'deleted';
        $('#cnz-plot-lb-entry-select option').eq(state._plotLbActiveIngesterIndex)
            .text(escapeHtml('✖ ' + s.name));
        _renderFromSuggestion(s);
    } else {
        // Deleting from full-entry picker
        const uid = _loadedUid();
        if (uid !== null) {
            delete state._draftPlotLorebook?.entries?.[String(uid)];
            $('#cnz-plot-lb-full-entry-select').val('');
            $('#cnz-plot-lb-editor-name, #cnz-plot-lb-editor-content').val('');
            populatePlotLbFullEntrySelect();
        }
    }
    syncPlotLbFreeform();
}

/** Add: create a new blank entry and load it into the editor (not a suggestion). */
export function onPlotLbAddEntry() {
    flushPlotLbEditorToDraft();
    const uid   = _nextPlotUid();
    const entry = makeLbDraftEntry(uid, 'New Plot Entry', [], '');
    if (!state._draftPlotLorebook) state._draftPlotLorebook = { entries: {} };
    state._draftPlotLorebook.entries[String(uid)] = entry;
    populatePlotLbFullEntrySelect();
    $('#cnz-plot-lb-full-entry-select').val(String(uid));
    $('#cnz-plot-lb-entry-select').val('');
    state._plotLbActiveIngesterIndex = -1;
    renderPlotLbEntryDetail(entry);
    state._plotLbPendingWrite = { uid, name: entry.comment, content: entry.content };
}

function _nextPlotUid() {
    const keys = Object.keys(state._draftPlotLorebook?.entries ?? {}).map(Number).filter(n => !isNaN(n));
    return keys.length ? Math.max(...keys) + 1 : 0;
}
