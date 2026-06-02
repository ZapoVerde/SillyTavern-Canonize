/**
 * @file data/default-user/extensions/canonize/core/summary-prompt.js
 * @stamp {"utc":"2026-05-29T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role IO Wrapper
 * @description
 * Owns the CNZ Summary prompt lifecycle in the ST PromptManager: ensures the
 * prompt exists in the active prompt order, writes hooks text and anchor
 * metadata to it, and refreshes it on character switch from the DNA chain.
 *
 * @api-declaration
 * getCnzPromptManager, ensureCnzSummaryPrompt, writeCnzSummaryPrompt,
 * syncCnzSummaryOnCharacterSwitch, ensureCnzRagPrompt, writeCnzRagPrompt,
 * clearCnzRagPrompt, removeCnzPromptFromStack
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [promptManager.saveServiceSettings]
 */

import { promptManager } from '../../../../../scripts/openai.js';
import { CNZ_SUMMARY_ID, CNZ_RAG_ID } from '../state.js';
import { buildCnzSummaryContent, DEFAULT_CNZ_SUMMARY_TEMPLATE } from '../defaults.js';
import { getSettings } from '../settings/data.js';

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
 * IO Executor. Writes scene text, character avatar, and anchor UUID to the
 * CNZ Summary prompt object, then re-renders content via the summary template.
 * Creates the prompt if absent. Preserves any existing cnz_plot.
 * @param {string}      avatar      Character avatar filename.
 * @param {string}      sceneText   Scene/situation prose from hookseeker.
 * @param {string|null} anchorUuid  Head anchor UUID, or null if not yet committed.
 */
export function writeCnzSummaryPrompt(avatar, sceneText, anchorUuid) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    ensureCnzSummaryPrompt(pm);
    const prompt = pm.getPromptById(CNZ_SUMMARY_ID);
    if (!prompt) return;
    const tmpl             = getSettings()?.cnzSummaryTemplate || DEFAULT_CNZ_SUMMARY_TEMPLATE;
    prompt.cnz_scene       = sceneText ?? '';
    prompt.cnz_plot        = prompt.cnz_plot ?? '';
    prompt.content         = buildCnzSummaryContent(prompt.cnz_scene, prompt.cnz_plot, tmpl);
    prompt.cnz_avatar      = avatar;
    prompt.cnz_anchor_uuid = anchorUuid ?? null;
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
        prompt.cnz_scene       = '';
        prompt.cnz_plot        = '';
        prompt.cnz_avatar      = null;
        prompt.cnz_anchor_uuid = null;
        return;
    }

    const head = chain?.lkg ?? null;
    if (prompt.cnz_avatar === char.avatar && prompt.cnz_anchor_uuid === (head?.uuid ?? null)) {
        return;
    }

    const scene            = head?.scene ?? head?.hooks ?? '';
    const tmpl             = getSettings()?.cnzSummaryTemplate || DEFAULT_CNZ_SUMMARY_TEMPLATE;
    prompt.cnz_scene       = scene;
    prompt.cnz_plot        = '';
    prompt.content         = buildCnzSummaryContent(scene, '', tmpl);
    prompt.cnz_avatar      = char.avatar;
    prompt.cnz_anchor_uuid = head?.uuid ?? null;
}

// ─── CNZ RAG Prompt Management ────────────────────────────────────────────────

/**
 * IO Executor. Ensures the CNZ RAG prompt exists in the prompt manager and is
 * registered in the active prompt order above chatHistory.
 * No-op if already present. Calls saveServiceSettings if it creates the prompt.
 * @param {import('../../../../../scripts/PromptManager.js').PromptManager} pm
 */
export function ensureCnzRagPrompt(pm) {
    if (pm.getPromptById(CNZ_RAG_ID)) return;

    pm.addPrompt({
        name:    'CNZ RAG',
        content: '',
        role:    'system',
        enabled: true,
    }, CNZ_RAG_ID);

    const order          = pm.getPromptOrderForCharacter(pm.activeCharacter);
    const chatHistoryIdx = order.findIndex(e => e.identifier === 'chatHistory');
    if (chatHistoryIdx !== -1) {
        order.splice(chatHistoryIdx, 0, { identifier: CNZ_RAG_ID, enabled: true });
    } else {
        order.push({ identifier: CNZ_RAG_ID, enabled: true });
    }

    pm.saveServiceSettings();
}

/**
 * IO Executor. Writes RAG retrieval text to the CNZ RAG prompt, creating it
 * if absent. No-op if PromptManager is unavailable.
 * @param {string} content  Formatted RAG injection text.
 */
export function writeCnzRagPrompt(content) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    ensureCnzRagPrompt(pm);
    const prompt = pm.getPromptById(CNZ_RAG_ID);
    if (!prompt) return;
    prompt.content = content;
    pm.saveServiceSettings();
}

/**
 * IO Executor. Writes formatted plot arc blocks to the CNZ Summary prompt,
 * replacing any previously written arc section, then re-renders content via
 * the summary template. Pass empty string to clear the plot section.
 * @param {string} arcsText  Formatted arc blocks (already applied chunk template).
 */
export function appendCnzPlotArcs(arcsText) {
    const pm = getCnzPromptManager();
    if (!pm) return;
    const prompt = pm.getPromptById(CNZ_SUMMARY_ID);
    if (!prompt) return;
    const tmpl       = getSettings()?.cnzSummaryTemplate || DEFAULT_CNZ_SUMMARY_TEMPLATE;
    prompt.cnz_plot  = arcsText ?? '';
    prompt.content   = buildCnzSummaryContent(prompt.cnz_scene ?? '', prompt.cnz_plot, tmpl);
    pm.saveServiceSettings();
}

export function clearCnzRagPrompt() {
    const pm = getCnzPromptManager();
    if (!pm) return;
    const prompt = pm.getPromptById(CNZ_RAG_ID);
    if (!prompt) return;
    prompt.content = '';
    pm.saveServiceSettings();
}

/**
 * IO Executor. Removes a CNZ prompt from the active character's prompt order
 * and deletes its definition from the PromptManager registry, then persists.
 * No-op if the prompt does not exist or PromptManager is unavailable.
 * @param {import('../../../../../scripts/PromptManager.js').PromptManager} pm
 * @param {string} promptId  The identifier to remove (e.g. CNZ_SUMMARY_ID, CNZ_RAG_ID).
 */
export function removeCnzPromptFromStack(pm, promptId) {
    if (!pm || !pm.getPromptById(promptId)) return;
    const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
    const orderIdx = order.findIndex(e => e.identifier === promptId);
    if (orderIdx !== -1) order.splice(orderIdx, 1);
    const prompts    = pm.serviceSettings?.prompts;
    const promptsIdx = prompts?.findIndex(p => p.identifier === promptId) ?? -1;
    if (promptsIdx !== -1) prompts.splice(promptsIdx, 1);
    pm.saveServiceSettings();
}
