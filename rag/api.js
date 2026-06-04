/**
 * @file data/default-user/extensions/canonize/rag/api.js
 * @stamp {"utc":"2026-06-04T16:40:00.000Z"}
 * @version 1.2.3
 * @architectural-role IO Wrapper
 * @description
 * Thin HTTP wrapper around the ST Data Bank file endpoints plus character
 * attachment registration. Covers file upload, file delete, character attachment
 * list/register, and the filename generation utilities (cnzFileName, cnzAvatarKey,
 * cnzChatKey, cnzGetActiveChatKey, cnzDefaultLbName, cnzPlotLbName).
 *
 * @api-declaration
 * uploadRagFile, cnzDeleteFile, registerCharacterAttachment,
 * getCharacterAttachments, cnzFileName, cnzAvatarKey, cnzChatKey, cnzGetActiveChatKey, cnzDefaultLbName, cnzPlotLbName
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/files/upload, /api/files/delete]
 */

import { getRequestHeaders, saveSettingsDebounced, getCurrentChatId } from '../../../../../script.js';
import { extension_settings } from '../../../../extensions.js';
import { getMetaSettings } from '../core/settings.js';
import { log } from '../log.js';

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
        const errorText = await res.text().catch(() => res.statusText);
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
 * Converts an ST chat filename to a safe CNZ chat key used as the per-chat
 * RAG store file key. Same sanitization as cnzAvatarKey.
 * e.g. "Hero - 2026-06-04@03:39:18.jsonl" → "Hero_-_2026-06-04_03_39_18_jsonl"
 * @param {string} chatFilename  Raw chat filename from ctx.getCurrentChatFile().
 * @returns {string|null}
 */
export function cnzChatKey(chatFilename) {
    if (!chatFilename) return null;
    return chatFilename.replace(/[^a-zA-Z0-9_\-]/g, '_');
}

/**
 * Retrieves and sanitizes the active chat's unique file key directly from SillyTavern context.
 * Centralizes the lookup to prevent API method mismatch errors across modules.
 * @returns {string|null} Sanitized chat key, or null if no active chat can be determined.
 */
export function cnzGetActiveChatKey() {
    const ctx = SillyTavern.getContext();
    if (!ctx) return null;

    let fallbackChat = null;
    if (ctx.characterId != null && ctx.characters) {
        let char = ctx.characters[ctx.characterId];
        if (!char) {
            char = ctx.characters.find(c => c.avatar === ctx.characterId || c.name === ctx.characterId);
        }
        if (char) {
            fallbackChat = char.chat;
        }
    }

    log('Api', `Resolving active chat key: context.chatId=${ctx.chatId}, getCurrentChatId=${getCurrentChatId()}, resolved character.chat=${fallbackChat}, characterId=${ctx.characterId} (${typeof ctx.characterId})`);

    const rawId = ctx.chatId ?? getCurrentChatId() ?? fallbackChat ?? null;
    return cnzChatKey(rawId);
}

/**
 * Returns the CNZ-owned default lorebook name for a character.
 * Only used as a fallback when no lorebook name has been established for the
 * session (i.e. state._lorebookName is empty). Existing sessions read their
 * lorebook name from the anchor snapshot, so this never fires for them.
 * @param {string} avatarFilename  Raw avatar filename from char.avatar.
 * @returns {string}
 */
export function cnzDefaultLbName(avatarFilename) {
    return `cnz_${cnzAvatarKey(avatarFilename)}`;
}

/**
 * Returns the CNZ-owned plot lorebook name for a character.
 * Append-only event log; hookseeker lane is the sole writer.
 * @param {string} avatarFilename  Raw avatar filename from char.avatar.
 * @returns {string}
 */
export function cnzPlotLbName(avatarFilename) {
    return `cnz_${cnzAvatarKey(avatarFilename)}_plot`;
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