/**
 * @file data/default-user/extensions/canonize/rag/generation-hook.js
 * @stamp {"utc":"2026-05-21T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Orchestrator
 * @description
 * GENERATION_STARTED handler for VectFox-backed RAG retrieval. Queries the
 * cnz_* VectFox collection for scenes relevant to the recent chat and injects
 * them via the CNZ_RAG_TAG extension slot. Only runs when both enableRag and
 * useVectFox are active.
 *
 * @api-declaration
 * onGenerationStarted() — ST GENERATION_STARTED handler
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [none]
 *     external_io: [VectFox extension APIs, ST setExtensionPrompt]
 */

import { setExtensionPrompt } from '../../../../../script.js';
import { error } from '../log.js';
import { getSettings } from '../core/settings.js';
import { queryVectFoxScenes } from './vectfox-bridge.js';
import { cnzAvatarKey } from './api.js';

const CNZ_RAG_TAG = 'cnz_rag';

export async function onGenerationStarted() {
    const settings = getSettings();
    if (!settings.enableRag || !settings.useVectFox) return;

    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) return;

    const recentText = (ctx.chat || [])
        .filter(m => !m.is_system)
        .reverse()
        .slice(0, 5)
        .map(m => m.mes || '')
        .join('\n')
        .trim();
    if (!recentText) return;

    const topK      = settings.vectfoxRetrievalTopK ?? 3;
    const avatarKey = cnzAvatarKey(char.avatar);
    console.log(`[CNZ:RAG] querying cnz_${avatarKey} topK=${topK}`);

    try {
        const scenes = await queryVectFoxScenes(avatarKey, recentText, topK);
        if (!scenes.length) {
            console.log('[CNZ:RAG] query returned 0 scenes — no injection');
            setExtensionPrompt(CNZ_RAG_TAG, '', 0, 0, false);
            return;
        }
        console.log(`[CNZ:RAG] injecting ${scenes.length} scene(s):`, scenes.map(s => ({ score: s.score, chars: s.text.length })));
        const body = scenes
            .map((s, i) => `Scene ${i + 1}\n\n${s.text}`)
            .join('\n\n***\n\n');
        setExtensionPrompt(CNZ_RAG_TAG, `[Narrative Memory]\n\n${body}`, 0, 2, false);
    } catch (err) {
        error('RAG', 'VectFox retrieval failed:', err);
        setExtensionPrompt(CNZ_RAG_TAG, '', 0, 0, false);
    }
}
