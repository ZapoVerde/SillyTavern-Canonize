/**
 * @file data/default-user/extensions/canonize/core/summary-prompt.js
 * @stamp {"utc":"2025-01-15T12:00:00.000Z"}
 * @architectural-role IO Wrapper
 * @description
 * Owns the CNZ Summary prompt lifecycle in the ST PromptManager: ensures the
 * prompt exists in the active prompt order, writes hooks text and anchor
 * metadata to it, and refreshes it on character switch from the DNA chain.
 *
 * @api-declaration
 * getCnzPromptManager, ensureCnzSummaryPrompt, writeCnzSummaryPrompt,
 * syncCnzSummaryOnCharacterSwitch, setCnzPromptEnabled
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [promptManager.saveServiceSettings]
 */

import { promptManager } from '../../../../../scripts/openai.js';
import { CNZ_SUMMARY_ID } from '../state.js';

// ─── CNZ Summary Prompt Management ────────────────────────────────────────────

/**
 * Returns the active PromptManager instance, or null if unavailable
 * (e.g. non-Chat-Completion backend).
 * @returns {import('../../../../../scripts/PromptManager.js').PromptManager|null}
 */
export function getCnzPromptManager() {
    return promptManager ?? null;
}

/**
 * IO Executor. Ensures the CNZ Summary prompt exists in the prompt manager
 * and is registered in the active prompt order above chatHistory.
 * No-op if already present. Calls saveServiceSettings if it creates the prompt.
 * @param {import('../../../../../scripts/PromptManager.js').PromptManager} pm
 */
export function ensureCnzSummaryPrompt(pm) {
    if (pm.getPromptById(CNZ_SUMMARY_ID)) return;

    pm.addPrompt({
        name:    'CNZ Summary',
        content: '',
        role:    'system',
        enabled: true,
        cnz_avatar:      null,
        cnz_anchor_uuid: null,
    }, CNZ_SUMMARY_ID);

    const order          = pm.getPromptOrderForCharacter(pm.activeCharacter);
    const chatHistoryIdx = order.findIndex(e => e.identifier === 'chatHistory');
    if (chatHistoryIdx !== -1) {
        order.splice(chatHistoryIdx, 0, { identifier: CNZ_SUMMARY_ID, enabled: true });
    } else {
        order.push({ identifier: CNZ_SUMMARY_ID, enabled: true });
    }

    pm.saveServiceSettings();
}

/**
 * IO Executor. Writes hooks text, character avatar, and anchor UUID to the
 * CNZ Summary prompt object, then persists via saveServiceSettings.
 * Creates the prompt if absent.
 * @param {string}      avatar      Character avatar filename.
 * @param {string}      content     Hooks summary text.
 * @param {string|null} anchorUuid  Head anchor UUID, or null if not yet committed.
 */
export function writeCnzSummaryPrompt(avatar, content, anchorUuid) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    ensureCnzSummaryPrompt(pm);
    const prompt = pm.getPromptById(CNZ_SUMMARY_ID);
    if (!prompt) return;
    prompt.content         = content;
    prompt.cnz_avatar      = avatar;
    prompt.cnz_anchor_uuid = anchorUuid ?? null;
    pm.saveServiceSettings();
}

/**
 * IO Executor. Toggles the enabled state of the CNZ Summary prompt.
 * Does nothing if the prompt has not been created yet.
 * @param {boolean} enabled 
 */
export function setCnzPromptEnabled(enabled) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    const prompt = pm.getPromptById(CNZ_SUMMARY_ID);
    if (!prompt) return;
    prompt.enabled = !!enabled;
    pm.saveServiceSettings();
}

/**
 * Stateful owner. Refreshes the CNZ Summary prompt from the DNA chain when
 * the active character changes. In-memory update only — no saveServiceSettings,
 * as the anchor chain is the source of truth.
 * No-op if the prompt does not yet exist (not created until first sync).
 * @param {object|null} char   Incoming character object, or null if no character.
 * @param {object}      chain  Already-computed DNA chain for the incoming chat.
 */
export function syncCnzSummaryOnCharacterSwitch(char, chain) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    const prompt = pm.getPromptById(CNZ_SUMMARY_ID);
    if (!prompt) return;

    if (!char) {
        prompt.content         = '';
        prompt.cnz_avatar      = null;
        prompt.cnz_anchor_uuid = null;
        return;
    }

    const head = chain?.lkg ?? null;
    if (prompt.cnz_avatar === char.avatar && prompt.cnz_anchor_uuid === (head?.uuid ?? null)) {
        return;
    }

    prompt.content         = head?.hooks ?? '';
    prompt.cnz_avatar      = char.avatar;
    prompt.cnz_anchor_uuid = head?.uuid ?? null;
}