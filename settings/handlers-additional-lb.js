/**
 * @file data/default-user/extensions/canonize/settings/handlers-additional-lb.js
 * @stamp {"utc":"2026-06-09T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper — additional lorebook settings UI
 * @description
 * Owns all DOM interaction for the additional lorebooks section of the RAG panel.
 * Mutates state._additionalLorebooks in response to user actions, re-renders the
 * row list, and nulls the swipe cache so the next generation picks up the change.
 * Does NOT write to extension_settings — the list persists via the DNA anchor
 * on the next sync commit.
 *
 * @api-declaration
 * bindAdditionalLbHandlers(deps)      — call once after panel DOM injection
 * refreshAdditionalLbList()           — re-render list from current state
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [state._additionalLorebooks]
 *     external_io: [DOM, lorebook/api.js]
 */

import { state, escapeHtml }      from '../state.js';
import { lbListLorebooks }        from '../lorebook/api.js';
import { renderAdditionalLbRows } from './html-additional-lb.js';
import { invalidateSwipeCache }   from '../rag/generation-hook.js';
import { log, error }             from '../log.js';

// ── List render ───────────────────────────────────────────────────────────────

export function refreshAdditionalLbList() {
    const $list = $('#cnz-additional-lb-list');
    if (!$list.length) return;
    $list.html(renderAdditionalLbRows(state._additionalLorebooks ?? [], escapeHtml));
}

// ── Event binding ─────────────────────────────────────────────────────────────

export function bindAdditionalLbHandlers() {
    // Delegated handlers on the list container — survive re-renders.
    $(document).off('.cnzAddLb');

    $(document).on('change.cnzAddLb', '.cnz-additional-lb-min', function () {
        const idx = Number($(this).data('idx'));
        const lb  = state._additionalLorebooks?.[idx];
        if (!lb) return;
        lb.min = Math.max(0, parseInt($(this).val(), 10) || 0);
        _invalidateSwipeCache();
    });

    $(document).on('change.cnzAddLb', '.cnz-additional-lb-max', function () {
        const idx = Number($(this).data('idx'));
        const lb  = state._additionalLorebooks?.[idx];
        if (!lb) return;
        lb.max = Math.max(1, parseInt($(this).val(), 10) || 1);
        _invalidateSwipeCache();
    });

    $(document).on('change.cnzAddLb', '.cnz-additional-lb-bypass', function () {
        const idx = Number($(this).data('idx'));
        const lb  = state._additionalLorebooks?.[idx];
        if (!lb) return;
        lb.bypass = $(this).is(':checked');
        _invalidateSwipeCache();
    });

    $(document).on('click.cnzAddLb', '.cnz-additional-lb-remove', function () {
        const idx = Number($(this).data('idx'));
        if (isNaN(idx) || idx < 0) return;
        state._additionalLorebooks.splice(idx, 1);
        refreshAdditionalLbList();
        _invalidateSwipeCache();
        log('AddLb', `Removed lorebook at index ${idx}`);
    });

    // ── Add lorebook flow ─────────────────────────────────────────────────────

    $('#cnz-additional-lb-open-add').off('click.cnzAddLb').on('click.cnzAddLb', async function () {
        const $addRow = $('#cnz-additional-lb-add-row');
        const $select = $('#cnz-additional-lb-select');
        $select.html('<option disabled selected>Loading…</option>');
        $addRow.show();
        $(this).hide();

        try {
            const all    = (await lbListLorebooks()).map(item => item.name ?? item);
            const active = new Set((state._additionalLorebooks ?? []).map(lb => lb.name));
            const opts   = all.filter(n => !active.has(n));
            if (opts.length) {
                $select.html(opts.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join(''));
            } else {
                $select.html('<option disabled selected>No lorebooks available</option>');
            }
        } catch (err) {
            error('AddLb', 'Failed to list lorebooks:', err);
            $select.html('<option disabled selected>Error loading list</option>');
        }
    });

    $('#cnz-additional-lb-cancel').off('click.cnzAddLb').on('click.cnzAddLb', _closeAddRow);

    $('#cnz-additional-lb-confirm').off('click.cnzAddLb').on('click.cnzAddLb', function () {
        const name = $('#cnz-additional-lb-select').val();
        if (!name) return;
        if (!state._additionalLorebooks) state._additionalLorebooks = [];
        if (state._additionalLorebooks.some(lb => lb.name === name)) {
            _closeAddRow(); return;
        }
        state._additionalLorebooks.push({ name, hash: 0, min: 1, max: 3, bypass: false });
        refreshAdditionalLbList();
        _invalidateSwipeCache();
        _closeAddRow();
        log('AddLb', `Added lorebook: ${name}`);
    });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _closeAddRow() {
    $('#cnz-additional-lb-add-row').hide();
    $('#cnz-additional-lb-open-add').show();
}

function _invalidateSwipeCache() {
    invalidateSwipeCache();
}
