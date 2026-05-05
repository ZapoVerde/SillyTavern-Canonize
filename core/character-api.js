/**
 * @file data/default-user/extensions/canonize/core/character-api.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role IO Executor
 * @description
 * IO Executor for character card modifications. Handles linking and unlinking 
 * World Info (Lorebooks) from the active character.
 *
 * @api-declaration
 * patchCharacterWorld(char, lorebookName), unlinkCharacterWorld(char)
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [/api/characters/edit]
 */

import { getRequestHeaders } from '../../../../../script.js';

/**
 * Updates the character card to link the specified lorebook name.
 * @param {object} char         SillyTavern character object.
 * @param {string} lorebookName The name of the lorebook to link.
 */
export async function patchCharacterWorld(char, lorebookName) {
    return _sendCharacterEdit(char, lorebookName);
}

/**
 * Removes the World Info link from the specified character card.
 * @param {object} char SillyTavern character object.
 */
export async function unlinkCharacterWorld(char) {
    return _sendCharacterEdit(char, '');
}

/**
 * Internal helper to construct and send the /api/characters/edit request.
 * @param {object} char 
 * @param {string} world 
 */
async function _sendCharacterEdit(char, world) {
    const updatedChar = structuredClone(char);
    if (!updatedChar.data)            updatedChar.data = {};
    if (!updatedChar.data.extensions) updatedChar.data.extensions = {};
    updatedChar.data.extensions.world = world;

    const formData = new FormData();
    formData.append('ch_name',                   char.name);
    formData.append('description',               char.description                      ?? '');
    formData.append('personality',               char.personality                      ?? '');
    formData.append('scenario',                  char.scenario                         ?? '');
    formData.append('first_mes',                 char.first_mes                        ?? '');
    formData.append('mes_example',               char.mes_example                      ?? '');
    formData.append('creator_notes',             char.data?.creator_notes              ?? '');
    formData.append('system_prompt',             char.data?.system_prompt              ?? '');
    formData.append('post_history_instructions', char.data?.post_history_instructions  ?? '');
    formData.append('creator',                   char.data?.creator                    ?? '');
    formData.append('character_version',         char.data?.character_version          ?? '');
    formData.append('world',                     world);
    formData.append('json_data',                 JSON.stringify(updatedChar));
    formData.append('avatar_url',                char.avatar);
    formData.append('chat',                      char.chat);
    formData.append('create_date',               char.create_date);

    const headers = getRequestHeaders();
    delete headers['Content-Type'];

    const res = await fetch('/api/characters/edit', {
        method:  'POST',
        headers,
        body:    formData,
    });
    
    if (!res.ok) {
        throw new Error(`Character world patch failed (HTTP ${res.status})`);
    }
}