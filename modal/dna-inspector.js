/**
 * @file data/default-user/extensions/canonize/modal/dna-inspector.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Opens, populates, and closes the DNA Chain Inspector modal. Reads the DNA
 * chain from the current chat, verifies RAG files on disk via a single batch
 * request, then renders the anchor list and RAG coverage map. Owns its own
 * open/close DOM lifecycle. No orchestration, no state mutation outside the DOM.
 *
 * @api-declaration
 * openDnaChainInspector()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [DOM, /api/files/verify, extension_settings.character_attachments]
 */

import { extension_settings } from '../../../../extensions.js';
import { getRequestHeaders } from '../../../../../script.js';
import { escapeHtml } from '../state.js';
import { readDnaChain } from '../core/dna-chain.js';
import { warn } from '../log.js';

function closeDnaChainInspector() {
    $('#cnz-li-overlay').addClass('cnz-hidden');
}

/**
 * Opens the DNA Chain Inspector modal for the current character.
 * Renders uncommitted pair count, RAG coverage map, and full anchor history.
 */
export async function openDnaChainInspector() {
    const ctx      = SillyTavern.getContext();
    const char     = ctx?.characters?.[ctx?.characterId];
    const messages = ctx?.chat ?? [];
    const chain    = readDnaChain(messages);

    const $overlay = $('#cnz-li-overlay');
    const $title   = $('#cnz-li-title');
    const $body    = $('#cnz-li-body');

    $title.text(`DNA Chain — ${char?.name ?? 'Unknown'}`);
    $body.empty();

    $('#cnz-li-close').off('click.li').on('click.li', closeDnaChainInspector);
    $overlay.off('click.li').on('click.li', closeDnaChainInspector);
    $('#cnz-li-modal').off('click.li').on('click.li', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');

    // ── Section 1: Uncommitted pairs ──────────────────────────────────────────
    const afterAnchor = chain.lkgMsgIdx >= 0 ? messages.slice(chain.lkgMsgIdx + 1) : messages;
    const uncommitted = afterAnchor.filter(m => !m.is_system && m.is_user).length;
    const pairWord    = uncommitted === 1 ? 'pair' : 'pairs';
    $body.append(`<div class="cnz-li-summary">${uncommitted} uncommitted ${pairWord} since last update</div>`);

    // ── Section 2: RAG coverage map ───────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">Narrative Memory</div>');

    const verifiedOnDisk = new Set();

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-rag-row"><span class="cnz-li-rag-name cnz-li-status-muted">No syncs committed yet.</span></div>');
    } else {
        const attachments = extension_settings.character_attachments?.[char?.avatar] ?? [];
        const anchorUrls  = chain.anchors.map(({ anchor }) => anchor.ragUrl).filter(Boolean);
        const allUrls     = [...new Set([...anchorUrls, ...attachments.map(a => a.url)])];

        if (allUrls.length > 0) {
            try {
                const res = await fetch('/api/files/verify', {
                    method:  'POST',
                    headers: getRequestHeaders(),
                    body:    JSON.stringify({ urls: allUrls }),
                });
                if (res.ok) {
                    const verified = await res.json();
                    for (const [url, exists] of Object.entries(verified)) {
                        if (exists) verifiedOnDisk.add(url);
                    }
                }
            } catch (err) {
                warn('DnaInspector', 'RAG verify failed:', err);
            }
        }

        const total          = chain.anchors.length;
        const firstSeenLabel = new Map();

        for (let i = 0; i < chain.anchors.length; i++) {
            const { anchor } = chain.anchors[i];
            const label      = i === total - 1 ? 'HEAD' : `#${i + 1}`;
            const shortUuid  = anchor.uuid?.slice(0, 8) ?? '—';
            const labelText  = `${label}  ${shortUuid}`;

            let statusCls, statusChr, nameHtml;
            if (!anchor.ragUrl) {
                statusCls = 'cnz-li-status-warn';
                statusChr = '⚠';
                nameHtml  = '<span class="cnz-li-rag-name cnz-li-status-muted">no file</span>';
            } else {
                const onDisk = verifiedOnDisk.has(anchor.ragUrl);
                statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                statusChr = onDisk ? '✓' : '✗';
                if (firstSeenLabel.has(anchor.ragUrl)) {
                    const ref = escapeHtml(firstSeenLabel.get(anchor.ragUrl));
                    nameHtml = `<span class="cnz-li-rag-name cnz-li-status-muted">(same as ${ref})</span>`;
                } else {
                    firstSeenLabel.set(anchor.ragUrl, label);
                    const fileName = escapeHtml(anchor.ragUrl.split('/').pop());
                    nameHtml = `<span class="cnz-li-rag-name">${fileName}</span>`;
                }
            }

            $body.append(`<div class="cnz-li-rag-row">
                <span class="cnz-li-rag-label">${escapeHtml(labelText)}</span>
                <span class="cnz-li-rag-status ${statusCls}">${statusChr}</span>
                ${nameHtml}
            </div>`);
        }
    }

    // ── Section 3: Anchor list ────────────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">Sync History</div>');

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-empty">No syncs committed yet.</div>');
        return;
    }

    const total    = chain.anchors.length;
    const reversed = [...chain.anchors].reverse();

    for (let i = 0; i < reversed.length; i++) {
        const { anchor } = reversed[i];
        const label     = i === 0 ? 'HEAD' : `#${total - i}`;
        const shortUuid = anchor.uuid?.slice(0, 8) ?? '—';
        const entries   = Object.keys(anchor.lorebook?.entries ?? {}).length;
        const chunks    = anchor.ragHeaders?.length ?? 0;
        const dateStr   = anchor.committedAt ? anchor.committedAt.slice(0, 16).replace('T', ' ') : '—';
        const summary   = `${label}  ${shortUuid}  ${entries} ${entries === 1 ? 'entry' : 'entries'}  ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'}  ${dateStr}`;

        const $row      = $('<div class="cnz-li-node-row"></div>');
        const $head     = $(`<div class="cnz-li-node-header">
            <span class="cnz-li-chevron">▶</span>
            <span class="cnz-li-node-label">${escapeHtml(summary)}</span>
        </div>`);
        const $nodeBody = $('<div class="cnz-li-node-body"></div>');
        let loaded      = false;

        $head.on('click', () => {
            const expanding = !$nodeBody.hasClass('cnz-li-expanded');
            if (expanding && !loaded) {
                loaded = true;
                const lbName = escapeHtml(anchor.lorebook?.name ?? '—');
                let ragFileHtml;
                if (!anchor.ragUrl) {
                    ragFileHtml = '<span class="cnz-li-status-muted">none</span>';
                } else {
                    const fileName  = escapeHtml(anchor.ragUrl.split('/').pop());
                    const onDisk    = verifiedOnDisk.has(anchor.ragUrl);
                    const statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                    const statusChr = onDisk ? '✓' : '✗';
                    ragFileHtml = `<span class="${statusCls}">${statusChr}</span> ${fileName}`;
                }
                $nodeBody.html(`
                    <div class="cnz-li-field"><span class="cnz-li-field-label">UUID: </span>${escapeHtml(anchor.uuid ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Parent: </span>${escapeHtml(anchor.parentUuid ?? 'root')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Committed: </span>${escapeHtml(anchor.committedAt ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Lorebook: </span>${lbName}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">RAG file: </span>${ragFileHtml}</div>
                    <div class="cnz-li-field cnz-li-hooks-block">
                        <span class="cnz-li-field-label">Hooks:</span>
                        <div class="cnz-li-hooks-preview">${escapeHtml(anchor.hooks || '(none)')}</div>
                    </div>
                `);
            }
            $nodeBody.toggleClass('cnz-li-expanded', expanding);
            $head.find('.cnz-li-chevron').text(expanding ? '▼' : '▶');
        });

        $row.append($head).append($nodeBody);
        $body.append($row);
    }
}
