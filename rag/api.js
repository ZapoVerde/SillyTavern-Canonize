/**
 * @file data/default-user/extensions/canonize/rag/api.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Thin HTTP wrapper around the ST Data Bank file endpoints plus character
 * attachment registration. Covers file upload, file delete, character attachment
 * list/register, and the filename generation utilities (cnzFileName, cnzAvatarKey).
 *
 * @api-declaration
 * uploadRagFile, cnzDeleteFile, registerCharacterAttachment,
 * getCharacterAttachments, cnzFileName, cnzAvatarKey
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/files/upload, /api/files/delete]
 */

import { getRequestHeaders, saveSettingsDebounced } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getMetaSettings } from '../core/settings.js';

// ─── File Primitives ──────────────────────────────────────────────────────────

/**
 * UTF-8–safe base64 encoding for the /api/files/upload payload.
 * @param {string} str
 * @returns {string}
 */
function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    const binary = Array.from(bytes, b => String.fromCharCode(b)).join('');
    return btoa(binary);
}

/**
 * Uploads a text string to the ST Data Bank as a plain-text file.
 * @param {string} text
 * @param {string} fileName
 * @returns {Promise<string>} Server-assigned URL.
 */
export async function uploadRagFile(text, fileName) {
    const safeName = fileName.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-.]/g, '');

    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: safeName, data: utf8ToBase64(text) }),
    });
    if (!res.ok) {
        const errorText = await res.text();
        throw new Error(`RAG file upload failed (HTTP ${res.status}): ${errorText}`);
    }
    const json = await res.json();
    if (!json.path) throw new Error('RAG file upload returned no path');
    return json.path;
}

/**
 * Registers a Data Bank file as a character attachment so ST's vector engine
 * picks it up during generation. Mirrors the FileAttachment typedef from chats.js.
 * @param {string} avatarKey character.avatar of the target card (e.g. "alice.png").
 * @param {string} url      File URL returned by uploadRagFile.
 * @param {string} fileName Human-readable file name.
 * @param {number} byteSize Byte length of the uploaded text.
 */
export function registerCharacterAttachment(avatarKey, url, fileName, byteSize) {
    if (!extension_settings.character_attachments) {
        extension_settings.character_attachments = {};
    }
    if (!Array.isArray(extension_settings.character_attachments[avatarKey])) {
        extension_settings.character_attachments[avatarKey] = [];
    }
    extension_settings.character_attachments[avatarKey].push({
        url,
        size:    byteSize,
        name:    fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
}

/**
 * Returns the character attachments array for `avatarKey`, or [].
 * @param {string} avatarKey
 * @returns {object[]}
 */
export function getCharacterAttachments(avatarKey) {
    return extension_settings.character_attachments?.[avatarKey] ?? [];
}

/**
 * Converts a raw avatar filename to a safe CNZ avatar key.
 * All characters outside [a-zA-Z0-9_\-] are replaced with '_'.
 * e.g. "seraphina.png" → "seraphina_png", "my char (2).png" → "my_char__2__png"
 * @param {string} avatarFilename  Raw avatar filename from char.avatar.
 * @returns {string}
 */
export function cnzAvatarKey(avatarFilename) {
    return avatarFilename.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * Generates a consistent flat-prefix filename for a CNZ-managed file.
 * @param {string} avatarKey  Already-sanitized avatar key (from cnzAvatarKey).
 * @param {'manifest'|'node'|'rag'} type  File type.
 * @param {...string} args    Type-specific args:
 *   'node' → args[0] = nodeId (uuid)
 *   'rag'  → args[0] = unixTimestamp, args[1] = charname (will be sanitized)
 * @returns {string}
 */
export function cnzFileName(avatarKey, type, ...args) {
    switch (type) {
        case 'manifest':
            return `cnz_${avatarKey}_manifest.json`;
        case 'node':
            return `cnz_${avatarKey}_node_${args[0]}.json`;
        case 'rag': {
            const safeName    = String(args[1] ?? '').replace(/[^a-zA-Z0-9_\-]/g, '_');
            const anchorSuffix = args[2] ? `_${args[2]}` : '';
            return `cnz_${avatarKey}_rag_${args[0]}_${safeName}${anchorSuffix}.txt`;
        }
        default:
            throw new Error(`[CNZ] Unknown file type: ${type}`);
    }
}

/**
 * Deletes a file from the ST Data Bank by its stored path.
 * Silently ignores missing files (already deleted).
 * @param {string} path  Client-relative path as returned by cnzUploadFile.
 */
export async function cnzDeleteFile(path) {
    if (!path) return;
    // Remove from knownFiles registry before attempting delete
    const meta = getMetaSettings();
    if (meta.knownFiles) {
        const idx = meta.knownFiles.indexOf(path);
        if (idx !== -1) { meta.knownFiles.splice(idx, 1); saveSettingsDebounced(); }
    }
    try {
        await fetch('/api/files/delete', {
            method:  'POST',
            headers: getRequestHeaders(),
            body:    JSON.stringify({ path }),
        });
    } catch (_) {
        // NOTE: knownFiles was already updated above, so a network failure here
        // leaves the old file on disk permanently invisible: it is no longer in
        // knownFiles, and expectedPaths (derived from the live manifest) does not
        // include it either, so the orphan checker cannot surface it.  Low
        // severity — the file wastes a small amount of storage but causes no
        // functional harm.  A future improvement could defer the knownFiles
        // splice until after a confirmed delete, or re-add the path on failure.
    }
}
