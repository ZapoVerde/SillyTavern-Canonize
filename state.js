/**
 * @file data/default-user/extensions/canonize/state.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role Stateful Owner
 * @description
 * Central mutable state container for all CNZ engine variables. Exports a
 * single `state` object whose properties correspond 1-to-1 with the former
 * module-level `_` variables in index.js. Also exports shared constants
 * (EXT_NAME, CNZ_SUMMARY_ID, PROFILE_DEFAULTS) and the `escapeHtml` utility
 * used across multiple modules.
 *
 * @api-declaration
 * state, EXT_NAME, CNZ_SUMMARY_ID, PROFILE_DEFAULTS, escapeHtml
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [
 *       _lorebookData, _draftLorebook, _lastKnownAvatar,
 *       _lorebookName, _lorebookSuggestions,
 *       _ragChunks, _stagedProsePairs, _stagedPairOffset, _splitPairIdx,
 *       _lastRagUrl, _priorSituation, _beforeSituation, _parentNodeLorebook,
 *       _pendingOrphans, _dnaChain,
 *       _currentStep, _lorebookLoading, _hooksLoading,
 *       _lbActiveIngesterIndex, _lbPendingWrite,
 *       _ragRawDetached, _modalOpenHeadUuid, _hooksRegenGen, _lbRegenGen]
 *     external_io: [none]
 */

import {
    DEFAULT_LOREBOOK_SYNC_PROMPT,
    DEFAULT_HOOKSEEKER_PROMPT,
    DEFAULT_RAG_CLASSIFIER_PROMPT,
    DEFAULT_TARGETED_UPDATE_PROMPT,
    DEFAULT_TARGETED_NEW_PROMPT,
} from './defaults.js';

// ─── Constants ────────────────────────────────────────────────────────────────

export const EXT_NAME       = 'cnz';
export const CNZ_SUMMARY_ID = 'cnz_summary';

/**
 * Profile-level configuration keys — saved per profile, loaded into activeState.
 * Meta-state keys (profiles, currentProfileName, activeState) live at the root
 * of extension_settings[EXT_NAME] and are never included in a profile object.
 */
export const PROFILE_DEFAULTS = Object.freeze({
    chunkEveryN:              20,
    gapSnoozeTurns:           5,
    hookseekerHorizon:        40,
    autoSync:                 true,
    profileId:                null,
    // Summary / Lorebook
    liveContextBuffer:        5,
    lorebookSyncStart:        'syncPoint',   // 'syncPoint' | 'latestTurn'
    lorebookSyncPrompt:       DEFAULT_LOREBOOK_SYNC_PROMPT,
    hookseekerPrompt:         DEFAULT_HOOKSEEKER_PROMPT,
    // PersonaLyze integration
    enablePersonalyze:        false,
    // Rolling trim
    autoAdvanceMask:          false,
    // RAG
    enableRag:                false,
    ragSeparator:             'Chunk {{chunk_number}} ({{turn_range}})',
    ragContents:              'summary+full',
    ragSummarySource:         'defined',
    ragProfileId:             null,
    ragMaxTokens:             100,
    ragChunkSize:             2,
    ragChunkOverlap:          0,
    ragClassifierHistory:     0,
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
    _ragChunks:           [],
    _stagedProsePairs:    [],
    /** pairs preceding _stagedProsePairs[0] in the full chat */
    _stagedPairOffset:    0,
    _splitPairIdx:        0,

    // ── Anchor fields — set each sync cycle ────────────────────────────────────
    _lastRagUrl:          '',
    _priorSituation:      '',
    /** hooks text from before the last sync; read from parent node's state.hooks */
    _beforeSituation:     '',
    /** lorebook snapshot from parent node — diff baseline */
    _parentNodeLorebook:  null,

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
    /** active wizard step (1–4) */
    _currentStep:           1,
    _lorebookLoading:       false,
    _hooksLoading:          false,
    _lbActiveIngesterIndex: 0,
    /** {uid, name, keys, content} captured at last keystroke; flushed to draft on blur */
    _lbPendingWrite:        null,
    _ragRawDetached:        false,
    /** lkg anchor uuid captured at modal open; concurrent-sync guard */
    _modalOpenHeadUuid:     null,
    /** monotonic counter incremented on each hookseeker dispatch; stale resolves are dropped */
    _hooksRegenGen:         0,
    /** monotonic counter incremented on each lorebook regen dispatch; stale resolves are dropped */
    _lbRegenGen:            0,
};
