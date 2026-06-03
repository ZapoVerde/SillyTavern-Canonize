/**
 * @file data/default-user/extensions/canonize/state.js
 * @stamp {"utc":"2026-04-16T00:00:00.000Z"}
 * @version 1.0.17
 * @architectural-role Stateful Owner
 * @description
 * Central mutable state container for all CNZ engine variables. Exports a
 * single `state` object whose properties correspond 1-to-1 with the former
 * module-level `_` variables in index.js. Also exports shared constants
 * (EXT_NAME, CNZ_SUMMARY_ID, PROFILE_DEFAULTS) and the `escapeHtml` utility
 * used across multiple modules.
 *
 * @api-declaration
 * state, EXT_NAME, CNZ_SUMMARY_ID, CNZ_RAG_ID, PROFILE_DEFAULTS, escapeHtml
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [
 *       _lorebookData, _draftLorebook, _lastKnownAvatar,
 *       _lorebookName, _lorebookSuggestions,
 *       _ragChunks, _lastIndexedLorebookHash,
 *       _stagedProsePairs, _stagedPairOffset, _splitPairIdx,
 *       _priorSituation, _beforeSituation, _parentNodeLorebook,
 *       _pendingOrphans, _dnaChain,
 *       _currentStep, _lorebookLoading, _hooksLoading,
 *       _lbActiveIngesterIndex, _lbPendingWrite,
 *       _ragRawDetached, _modalOpenHeadUuid, _hooksRegenGen, _lbRegenGen]
 *     external_io: [none]
 */

import {
    DEFAULT_LOREBOOK_SYNC_PROMPT,
    DEFAULT_PEOPLE_SYNC_PROMPT,
    DEFAULT_HOOKSEEKER_PROMPT,
    DEFAULT_RAG_CLASSIFIER_PROMPT,
    DEFAULT_TARGETED_UPDATE_PROMPT,
    DEFAULT_TARGETED_NEW_PROMPT,
    DEFAULT_RAG_INJECTION_TEMPLATE,
    DEFAULT_RAG_CHUNK_TEMPLATE,
    DEFAULT_CNZ_SUMMARY_TEMPLATE,
    DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE,
} from './defaults.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const EXT_NAME       = 'cnz';
export const CNZ_SUMMARY_ID = 'cnz_summary';
export const CNZ_RAG_ID     = 'cnz_rag';

/**
 * Profile-level configuration keys — saved per profile, loaded into activeState.
 * Meta-state keys (profiles, currentProfileName, activeState) live at the root
 * of extension_settings[EXT_NAME] and are never included in a profile object.
 */
export const PROFILE_DEFAULTS = Object.freeze({
    chunkEveryN:              20,
    hookseekerHorizon:        40,
    profileId:                null,
    // Summary / Lorebook
    enablePeopleSync:         true,
    liveContextBuffer:        5,
    lorebookSyncStart:        'syncPoint',   // 'syncPoint' | 'latestTurn'
    lorebookSyncPrompt:       DEFAULT_LOREBOOK_SYNC_PROMPT,
    peopleSyncPrompt:         DEFAULT_PEOPLE_SYNC_PROMPT,
    hookseekerPrompt:         DEFAULT_HOOKSEEKER_PROMPT,
    // RAG
    ragSeparator:             '%%%',
    ragChunkTemplate:         DEFAULT_RAG_CHUNK_TEMPLATE,
    ragContents:              'summary+full',
    ragProfileId:             null,
    ragMaxTokens:             100,
    ragChunkSize:             2,
    ragChunkOverlap:          0,
    ragClassifierHistory:     0,
    ragMaxRetries:            1,
    ragRetrievalTopK:         5,
    ragLbRetrievalTopK:       3,
    ragPlotRetrievalTopK:     3,
    ragPlotRecencyCount:      3,
    ragPlotMinArcs:           2,
    ragPlotFillerEnabled:     true,
    ragPlotFillerCards:       1,
    ragPlotFillerStrategy:    'random',
    maxConcurrentCalls:       3,
    ragScoreThreshold:        0.25,
    ragInjectionTemplate:     DEFAULT_RAG_INJECTION_TEMPLATE,
    cnzSummaryTemplate:       DEFAULT_CNZ_SUMMARY_TEMPLATE,
    cnzPlotChunkTemplate:     DEFAULT_CNZ_PLOT_CHUNK_TEMPLATE,
    ragEmbeddingSource:       'openrouter',
    ragEmbeddingModel:        '',
    ragClassifierPrompt:      DEFAULT_RAG_CLASSIFIER_PROMPT,
    targetedUpdatePrompt:     DEFAULT_TARGETED_UPDATE_PROMPT,
    targetedNewPrompt:        DEFAULT_TARGETED_NEW_PROMPT,
});

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Escapes a string for safe insertion into HTML.
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Central mutable state for the CNZ engine.
 * All modules access and mutate these properties directly via `state._varName`.
 */
export const state = {
    // ── Session State (persists across sync cycles, cleared on character switch) ──
    /** {entries:{}} — server copy of the active lorebook */
    _lorebookData:        null,
    /** working copy for staged changes */
    _draftLorebook:       null,

    // ── Healer tracking — updated on CHAT_CHANGED ──────────────────────────────
    _lastKnownAvatar:     null,

    // ── Engine State ────────────────────────────────────────────────────────────
    _lorebookName:        '',
    _lorebookSuggestions: [],
    _ragChunks:                [],
    /** hash of last successfully indexed lorebook state; '' = known stale */
    _lastIndexedLorebookHash:  '',
    _stagedProsePairs:         [],
    /** pairs preceding _stagedProsePairs[0] in the full chat */
    _stagedPairOffset:    0,
    _splitPairIdx:        0,

    // ── Anchor fields — set each sync cycle ────────────────────────────────────
    _priorSituation:      '',
    /** hooks text from before the last sync; read from parent node's state.hooks */
    _beforeSituation:     '',
    /** lorebook snapshot from parent node — diff baseline */
    _parentNodeLorebook:  null,
    /** name of the plot lorebook file (append-only, hookseeker lane only) */
    _plotLorebookName:    null,
    /** live disk snapshot of the plot lorebook at modal open */
    _plotLorebookData:    null,
    /** working copy of the plot lorebook; committed on Finalize */
    _draftPlotLorebook:   null,

    // ── Orphan check state — set by checkOrphans(), read by openOrphanModal() ──
    _pendingOrphans:      [],

    /**
     * DnaChain | null
     * null = not yet loaded for this character
     * Populated by readDnaChain() on chat load and after each sync commit
     * Shape: { lkg: CnzAnchor | null, lkgMsgIdx: number, anchors: AnchorRef[] }
     */
    _dnaChain:            null,

    // ── Modal Session State (cleared by closeModal()) ───────────────────────────
    /** active wizard step (1–5) */
    _currentStep:               1,
    _lorebookLoading:           false,
    _hooksLoading:              false,
    _lbActiveIngesterIndex:     0,
    /** {uid, name, keys, content} captured at last keystroke; flushed to draft on blur */
    _lbPendingWrite:            null,
    _plotLbActiveIngesterIndex: 0,
    /** {uid, name, status} for entries written by the last hookseeker sync */
    _plotLorebookSuggestions:   [],
    /** {uid, name, content} captured at last keystroke; flushed to plot draft on blur */
    _plotLbPendingWrite:        null,
    _ragRawDetached:        false,
    /** lkg anchor uuid captured at modal open; concurrent-sync guard */
    _modalOpenHeadUuid:     null,
    /** monotonic counter incremented on each hookseeker dispatch; stale resolves are dropped */
    _hooksRegenGen:         0,
    /** monotonic counter incremented on each lorebook regen dispatch; stale resolves are dropped */
    _lbRegenGen:            0,
};
