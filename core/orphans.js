/**
 * @file data/default-user/extensions/canonize/core/orphans.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Wrapper
 * @description
 * Scans the character attachment registry for files belonging to characters
 * that no longer exist in ST. Wipes dead registry keys, verifies surviving
 * files on disk, then toasts with a Review/Dismiss link if any remain.
 *
 * @api-declaration
 * checkOrphans() — fires-and-forgets; never blocks the event loop
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/files/verify, extension_settings.character_attachments]
 */

import { saveSettingsDebounced, getRequestHeaders } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { warn } from '../log.js';
import { state } from '../state.js';

export async function checkOrphans() {
    const ctx            = SillyTavern.getContext();
    const liveAvatars    = new Set((ctx.characters ?? []).map(c => c.avatar));
    const allAttachments = extension_settings.character_attachments ?? {};

    const orphanUrls = [];
    for (const [avatarKey, files] of Object.entries(allAttachments)) {
        if (!liveAvatars.has(avatarKey)) {
            orphanUrls.push(...(files ?? []).map(f => f.url).filter(Boolean));
            delete extension_settings.character_attachments[avatarKey];
        }
    }

    if (orphanUrls.length === 0) return;
    saveSettingsDebounced();

    let existing = orphanUrls;
    try {
        const res = await fetch('/api/files/verify', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({ urls: orphanUrls }),
        });
        if (res.ok) {
            const verified = await res.json();
            existing = orphanUrls.filter(url => verified[url] === true);
        }
    } catch (err) {
        warn('Sync', 'checkOrphans: verify request failed:', err);
    }

    if (existing.length === 0) return;

    state._pendingOrphans = existing;
    const n = existing.length;
    toastr.warning(
        `CNZ: ${n} orphaned file${n !== 1 ? 's' : ''} from deleted character${n !== 1 ? 's' : ''}. ` +
        `<a href="#" class="cnz-orphan-review">Review</a> &nbsp; <a href="#" class="cnz-orphan-dismiss">Dismiss</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}
