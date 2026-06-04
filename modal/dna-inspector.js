/**
 * @file data/default-user/extensions/canonize/modal/dna-inspector.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Opens, populates, and closes the DNA Chain Inspector modal. Reads the DNA
 * chain from the current chat, queries the DB for per-anchor record counts,
 * then renders the anchor list and DB coverage map. Owns its own open/close
 * DOM lifecycle. No orchestration, no state mutation outside the DOM.
 *
 * @api-declaration
 * openDnaChainInspector()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io:     [DOM, file-store.js]
 */

import { escapeHtml } from '../state.js';
import { readDnaChain } from '../core/dna-chain.js';
import { warn } from '../log.js';
import { anchorStats } from '../rag/file-store.js';
import { cnzChatKey } from '../rag/api.js';

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

    // ── Section 2: DB coverage ────────────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">DB Coverage</div>');

    const statsMap = new Map(); // anchorUuid → { chunksForAnchor, lbEntriesForAnchor }

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-rag-row"><span class="cnz-li-rag-name cnz-li-status-muted">No syncs committed yet.</span></div>');
    } else {
        const chatKey   = cnzChatKey(ctx.getCurrentChatFile?.() ?? '');
        const statsList = await Promise.all(
            chain.anchors.map(({ anchor }) => anchorStats(chatKey, anchor.uuid).catch(err => {
                warn('DnaInspector', 'DB stats failed for', anchor.uuid, err);
                return null;
            }))
        );
        for (let i = 0; i < chain.anchors.length; i++) {
            if (statsList[i]) statsMap.set(chain.anchors[i].anchor.uuid, statsList[i]);
        }

        const total = chain.anchors.length;
        for (let i = 0; i < chain.anchors.length; i++) {
            const { anchor }  = chain.anchors[i];
            const label       = i === total - 1 ? 'HEAD' : `#${i + 1}`;
            const shortUuid   = anchor.uuid?.slice(0, 8) ?? '—';
            const expected    = anchor.ragHeaders?.length ?? 0;
            const s           = statsMap.get(anchor.uuid);
            const dbChunks    = s?.chunksForAnchor    ?? null;
            const dbLbTotal   = s?.lbEntriesForAnchor ?? null;
            const dbPlot      = s?.plotEntriesForAnchor ?? null;
            const dbLb        = dbLbTotal !== null && dbPlot !== null ? dbLbTotal - dbPlot : dbLbTotal;

            let statusCls, statusChr;
            if (dbChunks === null) {
                statusCls = 'cnz-li-status-warn';
                statusChr = '?';
            } else if (expected === 0 ? dbChunks === 0 : dbChunks === expected) {
                statusCls = 'cnz-li-status-ok';
                statusChr = '✓';
            } else {
                statusCls = 'cnz-li-status-warn';
                statusChr = dbChunks > expected ? '⚠' : '✗';
            }

            const chunkLabel = dbChunks === null ? '—'
                : expected > 0 ? `${dbChunks}/${expected} chunks` : `${dbChunks} chunks`;
            const lbLabel    = dbLb    !== null ? `  ${dbLb} lb`   : '';
            const plotLabel  = dbPlot  !== null && dbPlot > 0 ? `  ${dbPlot} plot` : '';

            $body.append(`<div class="cnz-li-rag-row">
                <span class="cnz-li-rag-label">${escapeHtml(`${label}  ${shortUuid}`)}</span>
                <span class="cnz-li-rag-status ${statusCls}">${statusChr}</span>
                <span class="cnz-li-rag-name">${escapeHtml(chunkLabel + lbLabel + plotLabel)}</span>
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
        const entries     = Object.keys(anchor.lorebook?.entries ?? {}).length;
        const plotEntries = anchor.plotEntries?.length ?? 0;
        const chunks      = anchor.ragHeaders?.length ?? 0;
        const dateStr     = anchor.committedAt ? anchor.committedAt.slice(0, 16).replace('T', ' ') : '—';
        const plotPart    = plotEntries > 0 ? `  ${plotEntries} plot` : '';
        const summary     = `${label}  ${shortUuid}  ${entries} ${entries === 1 ? 'entry' : 'entries'}${plotPart}  ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'}  ${dateStr}`;

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
                const lbName   = escapeHtml(anchor.lorebook?.name ?? '—');
                const s        = statsMap.get(anchor.uuid);
                const sPlot    = s?.plotEntriesForAnchor ?? 0;
                const sLb      = s ? (s.lbEntriesForAnchor ?? 0) - sPlot : null;
                const dbLine   = s
                    ? escapeHtml(`${s.chunksForAnchor ?? 0} chunks / ${sLb} lb / ${sPlot} plot`)
                    : '<span class="cnz-li-status-muted">unavailable</span>';
                const sceneRaw = anchor.scene ?? anchor.hooks ?? '';
                const scenePreview = sceneRaw
                    ? escapeHtml(sceneRaw.split(/\s+/).slice(0, 15).join(' ') + (sceneRaw.split(/\s+/).length > 15 ? '…' : ''))
                    : '<span class="cnz-li-status-muted">(none)</span>';
                $nodeBody.html(`
                    <div class="cnz-li-field"><span class="cnz-li-field-label">UUID: </span>${escapeHtml(anchor.uuid ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Parent: </span>${escapeHtml(anchor.parentUuid ?? 'root')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Committed: </span>${escapeHtml(anchor.committedAt ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Lorebook: </span>${lbName}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">DB: </span>${dbLine}</div>
                    <div class="cnz-li-field cnz-li-hooks-block">
                        <span class="cnz-li-field-label">Scene:</span>
                        <div class="cnz-li-hooks-preview">${scenePreview}</div>
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
