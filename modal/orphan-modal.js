/**
 * @file data/default-user/extensions/canonize/modal/orphan-modal.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Opens, populates, and closes the Orphan Review modal. Renders a list of
 * unreferenced CNZ RAG files with per-row preview and delete controls, plus a
 * delete-all action. Owns its own open/close DOM lifecycle.
 *
 * @api-declaration
 * openOrphanModal(orphans)
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM, /api/files/delete via cnzDeleteFile]
 */

import { escapeHtml } from '../state.js';
import { cnzDeleteFile } from '../rag/api.js';

function closeOrphanModal() {
    $('#cnz-orphan-overlay').addClass('cnz-hidden');
}

/**
 * Opens the Orphan Review modal for a given list of orphaned file paths.
 * @param {string[]} orphans  Client-relative paths of unreferenced files.
 */
export function openOrphanModal(orphans) {
    const $overlay = $('#cnz-orphan-overlay');
    const $body    = $('#cnz-orphan-body');
    const $footer  = $overlay.find('.cnz-orphan-footer');

    $body.empty();
    $footer.show();

    if (!orphans.length) {
        $body.append('<div class="cnz-li-empty">No orphaned files found.</div>');
        $footer.hide();
        $overlay.removeClass('cnz-hidden');
        return;
    }

    $('#cnz-orphan-title').text(`Orphaned Files — ${orphans.length} file${orphans.length !== 1 ? 's' : ''}`);

    function checkResolved() {
        if ($body.find('.cnz-orphan-row').length === 0) {
            $body.html('<div class="cnz-li-empty">All orphaned files resolved.</div>');
            $footer.hide();
        }
    }

    orphans.forEach(path => {
        const filename = path.split('/').pop();
        const $row = $(`
<div class="cnz-orphan-row" data-path="${escapeHtml(path)}">
  <div class="cnz-orphan-row-header">
    <span class="cnz-orphan-filename">${escapeHtml(filename)}</span>
    <button class="cnz-orphan-preview-btn cnz-btn cnz-btn-secondary cnz-btn-sm">Preview</button>
    <button class="cnz-orphan-delete-btn cnz-btn cnz-btn-danger cnz-btn-sm">Delete</button>
  </div>
  <div class="cnz-orphan-preview-panel cnz-hidden"></div>
</div>`);

        $row.find('.cnz-orphan-preview-btn').on('click', async function () {
            const $panel = $row.find('.cnz-orphan-preview-panel');
            if (!$panel.hasClass('cnz-hidden')) {
                $panel.addClass('cnz-hidden');
                $(this).text('Preview');
                return;
            }
            $(this).text('Loading…').prop('disabled', true);
            try {
                const res  = await fetch(path);
                const text = res.ok ? await res.text() : `(fetch failed: HTTP ${res.status})`;
                $panel.text(text);
            } catch (err) {
                $panel.text(`(fetch error: ${err.message})`);
            }
            $panel.removeClass('cnz-hidden');
            $(this).text('Collapse').prop('disabled', false);
        });

        $row.find('.cnz-orphan-delete-btn').on('click', async function () {
            $(this).prop('disabled', true);
            await cnzDeleteFile(path);
            $row.remove();
            checkResolved();
        });

        $body.append($row);
    });

    $('#cnz-orphan-delete-all').off('click.orphan').on('click.orphan', async function () {
        $(this).prop('disabled', true);
        const paths = $body.find('.cnz-orphan-row').map((_, el) => $(el).data('path')).get();
        for (const p of paths) { await cnzDeleteFile(p); }
        $body.find('.cnz-orphan-row').remove();
        checkResolved();
    });

    $('#cnz-orphan-close').off('click.orphan').on('click.orphan', closeOrphanModal);
    $overlay.off('click.orphan').on('click.orphan', closeOrphanModal);
    $('#cnz-orphan-modal').off('click.orphan').on('click.orphan', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');
}
