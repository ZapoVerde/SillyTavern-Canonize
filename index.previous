/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.17
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern Narrative Engine (CNZ) — autonomous background engine that
 * silently canonizes roleplay turns every N turns into three persistent
 * stores: a lorebook (structured world facts), a scenario anchor block
 * (hookseeker prose summary of active threads), and a RAG document
 * (searchable narrative memory archive uploaded as a character attachment).
 *
 * A four-step review modal lets the user inspect and correct each sync
 * cycle's output before finalizing corrections to disk. The DNA Chain
 * tracks narrative milestones as Anchor records embedded directly in chat
 * messages, enabling the Healer to detect branches and restore the correct
 * world state for the active timeline.
 *
 * Modal steps:
 * (1) Hooks Workshop — edit/regen the hookseeker summary, diff vs previous sync
 * (2) Lorebook Workshop — review AI suggestions, targeted generate, stage corrections
 * (3) RAG Workshop — review chunk cards, edit headers, regen individual chunks
 * (4) Finalize — confirm corrections, write only what changed, update head anchor
 *
 * @core-principles
 * 1. SYNC OWNS ITS COMMIT: runCnzSync writes lorebook, hooks, RAG, and a DNA
 *    anchor to the chat as its own atomic operation. The modal corrects, it
 *    does not re-commit the sync.
 * 2. MODAL STAGES ONLY: All edits in the modal mutate _draftLorebook in memory.
 *    Nothing writes to disk until the user clicks Finalize.
 *    Suggestion objects carry three mutually exclusive verdict flags (_applied,
 *    _rejected, _deleted); all three start false so every suggestion opens
 *    unresolved for user review. Deleted entries are absent from
 *    _draftLorebook.entries and are therefore not written by Finalize.
 * 3. ANCHOR IS SOURCE OF TRUTH: Before-states for all modal diffs come from
 *    the DNA chain's head anchor, never from ephemeral sync-cycle variables.
 * 4. HEAD ANCHOR UPDATED IN PLACE: Finalize patches the existing head anchor
 *    in the chat. No new anchor is written for modal corrections.
 * 5. ENGINE STATE SURVIVES MODAL: closeModal resets UI state only. All engine
 *    state (_ragChunks, _draftLorebook, _lorebookSuggestions, etc.) persists
 *    until character switch.
 * 6. CONTEXT MASK: The main AI prompt sees only turns above the DNA chain head.
 *    Older turns are replaced by the hookseeker summary and RAG chunks.
 * 
 * @docs
 *   cnz_principles.md
 *
 * @api-declaration
 * Entry points: onWandButtonClick() (manual), SYNC_TRIGGERED bus event (auto-sync).
 * Sync pipeline: runCnzSync(), runHealer().
 * Modal: openReviewModal(), onConfirmClick(), closeModal().
 * AI calls: _waitForRecipe() — routes all LLM calls through bus/executor.
 * RAG: buildRagChunks(), buildRagDocument(), waitForRagChunks().
 * Lorebook: parseLbSuggestions(), enrichLbSuggestions(), updateLbDiff(),
 *           deleteLbEntry(), revertLbSuggestion().
 * DNA Chain: readDnaChain(), getLkgAnchor(), findLastAiMessageInPair(),
 *            writeDnaAnchor(), writeDnaLinks(), buildAnchorPayload().
 * Bus: emit(), on(), off() — see bus.js
 * Recipes: Recipes{} — see recipes.js
 * Cycle: startCycle(), dispatchContract() — see cycleStore.js
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [
 *       _lorebookData, _draftLorebook, _parentNodeLorebook,
 *       _priorSituation, _beforeSituation,
 *       _lorebookName, _lorebookSuggestions,
 *       _stagedProsePairs, _stagedPairOffset, _splitPairIdx,
 *       _ragChunks,
 *       _lastRagUrl,
 *       _cnzGenerating, _lastKnownAvatar,
 *       _currentStep, _modalOpenHeadUuid,
 *       _lorebookLoading, _lbActiveIngesterIndex,
 *       _lbDebounceTimer,
 *       _ragRawDetached, _pendingOrphans, _dnaChain,
 *       extension_settings.cnz]
 *     external_io: [
 *       generateRaw (via executor.js), ConnectionManagerRequestService (via executor.js),
 *       /api/worldinfo/*, /api/characters/edit,
 *       /api/files/upload, /api/files/delete,
 *       /api/chats/saveChat]
 */

import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types, callPopup } from '../../../../script.js';
import { promptManager } from '../../../../scripts/openai.js';
import { extension_settings } from '../../../extensions.js';
import { updateWorldInfoList } from '../../../../scripts/world-info.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { buildModalHTML, buildPromptModalHTML, buildSettingsHTML, buildDnaChainInspectorHTML, buildOrphanModalHTML } from './ui.js';
import { emit, on, off, enableDevMode, BUS_EVENTS } from './bus.js';
import { dispatchContract,
         setCurrentSettings, invalidateAllJobs } from './cycleStore.js';
import { initScheduler, setSyncInProgress, isSyncInProgress,
         snooze, resetScheduler, setDnaChain, getGap } from './scheduler.js';
import { Triggers } from './recipes.js';
import './executor.js';   // self-registers its CONTRACT_DISPATCHED handler on import
import './logger.js';    // console observer for LLM call lifecycle
import { interpolate,
         DEFAULT_LOREBOOK_SYNC_PROMPT,
         DEFAULT_HOOKSEEKER_PROMPT,
         DEFAULT_RAG_CLASSIFIER_PROMPT,
         DEFAULT_TARGETED_UPDATE_PROMPT,
         DEFAULT_TARGETED_NEW_PROMPT } from './defaults.js';

// ─── Mobile Debug Panel ───────────────────────────────────────────────────────
const MDP = false; // set true to enable on-screen console overlay for mobile debugging
if (MDP) (function() {
    const panel = document.createElement('div');
    panel.id = 'cnz-debug-panel';
    panel.style.cssText = [
        'position:fixed', 'bottom:0', 'left:0', 'right:0', 'z-index:999999',
        'background:#111', 'color:#0f0', 'font:11px monospace',
        'max-height:40vh', 'overflow-y:auto', 'padding:4px',
        'border-top:2px solid #0f0'
    ].join(';');
    //document.body ? document.body.appendChild(panel) : document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));
    document.addEventListener('DOMContentLoaded', () => document.body.appendChild(panel));
    const orig = { log: console.log, warn: console.warn, error: console.error };
    ['log', 'warn', 'error'].forEach(level => {
        console[level] = function(...args) {
            orig[level].apply(console, args);
            const line = document.createElement('div');
            line.style.color = level === 'error' ? '#f44' : level === 'warn' ? '#fa0' : '#0f0';
            line.textContent = `[${level}] ${args.map(a => {
                try { return typeof a === 'object' ? JSON.stringify(a) : String(a); }
                catch { return String(a); }
            }).join(' ')}`;
            panel.appendChild(line);
            panel.scrollTop = panel.scrollHeight;
        };
    });
})();
if (MDP) enableDevMode();

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME            = 'cnz';
const DEFAULT_CONCURRENCY = 3;
const CNZ_SUMMARY_ID      = 'cnz_summary';


// Profile-level configuration keys — saved per profile, loaded into activeState.
// Meta-state keys (profiles, currentProfileName,
// activeState) live at the root of extension_settings[EXT_NAME] and are never
// included in a profile object.
const PROFILE_DEFAULTS = Object.freeze({
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

// ─── Session State ─────────────────────────────────────────────────────────────
// Primary CNZ state — persists across sync cycles.

let _lorebookData   = null;  // {entries:{}} — server copy of the active lorebook
let _draftLorebook  = null;  // working copy for staged changes


// Healer tracking — updated on CHAT_CHANGED
let _lastKnownAvatar = null;

// ─── Engine State ──────────────────────────────────────────────────────────────
// Variables required by preserved infrastructure functions.
// Active management begins in Phase 2+.

let _lorebookName          = '';
let _lorebookSuggestions   = [];
let _ragChunks             = [];
let _stagedProsePairs      = [];
let _stagedPairOffset      = 0;   // pairs preceding _stagedProsePairs[0] in the full chat
let _splitPairIdx          = 0;

// Anchor fields — set each sync cycle
let _lastRagUrl      = '';
let _priorSituation  = '';
let _beforeSituation = '';  // hooks text from before the last sync
                             // read from parent node's state.hooks in openReviewModal
                             // never set by runCnzSync
let _parentNodeLorebook = null;  // lorebook snapshot from parent node — diff baseline
                                  // set in runCnzSync and openReviewModal, read by updateLbDiff

// Orphan check state — set by checkOrphans(), read by openOrphanModal()
let _pendingOrphans = [];

let _dnaChain = null;
// DnaChain | null
// null = not yet loaded for this character
// Populated by readDnaChain() on chat load and after each sync commit
// Shape: { lkg: CnzAnchor | null, lkgMsgIdx: number, anchors: AnchorRef[] }

// ─── Modal Session State ──────────────────────────────────────────────────────
// Cleared by closeModal(). Kept separate from engine state so modal open/close
// does not disrupt background sync cycles.

let _currentStep             = 1;    // active wizard step (1–4)
let _lorebookLoading         = false;
let _hooksLoading            = false;
let _lbActiveIngesterIndex   = 0;
let _lbDebounceTimer         = null;
let _ragRawDetached          = false;
let _modalOpenHeadUuid       = null;  // lkg anchor uuid captured at modal open; concurrent-sync guard

/**
 * @typedef {object} CnzAnchor
 * @property {'anchor'}        type        - discriminant
 * @property {string}          uuid        - crypto.randomUUID() at commit time
 * @property {string}          committedAt - ISO timestamp
 * @property {string}          hooks       - hookseeker text committed this cycle
 * @property {object}          lorebook    - full lorebook snapshot { name, entries }
 * @property {string|null}     ragUrl      - Data Bank URL of the RAG file, or null
 * @property {RagHeaderEntry[]} ragHeaders - chunk headers committed this cycle
 * @property {string|null}     parentUuid  - uuid of previous anchor, or null
 */

/**
 * @typedef {object} CnzLink
 * @property {'link'}  type
 * @property {string}  uuid         - same uuid as the Anchor for this block
 * @property {number}  seq          - this pair's non-system position
 */

/**
 * @typedef {object} RagHeaderEntry
 * @property {number} chunkIndex
 * @property {string} header
 * @property {string} turnRange  - human-readable range string, e.g. "turns 1–12"
 * @property {number} pairStart  - absolute pair index of chunk start (inclusive)
 * @property {number} pairEnd    - absolute pair index of chunk end (exclusive)
 */

/**
 * @typedef {object} AnchorRef
 * @property {CnzAnchor} anchor
 * @property {number}    msgIdx  - index of this anchor's message in messages[]
 */

/**
 * @typedef {object} DnaChain
 * @property {CnzAnchor|null} lkg         - most recent valid anchor
 * @property {number}         lkgMsgIdx   - index of lkg in messages[], -1 if none
 * @property {object|null}    lkgAnchorMsg - the full message object carrying lkg
 * @property {AnchorRef[]}    anchors      - all anchors, chronological order
 */

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Returns the active profile configuration. The engine always reads from here. */
function getSettings() {
    return extension_settings[EXT_NAME].activeState;
}

/** Returns the root settings object (profiles dict, meta-state). */
function getMetaSettings() {
    return extension_settings[EXT_NAME];
}

function initSettings() {
    if (!extension_settings[EXT_NAME]) extension_settings[EXT_NAME] = {};
    const root = extension_settings[EXT_NAME];

    if (!root.profiles) {
        // ── One-time migration: flat structure → profile-based ────────────
        // First, apply old key renames in-place so they are collected correctly.
        // factFinderPrompt → lorebookSyncPrompt
        if (root.factFinderPrompt !== undefined) {
            if (root.lorebookSyncPrompt === undefined || root.lorebookSyncPrompt === DEFAULT_LOREBOOK_SYNC_PROMPT) {
                root.lorebookSyncPrompt = root.factFinderPrompt;
            }
            delete root.factFinderPrompt;
        }
        // ragSummaryOnly + useQvink → ragContents + ragSummarySource
        if (root.ragSummaryOnly !== undefined || root.useQvink !== undefined) {
            const wasSummaryOnly = root.ragSummaryOnly ?? false;
            const wasQvink       = root.useQvink       ?? false;
            if (wasSummaryOnly) root.ragContents = 'summary';
            else if (!root.ragContents) root.ragContents = 'summary+full';
            if (wasQvink && (root.ragSummarySource ?? 'defined') === 'defined') root.ragSummarySource = 'qvink';
            delete root.ragSummaryOnly;
            delete root.useQvink;
        }

        // syncFromTurn → liveContextBuffer (semantics inverted; discard old value, reset to default)
        if (root.syncFromTurn !== undefined) {
            console.warn('[CNZ] syncFromTurn renamed to liveContextBuffer — semantics inverted, resetting to default of 5');
            delete root.syncFromTurn;
            root.liveContextBuffer = 5;
        }
        // pruneOnSync → autoAdvanceMask (boolean migrates directly)
        if (root.pruneOnSync !== undefined) {
            root.autoAdvanceMask = root.pruneOnSync;
            delete root.pruneOnSync;
        }

        // Harvest profile-config keys from the flat root into a legacy object.
        // Meta-state keys (lastLorebookSyncAt) are not in
        // PROFILE_DEFAULTS, so they are left untouched at root.
        const legacyConfig = {};
        for (const key of Object.keys(PROFILE_DEFAULTS)) {
            if (Object.prototype.hasOwnProperty.call(root, key)) {
                legacyConfig[key] = root[key];
                delete root[key];
            }
        }

        const defaultProfile    = Object.assign({}, PROFILE_DEFAULTS, legacyConfig);
        root.profiles           = { Default: defaultProfile };
        root.currentProfileName = 'Default';
        root.activeState        = structuredClone(defaultProfile);
    } else {
        // Existing profile structure — fill in any keys added by newer versions.
        root.activeState = Object.assign({}, PROFILE_DEFAULTS, root.activeState);
    }

    // (no meta-state keys require initialisation at this time)
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}



/**
 * Returns the index in `messages` of the Nth non-system message (1-based),
 * or -1 if the chat does not contain that many non-system messages.
 * @param {object[]} messages
 * @param {number}   nonSystemCount  1-based target count.
 * @returns {number}
 */
// ─── CNZ Summary Prompt Management ────────────────────────────────────────────

/**
 * Returns the active PromptManager instance, or null if unavailable
 * (e.g. non-Chat-Completion backend).
 * @returns {import('../../../../scripts/PromptManager.js').PromptManager|null}
 */
function getCnzPromptManager() {
    return promptManager ?? null;
}

/**
 * IO Executor. Ensures the CNZ Summary prompt exists in the prompt manager
 * and is registered in the active prompt order above chatHistory.
 * No-op if already present. Calls saveServiceSettings if it creates the prompt.
 * @param {import('../../../../scripts/PromptManager.js').PromptManager} pm
 */
function ensureCnzSummaryPrompt(pm) {
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
function writeCnzSummaryPrompt(avatar, content, anchorUuid) {
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
 * Stateful owner. Refreshes the CNZ Summary prompt from the DNA chain when
 * the active character changes. In-memory update only — no saveServiceSettings,
 * as the anchor chain is the source of truth.
 * No-op if the prompt does not yet exist (not created until first sync).
 * @param {object|null} char   Incoming character object, or null if no character.
 * @param {object}      chain  Already-computed DNA chain for the incoming chat.
 */
function syncCnzSummaryOnCharacterSwitch(char, chain) {
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

// ─── DNA Chain ───────────────────────────────────────────────────────────────

/**
 * Returns the last AI (non-user, non-system) message in a prose pair.
 * @param {{user: object, messages: object[], validIdx: number}} pair
 * @returns {object|null}
 */
function findLastAiMessageInPair(pair) {
    for (let i = pair.messages.length - 1; i >= 0; i--) {
        const msg = pair.messages[i];
        if (!msg.is_user && !msg.is_system) return msg;
    }
    return null;
}

/**
 * Walks the full messages array and builds the DnaChain from embedded anchor data.
 * @param {object[]} messages - SillyTavern.getContext().chat
 * @returns {DnaChain}
 */
function readDnaChain(messages) {
    const result = { lkg: null, lkgMsgIdx: -1, lkgAnchorMsg: null, anchors: [] };
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (!msg.extra) continue;
        if (!msg.extra.cnz) continue;
        const cnz = msg.extra.cnz;
        if (!cnz.type) {
            console.warn('[CNZ] readDnaChain: message at index', i, 'has malformed cnz object (missing type)');
            continue;
        }
        if (cnz.type === 'anchor') {
            result.anchors.push({ anchor: cnz, msgIdx: i });
        }
        // links are ignored — not needed by current consumers
    }
    if (result.anchors.length > 0) {
        const last = result.anchors[result.anchors.length - 1];
        result.lkg         = last.anchor;
        result.lkgMsgIdx   = last.msgIdx;
        result.lkgAnchorMsg = messages[last.msgIdx];
    }
    return result;
}

/**
 * Convenience wrapper — returns { anchor, msgIdx } for the most recent anchor, or null.
 * @param {object[]} messages
 * @returns {{ anchor: CnzAnchor, msgIdx: number }|null}
 */
function getLkgAnchor(messages) {
    const chain = readDnaChain(messages);
    return chain.lkg ? { anchor: chain.lkg, msgIdx: chain.lkgMsgIdx } : null;
}

/**
 * Builds the CnzAnchor payload for embedding in message.extra.cnz.
 * Pure function — all inputs passed explicitly.
 * @param {object} params
 * @param {string}            params.uuid         - crypto.randomUUID() from the caller
 * @param {string}            params.committedAt  - ISO timestamp from the caller
 * @param {string}            params.hooks        - hookseeker text committed this cycle
 * @param {object}            params.lorebook     - full lorebook snapshot { name, entries }
 * @param {string|null}       params.ragUrl       - uploaded RAG file URL, or null
 * @param {RagHeaderEntry[]}  params.ragHeaders   - chunk headers committed this cycle
 * @param {string|null}       params.parentUuid   - uuid of previous anchor, or null
 * @returns {CnzAnchor}
 */
function buildAnchorPayload({ uuid, committedAt, hooks, lorebook, ragUrl, ragHeaders, parentUuid }) {
    return {
        type: 'anchor',
        uuid,
        committedAt,
        hooks,
        lorebook:    structuredClone(lorebook),
        ragUrl:      ragUrl ?? null,
        ragHeaders:  ragHeaders ?? [],
        parentUuid:  parentUuid ?? null,
    };
}

/**
 * Writes a CnzAnchor payload into the last AI message of the given pair,
 * then saves the chat. The message becomes the Anchor for this sync cycle.
 *
 * If the pair has no AI message, logs a warning and returns without writing.
 *
 * @param {object} pair       - prose pair object (from buildProsePairs)
 * @param {CnzAnchor} anchor  - payload from buildAnchorPayload
 * @returns {Promise<void>}
 */
async function writeDnaAnchor(pair, anchor) {
    const msg = findLastAiMessageInPair(pair);
    if (!msg) {
        console.warn('[CNZ] writeDnaAnchor: no AI message in pair — skipping');
        return;
    }
    msg.extra ??= {};
    msg.extra.cnz = anchor;
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        console.error('[CNZ] writeDnaAnchor: saveChat failed:', err);
    }
}

/**
 * Writes a CnzLink back-pointer into the last AI message of each pair in
 * the given range, then saves the chat once. Skips the anchor pair itself
 * (it already carries the full CnzAnchor). Skips pairs with no AI message.
 *
 * @param {object[]} pairs      - all prose pairs in the sync block
 * @param {number}   anchorIdx  - index of the anchor pair within `pairs`; that pair is skipped
 * @param {string}   uuid       - the sync block's uuid (same as the anchor's uuid)
 * @param {number}   pairOffset - absolute pair index of pairs[0] in the full chat
 * @returns {Promise<void>}
 */
async function writeDnaLinks(pairs, anchorIdx, uuid, pairOffset) {
    let wrote = false;
    for (let i = 0; i < pairs.length; i++) {
        if (i === anchorIdx) continue;
        const msg = findLastAiMessageInPair(pairs[i]);
        if (!msg) continue;
        msg.extra ??= {};
        msg.extra.cnz = {
            type: 'link',
            uuid,
            seq: pairOffset + i,
        };
        wrote = true;
    }
    if (!wrote) return;
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        console.error('[CNZ] writeDnaLinks: saveChat failed:', err);
    }
}

/**
 * Builds a nodeFile-shaped object from a CnzAnchor so the existing restore
 * functions (restoreLorebookToNode, restoreHooksToNode, restoreRagToNode) can
 * consume DNA-chain anchors without modification.
 * Pure function — no state reads, no IO.
 * @param {CnzAnchor} anchor
 * @returns {{ state: { uuid: string|null, hooks: string, lorebook: object, ragFiles: string[] } }}
 */
function buildNodeFileFromAnchor(anchor) {
    let ragFiles = [];
    if (anchor.ragUrl) {
        const fileName = anchor.ragUrl.split('/').pop();
        if (fileName) ragFiles = [fileName];
    }
    return {
        state: {
            uuid:     anchor.uuid ?? null,
            hooks:    anchor.hooks ?? '',
            lorebook: anchor.lorebook ?? { entries: {} },
            ragFiles,
        },
    };
}

/**
 * Walks anchors newest-first and returns the first AnchorRef whose message
 * still sits at its original index in the current chat with the same UUID.
 * This is the branch-detection primitive — an anchor is valid if the chat
 * has not been modified at or after that point.
 * Pure function — no state reads, no IO.
 * @param {{ anchor: CnzAnchor, msgIdx: number }[]} anchors  From _dnaChain.anchors (chronological).
 * @param {object[]} messages  Current chat array.
 * @returns {{ anchor: CnzAnchor, msgIdx: number }|null}
 */
function findLkgAnchorByPosition(anchors, messages) {
    for (let i = anchors.length - 1; i >= 0; i--) {
        const ref = anchors[i];
        if (messages[ref.msgIdx]?.extra?.cnz?.uuid === ref.anchor.uuid) {
            return ref;
        }
    }
    return null;
}

// ─── Transcript ───────────────────────────────────────────────────────────────

function buildTranscript(messages) {
    return messages
        .filter(m => !m.is_system)
        .map(m => `${m.name}: ${m.mes}`)
        .join('\n');
}

/**
 * Pairs user+AI messages from a chat into turn objects.
 * Skips system messages. Each pair accumulates all consecutive AI messages
 * following a user message into `messages`.
 * @param {object[]} messages
 * @returns {{user: object, messages: object[], validIdx: number}[]}
 */
function buildProsePairs(messages) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const pairs = [];
    let current = null;

    for (let i = 0; i < valid.length; i++) {
        const msg = valid[i];
        if (msg.is_user) {
            // Standard: Start a new pair on User message
            if (current) pairs.push(current);
            current = { user: msg, messages: [], validIdx: i };
        } else {
            // If the chat starts with an AI message (no user yet), 
            // create a dummy 'System' user so the greeting isn't lost.
            if (!current) {
                current = { user: { name: 'System', mes: 'Story Start' }, messages: [], validIdx: i };
            }
            current.messages.push(msg);
        }
    }
    if (current) pairs.push(current);
    return pairs;
}

/**
 * @section RAG Engine
 * @architectural-role Chunk Lifecycle Manager
 * @description
 * Owns chunk building, AI classification, queue management, and document
 * assembly. `buildRagChunks` is a pure function that partitions the prose
 * pair list into fixed-size windows. The queue/drain/fire machinery manages
 * concurrency and staleness so that in-flight classifier calls for superseded
 * chunks are discarded. The document builder assembles the final upload from
 * settled chunk state and hands it to the persistence layer.
 * @core-principles
 *   1. buildRagChunks is pure — no state mutation, no IO.
 *   2. Fan-out staleness is owned by cycleStore (_activeJobsByKey); stale results are discarded there.
 * @api-declaration
 *   buildRagChunks, resolveClassifierHistory, buildRagDocument,
 *   waitForRagChunks, renderChunkChatLabel, renderAllChunkChatLabels,
 *   hydrateChunkHeadersFromChat, writeChunkHeaderToChat
 * @contract
 *   assertions:
 *     external_io: [generateRaw, /api/chats/saveChat]
 */
// ─── Narrative Memory (RAG) ───────────────────────────────────────────────────

/**
 * Builds the final RAG document from the workshop chunk state.
 * Each chunk is prefixed with the separator template (default '***').
 * ragContents controls whether summary header, full content, or both are emitted.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  ragChunks
 * @param {object} settings   Active profile settings (ragContents, ragSeparator).
 * @param {string} charName   Character name for separator interpolation.
 * @returns {string}
 */
const DEFAULT_SEPARATOR = 'Chunk {{chunk_number}} ({{turn_range}})';

function buildRagDocument(ragChunks, settings, charName) {
    if (!ragChunks.length) return '';
    const contents    = settings.ragContents    ?? 'summary+full';
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;

    const body = ragChunks.map(c => {
        const sep = interpolate(sepTemplate, {
            chunk_number: String(c.chunkIndex + 1),
            turn_number:  String(c.chunkIndex + 1),   // backward-compat alias
            turn_range:   c.turnRange,
            char_name:    charName,
        });
        const parts = [sep];
        if (contents !== 'full')    parts.push(c.header);   // summary
        if (contents !== 'summary') parts.push(c.content);  // full content
        return parts.filter(Boolean).join('\n\n');
    }).join('\n\n***\n\n').trim();
    return `[Narrative Memory]\n\n${body}`;
}

/**
 * Builds the _ragChunks state array from the staged prose pairs.
 * Qvink mode: forced 1-pair windows, headers from qvink_memory metadata.
 * Defined mode: ragChunkSize-pair sliding windows, headers from AI classifier.
 * Pure function — all inputs passed explicitly.
 * @param {Array}  pairs
 * @param {number} [pairOffset=0]
 * @param {object} settings  Active profile settings (ragSummarySource, ragChunkSize, ragChunkOverlap).
 * @returns {Array}
 */
function buildRagChunks(pairs, pairOffset = 0, settings) {
    // Exclude user-only pairs (no AI response yet) — they produce empty RAG chunks
    // that confuse the classifier with a stimulus and no reply.
    // Note: filtering here shifts turn indices for any pair that follows a removed one,
    // which would misalign chunk turn labels. In practice user-only pairs only appear at
    // the trailing edge of an active conversation (buildProsePairs never produces them
    // mid-sequence), so no label misalignment occurs.
    pairs = pairs.filter(p => p.messages.length > 0);
    const chunks    = [];
    const useQvink  = (settings.ragSummarySource ?? 'defined') === 'qvink';
    const chunkSize = useQvink ? 1 : Math.max(1, settings.ragChunkSize ?? 2);
    const overlap   = useQvink ? 0 : Math.max(0, settings.ragChunkOverlap ?? 0);

    if (overlap === 0) {
        // Non-overlapping: advance by chunkSize each step
        for (let i = 0; i < pairs.length; i += chunkSize) {
            const window    = pairs.slice(i, i + chunkSize);
            const turnA     = pairOffset + i + 1;
            const turnB     = pairOffset + Math.min(i + chunkSize, pairs.length);
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            const content = window
                .map(p => {
                    const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                    for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                    return parts.join('\n\n');
                })
                .join('\n\n');

            const qvinkText = useQvink ? (pairs[i].messages[0]?.extra?.qvink_memory?.memory || null) : null;

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  i,
                pairEnd:    Math.min(i + chunkSize, pairs.length),
                turnRange,
                content,
                header:  qvinkText || turnRange,
                status:  (useQvink && qvinkText) ? 'complete' : 'pending',
            });
        }
    } else {
        // Overlapping: step = 1 new pair per chunk; each chunk includes `overlap` prior pairs
        // chunk at position i covers pairs[max(0, i - overlap) .. i] inclusive
        // Start at 0 so every turn gets an event, even when the full overlap context isn't yet available.
        for (let i = 0; i < pairs.length; i++) {
            const sliceFrom = Math.max(0, i - overlap);
            const window    = pairs.slice(sliceFrom, i + 1);
            const turnA     = pairOffset + sliceFrom + 1;
            const turnB     = pairOffset + i + 1;
            const turnRange = turnA === turnB ? `Turn ${turnA}` : `Turns ${turnA}–${turnB}`;

            const content = window
                .map(p => {
                    const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                    for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                    return parts.join('\n\n');
                })
                .join('\n\n');

            chunks.push({
                chunkIndex: chunks.length,
                pairStart:  sliceFrom,
                pairEnd:    i + 1,
                turnRange,
                content,
                header:  turnRange,
                status:  'pending',
            });
        }
    }
    return chunks;
}

/**
 * Injects (or refreshes) a Canonize chunk label beneath the last AI message
 * of the chunk in the chat UI.  Mirrors the Qvink pattern: find the message
 * by mesid, append a styled div after div.mes_text.
 * No-ops when the message is not currently in the DOM.
 * @param {number} chunkIndex
 */
function renderChunkChatLabel(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;

    // Resolve the last AI message in this chunk's pair window
    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair = _stagedProsePairs[lastPairIdx];
    const lastMsg = pair?.messages?.[pair.messages.length - 1];
    if (!lastMsg) return;

    const chat  = SillyTavern.getContext().chat ?? [];
    const mesId = chat.indexOf(lastMsg);
    if (mesId === -1) return;

    const $msgDiv = $(`div[mesid="${mesId}"]`);
    if (!$msgDiv.length) return;

    // Replace any existing label on this message
    $msgDiv.find('.cnz-chunk-label').remove();

    // For pending/in-flight chunks don't inject yet — label appears on completion
    if (chunk.status === 'pending' || chunk.status === 'in-flight') return;

    const bodyText = (chunk.status === 'complete' || chunk.status === 'manual')
        ? `${chunk.turnRange}: ${chunk.header}`
        : chunk.turnRange;   // stale/error — show turn range only

    const $label = $('<div class="cnz-chunk-label"></div>');
    $label.append($('<span class="cnz-chunk-label-prefix">◆ CANONIZE </span>'));
    $label.append($('<span>').text(bodyText));
    $msgDiv.find('div.mes_text').after($label);
}

/**
 * Renders chunk labels for every chunk in _ragChunks.
 * Called on workshop open and after full sync so all turns get annotated.
 */
function renderAllChunkChatLabels() {
    for (let i = 0; i < _ragChunks.length; i++) {
        renderChunkChatLabel(i);
    }
}

/**
 * Removes all Canonize chunk labels from the chat UI.
 * Called on chat/character switch so stale labels don't bleed across chats.
 */
function clearChunkChatLabels() {
    $('#chat').find('.cnz-chunk-label').remove();
}

/**
 * Renders the separator template for a given chunk.
 * This rendered string is stored as cnz_turn_label on the chat message and used
 * as a validity key — if it doesn't match on reload, the chunk is re-classified.
 * @param {object} chunk
 * @returns {string}
 */
function renderSeparator(chunk) {
    const settings    = getSettings();
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;
    const ctx         = SillyTavern.getContext();
    const charName    = ctx?.characters?.[ctx?.characterId]?.name ?? '';
    return interpolate(sepTemplate, {
        chunk_number: String(chunk.chunkIndex + 1),
        turn_number:  String(chunk.chunkIndex + 1),
        turn_range:   chunk.turnRange,
        char_name:    charName,
    });
}

/**
 * Writes a completed chunk's header into the last AI message of its pair window
 * as message.extra.cnz_chunk_header / cnz_turn_label, then saves the chat.
 * The chat file is the source of truth — this makes headers survive page reloads.
 * @param {number} chunkIndex
 */
async function writeChunkHeaderToChat(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk || (chunk.status !== 'complete' && chunk.status !== 'manual')) return;
    const lastPairIdx = (chunk.pairEnd ?? chunkIndex + 1) - 1;
    const pair = _stagedProsePairs[lastPairIdx];
    const lastMsg = pair?.messages?.[pair.messages.length - 1];
    if (!lastMsg) return;
    if (!lastMsg.extra) lastMsg.extra = {};
    lastMsg.extra.cnz_chunk_header = chunk.header;
    lastMsg.extra.cnz_turn_label   = renderSeparator(chunk);
    try {
        await SillyTavern.getContext().saveChat();
    } catch (err) {
        console.error('[CNZ] writeChunkHeaderToChat: saveChat failed:', err);
    }
}

/**
 * Reads cnz_chunk_header / cnz_turn_label from each chunk's last AI message.
 * If the stored turn label matches the current rendered separator (same chunk
 * boundaries and same separator template), the chunk is pre-populated as complete
 * and skips AI classification.  Mismatches are left as 'pending'.
 * Uses _stagedProsePairs as the pair source.
 */
function hydrateChunkHeadersFromChat() {
    for (const chunk of _ragChunks) {
        if (chunk.status === 'complete') continue;   // qvink or already hydrated
        const lastPairIdx = (chunk.pairEnd ?? chunk.chunkIndex + 1) - 1;
        const pair = _stagedProsePairs[lastPairIdx];
        const lastMsg = pair?.messages?.[pair.messages.length - 1];
        if (!lastMsg?.extra?.cnz_chunk_header) continue;
        if (lastMsg.extra.cnz_turn_label !== renderSeparator(chunk)) continue;
        chunk.header = lastMsg.extra.cnz_chunk_header;
        chunk.status = 'complete';
    }
}

/**
 * Updates the dynamic parts of a single chunk card in place — spinner, status badge,
 * queue label, header value — without rebuilding the whole list.
 * No-ops silently when the modal is not open (card element not found).
 * @param {number} chunkIndex
 */
function renderRagCard(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;
    const $card = $(`.cnz-rag-card[data-chunk-index="${chunkIndex}"]`);
    if (!$card.length) return;

    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    const disabled   = isInFlight || _ragRawDetached;

    $card.attr('data-status', chunk.status);
    const $header = $card.find('.cnz-rag-card-header').val(chunk.header).prop('disabled', disabled);
    autoResizeRagCardHeader($header[0]);
    $card.find('.cnz-rag-card-spinner').toggleClass('cnz-hidden', !isInFlight);
    $card.find('.cnz-rag-queue-label').toggleClass('cnz-hidden', !isPending).text('pending');
    $card.find('.cnz-rag-card-regen').prop('disabled', _ragRawDetached);
}

/**
 * Fires a single RAG classifier call for the chunk at chunkIndex.
 * Respects per-chunk genId and global ragGlobalGenId for staleness detection.
 * @param {number} chunkIndex
 */
/**
 * Resolves the history context pairs for a RAG classifier call.
 * Pulls up to `historyN` pairs immediately preceding the chunk's
 * pairStart. Looks first into _stagedProsePairs (with _stagedPairOffset
 * as the reference), then reaches back into committed turns via the
 * full chat pair array.
 *
 * @param {number}   pairStart     chunk.pairStart — index into _stagedProsePairs
 * @param {number}   historyN      number of pairs to include
 * @param {object[]} fullPairs     buildProsePairs(messages) — full chat pair array
 * @returns {string}               formatted transcript, or '' if nothing to show
 */
/**
 * Pure utility — kept as reference for the logic inlined in rag_classifier.fanOut.
 * @param {number} pairStart
 * @param {number} historyN
 * @param {Array}  fullPairs
 * @param {number} stagedPairOffset
 */
function resolveClassifierHistory(pairStart, historyN, fullPairs, stagedPairOffset = 0) {
    if (historyN <= 0) return '';

    // Absolute index of chunk.pairStart in the full pair array
    const absoluteStart = stagedPairOffset + pairStart;

    // Slice the history window — may reach into committed turns
    const historySliceStart = Math.max(0, absoluteStart - historyN);
    const historyPairs      = fullPairs.slice(historySliceStart, absoluteStart);

    if (!historyPairs.length) return '';

    return historyPairs
        .map(p => {
            const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
            for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
            return parts.join('\n\n');
        })
        .join('\n\n');
}

/**
 * Returns a Promise that resolves when the RAG fan-out emits CYCLE_STORE_UPDATED
 * for 'rag_chunk_results', or when timeoutMs elapses.
 * Timed-out in-flight chunks are marked 'pending' for retry.
 * @param {number} timeoutMs
 */
function waitForRagChunks(timeoutMs = 120_000) {
    return new Promise(resolve => {
        const timer = setTimeout(() => {
            off(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
            for (const c of _ragChunks) {
                if (c.status === 'in-flight') c.status = 'pending';
            }
            console.warn(`[CNZ] RAG chunk wait timed out after ${timeoutMs}ms — some chunks may be incomplete`);
            resolve();
        }, timeoutMs);

        function handler({ key }) {
            if (key !== 'rag_chunk_results') return;
            clearTimeout(timer);
            off(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
            resolve();
        }
        on(BUS_EVENTS.CYCLE_STORE_UPDATED, handler);
    });
}

/**
 * @section AI Call Layer
 * @architectural-role Prompt Assembly and Generation
 * @description
 * Owns the three sync AI calls and the profile routing that backs them.
 * No parsing, no state mutation — just prompt assembly and raw text
 * generation. Each call receives pre-assembled context from the engine
 * layer and returns raw model output to the caller for downstream parsing.
 * @core-principles
 *   1. No state mutation inside this section — callers own all state.
 *   2. Profile routing is the only branching logic; prompt templates come from settings.
 * @api-declaration
 *   generateWithProfile, generateWithRagProfile, runLorebookSyncCall,
 *   runHookseekerCall, runTargetedLbCall
 * @contract
 *   assertions:
 *     external_io: [generateRaw, ConnectionManagerRequestService]
 */
// ─── Lorebook Sync Call ────────────────────────────────────────────────────────

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
async function uploadRagFile(text, fileName) {
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
function registerCharacterAttachment(avatarKey, url, fileName, byteSize) {
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

// ─── LLM Calls ────────────────────────────────────────────────────────────────


/**
 * Dispatches a named recipe onto the bus and returns a Promise that resolves
 * when the job completes or rejects when it fails. Bridges the bus back to
 * the Promise-based call sites in runCnzSync and the modal.
 *
 * Sets _cnzGenerating = true for the duration so the CHAT_COMPLETION_PROMPT_READY
 * handler skips the context mask during CNZ's own AI calls.
 *
 * @param {string} recipeId
 * @param {Record<string,*>} extraInputs  Resolved inputs to pass alongside cycle store values.
 * @returns {Promise<string>}
 */
function _waitForRecipe(recipeId, extraInputs = {}) {
    return new Promise((resolve, reject) => {
        const settings = getSettings();
        setCurrentSettings(settings);

        const jobId = dispatchContract(recipeId, extraInputs, settings);

        function onCompleted({ jobId: j, recipeId: r, result }) {
            if (j !== jobId || r !== recipeId) return;
            cleanup();
            resolve(result);
        }

        function onFailed({ jobId: j, recipeId: r, error }) {
            if (j !== jobId || r !== recipeId) return;
            cleanup();
            reject(new Error(error?.message ?? `Recipe ${recipeId} failed`));
        }

        function cleanup() {
            off(BUS_EVENTS.JOB_COMPLETED, onCompleted);
            off(BUS_EVENTS.JOB_FAILED,    onFailed);
        }

        on(BUS_EVENTS.JOB_COMPLETED, onCompleted);
        on(BUS_EVENTS.JOB_FAILED,    onFailed);
    });
}

/**
 * Fires the Lorebook Sync AI call via the bus.
 * @param {string}      transcript  Prose transcript to analyse.
 * @param {object|null} lorebook    Lorebook state to use as context. Defaults to `_lorebookData` if null.
 * @returns {Promise<string>}
 */
function runLorebookSyncCall(transcript, lorebook = null) {
    return _waitForRecipe('lorebook', {
        transcript,
        lorebook_entries: formatLorebookEntries(lorebook ?? _lorebookData),
    });
}

/**
 * Fires the Hookseeker AI call via the bus.
 * @param {string} transcript
 * @param {string} prevSummary
 * @returns {Promise<string>}
 */
function runHookseekerCall(transcript, prevSummary = '') {
    return _waitForRecipe('hookseeker', {
        transcript,
        prev_summary: prevSummary,
    });
}

/**
 * Fires a targeted lorebook AI call for a single entry (update or new) via the bus.
 * @param {'update'|'new'} mode
 * @param {string} entryName     Entry name or freeform keyword.
 * @param {string} entryKeys     Comma-separated existing keys (empty string for new).
 * @param {string} entryContent  Existing entry content (empty string for new).
 * @param {string} transcript    Sync-window transcript.
 * @returns {Promise<string>}    Raw AI output block.
 */
function runTargetedLbCall(mode, entryName, entryKeys, entryContent, transcript) {
    const recipeId = mode === 'update' ? 'targeted_update' : 'targeted_new';
    return _waitForRecipe(recipeId, {
        entry_name:    entryName,
        entry_keys:    entryKeys,
        entry_content: entryContent,
        transcript,
    });
}

/**
 * @section Persistence Layer
 * @architectural-role IO Executor
 * @description
 * Owns all direct fetch calls to ST server endpoints. Covers lorebook CRUD,
 * character scenario patch, and file upload and delete. Nothing in this
 * section makes decisions — it executes what the engine layer tells it to,
 * returning raw server responses or throwing on failure.
 * @core-principles
 *   1. No business logic — this section is a thin HTTP wrapper only.
 *   2. Each function corresponds to exactly one server endpoint or operation.
 * @api-declaration
 *   lbListLorebooks, lbGetLorebook, lbSaveLorebook, lbEnsureLorebook,
 *   uploadRagFile, registerCharacterAttachment,
 *   cnzUploadFile, cnzDeleteFile
 * @contract
 *   assertions:
 *     external_io: [/api/worldinfo/*, /api/characters/edit, /api/files/upload, /api/files/delete]
 */
// ─── Lorebook API ─────────────────────────────────────────────────────────────

async function lbListLorebooks() {
    const res = await fetch('/api/worldinfo/list', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({}),
    });
    if (!res.ok) throw new Error(`Lorebook list failed (HTTP ${res.status})`);
    return res.json();
}

async function lbGetLorebook(name) {
    const res = await fetch('/api/worldinfo/get', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name }),
    });
    if (!res.ok) throw new Error(`Lorebook fetch failed (HTTP ${res.status})`);
    return res.json();
}

async function lbSaveLorebook(name, data) {
    const res = await fetch('/api/worldinfo/edit', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name, data }),
    });
    if (!res.ok) throw new Error(`Lorebook save failed (HTTP ${res.status})`);
    await eventSource.emit(event_types.WORLDINFO_UPDATED, name, data);
}

/**
 * Ensures a lorebook named `name` exists, then returns its data.
 */
async function lbEnsureLorebook(name) {
    let list;
    try {
        list = await lbListLorebooks();
    } catch (_) {
        list = [];
    }
    const exists = list.some(item => item.name === name);
    if (!exists) {
        await lbSaveLorebook(name, { entries: {} });
        await updateWorldInfoList();
    }
    return lbGetLorebook(name);
}

/**
 * @section Lorebook Utilities
 * @architectural-role Pure Data Manipulation
 * @description
 * Pure functions for lorebook data manipulation. No IO, no state mutation
 * beyond the draft. Covers parsing AI suggestion text into structured objects,
 * enriching suggestions with anchor-diff context, diffing entry content,
 * and constructing new draft entries from canonical defaults.
 * @core-principles
 *   1. All functions here are pure or operate only on the passed-in draft object.
 *   2. No fetch calls, no engine state reads — callers supply all inputs.
 * @api-declaration
 *   parseLbSuggestions, enrichLbSuggestions, deriveSuggestionsFromAnchorDiff,
 *   formatLorebookEntries, matchEntryByComment, nextLorebookUid,
 *   makeLbDraftEntry, toVirtualDoc, updateLbDiff, isDraftDirty
 * @contract
 *   assertions:
 *     external_io: [none]
 */
// ─── Lorebook Utilities ───────────────────────────────────────────────────────

function formatLorebookEntries(data) {
    const entries = data?.entries ?? {};
    const items   = Object.values(entries);
    if (!items.length) return '(no entries yet)';
    return items.map(e => {
        const label = e.comment || String(e.uid);
        const keys  = Array.isArray(e.key) ? e.key.join(', ') : (e.key || '');
        return `--- Entry: ${label} ---\nKeys: ${keys}\n${e.content || ''}`;
    }).join('\n\n');
}

/**
 * Parses raw Fact-Finder / lorebook curator output into suggestion objects.
 * Splits on **UPDATE:** / **NEW:** block headers.
 */
function parseLbSuggestions(rawText) {
    const suggestions = [];
    const parts = rawText.split(/(?=\*\*(UPDATE|NEW):\s)/i);
    for (const part of parts) {
        const headerMatch = part.match(/^\*\*(UPDATE|NEW):\s*(.+?)(?:\s*\*{0,2})?\s*[\r\n]/i);
        if (!headerMatch) continue;
        const type = headerMatch[1].toUpperCase();
        const name = headerMatch[2].trim().replace(/\*+$/, '').trim();
        if (!name) continue;

        const rest = part.slice(headerMatch[0].length);

        const keysMatch = rest.match(/^Keys:\s*(.+)$/im);
        const keys = keysMatch
            ? keysMatch[1].split(',').map(k => k.trim()).filter(Boolean)
            : [];

        const afterKeys = keysMatch
            ? rest.slice(rest.indexOf(keysMatch[0]) + keysMatch[0].length)
            : rest;
        const reasonIdx = afterKeys.search(/^\*Reason:/im);
        const content = (reasonIdx !== -1
            ? afterKeys.slice(0, reasonIdx)
            : afterKeys
        ).trim();

        if (!content) continue;
        suggestions.push({ type, name, keys, content });
    }
    return suggestions;
}

/**
 * Inverse of parseLbSuggestions. Serialises the suggestion list into the
 * standard **UPDATE:** / **NEW:** block format used by the Freeform overview.
 * Deleted entries emit a single `**DELETE: name**` tombstone line.
 * Rejected suggestions are excluded entirely.
 * @param {object[]} suggestions
 * @returns {string}
 */
function serialiseSuggestionsToFreeform(suggestions) {
    return suggestions
        .map(s => {
            if (s._deleted)  return `**DELETE: ${s.name}**`;
            if (s._rejected) return null;
            const lines = [`**${s.type}: ${s.name}**`];
            if (s.keys?.length) lines.push(`Keys: ${s.keys.join(', ')}`);
            lines.push(s.content ?? '');
            return lines.join('\n');
        })
        .filter(Boolean)
        .join('\n\n');
}

/**
 * Writes the current _lorebookSuggestions to the Freeform textarea.
 * Called after any action that changes the suggestion list or editor content.
 */
function syncFreeformFromSuggestions() {
    $('#cnz-lb-freeform').val(serialiseSuggestionsToFreeform(_lorebookSuggestions));
}

/**
 * Searches _draftLorebook.entries for an entry whose comment matches `name`.
 * Returns the string uid key, or null if not found.
 */
function matchEntryByComment(name) {
    const lower = name.toLowerCase();
    for (const [uid, entry] of Object.entries(_draftLorebook?.entries ?? {})) {
        if ((entry.comment ?? '').toLowerCase() === lower) return uid;
    }
    return null;
}

/**
 * Returns the next available numeric uid for a new lorebook entry.
 */
function nextLorebookUid() {
    const keys = Object.keys(_draftLorebook?.entries ?? {}).map(Number).filter(n => !isNaN(n));
    return keys.length ? Math.max(...keys) + 1 : 0;
}

/**
 * Builds a complete ST worldinfo entry object for a new lorebook entry.
 */
function makeLbDraftEntry(uid, name, keys, content) {
    return {
        uid,
        key:                       keys,
        keysecondary:              [],
        comment:                   name,
        content,
        constant:                  false,
        vectorized:                false,
        selective:                 true,
        selectiveLogic:            0,
        addMemo:                   true,
        order:                     100,
        position:                  0,
        disable:                   false,
        ignoreBudget:              false,
        excludeRecursion:          false,
        preventRecursion:          false,
        matchPersonaDescription:   false,
        matchCharacterDescription: false,
        matchCharacterPersonality: false,
        matchCharacterDepthPrompt: false,
        matchScenario:             false,
        matchCreatorNotes:         false,
        delayUntilRecursion:       0,
        probability:               100,
        useProbability:            true,
        depth:                     4,
        outletName:                '',
        group:                     '',
        groupOverride:             false,
        groupWeight:               100,
        scanDepth:                 null,
        caseSensitive:             null,
        matchWholeWords:           null,
        useGroupScoring:           null,
        automationId:              '',
        role:                      0,
        sticky:                    null,
        cooldown:                  null,
        delay:                     null,
        triggers:                  [],
        displayIndex:              uid,
    };
}

/**
 * Builds a "Virtual Document" string from a lorebook entry's three editable fields.
 * Pure function — no DOM or module dependencies.
 */
function toVirtualDoc(name, keys, content) {
    const sortedKeys = [...keys].sort((a, b) => a.localeCompare(b));
    const keyLines   = sortedKeys.length ? sortedKeys.map(k => `KEY: ${k}`).join('\n') : 'KEY: (none)';
    return `NAME: ${name}\n${keyLines}\n\n${content}`;
}

/**
 * Reconciles a freshly-parsed suggestion list against the existing
 * _lorebookSuggestions array, preserving UID anchors and verdict flags.
 * All returned objects initialise _applied, _rejected, and _deleted to false
 * except when carrying forward a previously applied state from an existing entry.
 */
function enrichLbSuggestions(freshParsed) {
    const enriched = freshParsed.map(fresh => {
        const existing = _lorebookSuggestions.find(
            s => s._aiSnapshot.name.toLowerCase() === fresh.name.toLowerCase(),
        );

        if (existing) {
            if (existing._applied) {
                return {
                    type:        fresh.type,
                    name:        existing.name,
                    keys:        [...existing.keys],
                    content:     existing.content,
                    linkedUid:   existing.linkedUid,
                    _applied:    false,
                    _rejected:   false,
                    _deleted:    false,
                    _aiSnapshot: {
                        name:    existing._aiSnapshot.name,
                        keys:    [...existing._aiSnapshot.keys],
                        content: existing._aiSnapshot.content,
                    },
                };
            } else {
                return {
                    type:        fresh.type,
                    name:        fresh.name,
                    keys:        [...fresh.keys],
                    content:     fresh.content,
                    linkedUid:   existing.linkedUid,
                    _applied:    false,
                    _rejected:   existing._rejected,
                    _deleted:    false,
                    _aiSnapshot: {
                        name:    fresh.name,
                        keys:    [...fresh.keys],
                        content: fresh.content,
                    },
                };
            }
        } else {
            const uidStr    = matchEntryByComment(fresh.name);
            const linkedUid = uidStr !== null ? parseInt(uidStr, 10) : null;
            return {
                type:        fresh.type,
                name:        fresh.name,
                keys:        [...fresh.keys],
                content:     fresh.content,
                linkedUid,
                _applied:    false,
                _rejected:   false,
                _deleted:    false,
                _aiSnapshot: {
                    name:    fresh.name,
                    keys:    [...fresh.keys],
                    content: fresh.content,
                },
            };
        }
    });

    const seenUids = new Set();
    for (const s of enriched) {
        if (s.linkedUid === null) continue;
        if (seenUids.has(s.linkedUid)) {
            console.warn(`[CNZ] Two lorebook suggestions resolved to uid ${s.linkedUid}; treating second as NEW.`);
            s.linkedUid = null;
        } else {
            seenUids.add(s.linkedUid);
        }
    }

    return enriched;
}

/**
 * Derives a suggestion list by diffing two lorebook states.
 * Used by openReviewModal to reconstruct what changed in the last sync
 * entirely from the head anchor — no ephemeral sync-cycle variables needed.
 *
 * Entries present in `after` but not in `before` → type NEW, _applied false.
 * Entries present in both but with changed content/keys → type UPDATE, _applied false.
 * Entries present in `before` but removed from `after` → skipped (deletions not surfaced).
 *
 * All returned suggestions are marked _applied = false so the user can review
 * them via Apply/Reject. The underlying lorebook data is already committed to
 * disk; Apply/Reject only set the UI label and control Next Unresolved skipping.
 *
 * @param {object|null} before  Pre-sync lorebook (parent node state.lorebook), or null.
 * @param {object|null} after   Post-sync lorebook (head node state.lorebook).
 * @returns {object[]}          Suggestion objects compatible with the ingester pipeline.
 */
function deriveSuggestionsFromAnchorDiff(before, after) {
    const beforeEntries = before?.entries ?? {};
    const afterEntries  = after?.entries  ?? {};
    const suggestions   = [];

    for (const [uid, afterEntry] of Object.entries(afterEntries)) {
        const beforeEntry = beforeEntries[uid];
        const name    = afterEntry.comment || String(afterEntry.uid ?? uid);
        const keys    = Array.isArray(afterEntry.key) ? [...afterEntry.key] : [];
        const content = afterEntry.content ?? '';

        if (!beforeEntry) {
            // New entry
            suggestions.push({
                type:        'NEW',
                name,
                keys,
                content,
                linkedUid:   parseInt(uid, 10),
                _applied:    false,
                _rejected:   false,
                _deleted:    false,
                _aiSnapshot: { name, keys: [...keys], content },
            });
        } else {
            // Check for changes
            const contentChanged = beforeEntry.content !== afterEntry.content;
            const keysChanged    = JSON.stringify([...(beforeEntry.key ?? [])].sort())
                                !== JSON.stringify([...keys].sort());
            if (contentChanged || keysChanged) {
                suggestions.push({
                    type:        'UPDATE',
                    name,
                    keys,
                    content,
                    linkedUid:   parseInt(uid, 10),
                    _applied:    false,
                    _rejected:   false,
                    _deleted:    false,
                    _aiSnapshot: { name, keys: [...keys], content },
                });
            }
        }
    }

    return suggestions;
}

// ─── Character Persistence ────────────────────────────────────────────────────

/**
 * Writes an updated scenario string back to the character card via the ST API.
 * Only mutates the scenario field; all other character fields are preserved.
 * @param {object} char        Character object from ST context.
 * @param {string} newScenario Updated scenario string.
 */
async function patchCharacterWorld(char, lorebookName) {
    const updatedChar = structuredClone(char);
    if (!updatedChar.data)            updatedChar.data = {};
    if (!updatedChar.data.extensions) updatedChar.data.extensions = {};
    updatedChar.data.extensions.world = lorebookName;

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
    formData.append('world',                     lorebookName);
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
    if (!res.ok) throw new Error(`World link patch failed (HTTP ${res.status})`);
}


// ─── File Primitives ──────────────────────────────────────────────────────────

/**
 * Converts a raw avatar filename to a safe CNZ avatar key.
 * All characters outside [a-zA-Z0-9_\-] are replaced with '_'.
 * e.g. "seraphina.png" → "seraphina_png", "my char (2).png" → "my_char__2__png"
 * @param {string} avatarFilename  Raw avatar filename from char.avatar.
 * @returns {string}
 */
function cnzAvatarKey(avatarFilename) {
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
function cnzFileName(avatarKey, type, ...args) {
    switch (type) {
        case 'manifest':
            return `cnz_${avatarKey}_manifest.json`;
        case 'node':
            return `cnz_${avatarKey}_node_${args[0]}.json`;
        case 'rag': {
            const safeName = String(args[1] ?? '').replace(/[^a-zA-Z0-9_\-]/g, '_');
            return `cnz_${avatarKey}_rag_${args[0]}_${safeName}.txt`;
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
async function cnzDeleteFile(path) {
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

/**
 * @section Healer
 * @architectural-role Branch Detection and State Restoration
 * @description
 * Owns branch detection and state restoration. Walks the DNA chain embedded
 * in the chat to find the deepest still-valid anchor, then restores
 * lorebook and hooks from that anchor's payload.
 * @core-principles
 *   1. Healer never writes a new anchor — it only reads existing ones.
 *   2. Restoration reads from the anchor payload; no network fetches needed.
 * @api-declaration
 *   runHealer, restoreLorebookToNode, restoreHooksToNode, restoreRagToNode
 * @contract
 *   assertions:
 *     external_io: [/api/worldinfo/*, /api/files/delete, /api/chats/saveChat, promptManager.saveServiceSettings]
 */
// ─── Healer Utilities ─────────────────────────────────────────────────────────

/**
 * Restores the lorebook to the full snapshot stored in `node.state.lorebook`.
 * Fetches the node file, writes `state.lorebook` to disk, and updates in-memory state.
 * @param {object} char  Character object (avatar key used for node file lookup).
 * @param {object} node  Dummy chain entry (used only for error messages).
 */
async function restoreLorebookToNode(_char, node, nodeFile = null) {
    const nodeFile_ = nodeFile;
    if (!nodeFile_?.state?.lorebook) throw new Error(`[CNZ] No lorebook state in node ${node.nodeId}`);
    const lbData = nodeFile_.state.lorebook;
    const lbName = lbData.name || _lorebookName;
    await lbSaveLorebook(lbName, lbData);
    _lorebookName  = lbName;
    _lorebookData  = structuredClone(lbData);
    _draftLorebook = structuredClone(lbData);
}

/**
 * IO Executor. Restores the CNZ Summary prompt to the hooks state stored in
 * `node.state.hooks` and stamps the anchor UUID from `node.state.uuid`.
 * @param {object} char  Character object from ST context.
 * @param {object} _node Dummy chain entry (used only for error messages).
 * @param {object|null} nodeFile  nodeFile-shaped object with state.hooks and state.uuid.
 */
function restoreHooksToNode(char, _node, nodeFile = null) {
    const hooksText  = nodeFile?.state?.hooks ?? '';
    const anchorUuid = nodeFile?.state?.uuid  ?? null;
    writeCnzSummaryPrompt(char.avatar, hooksText, anchorUuid);
}

/**
 * Reconciles RAG character attachments to the state recorded in `nodeFile`.
 * Removes attachments belonging to orphaned nodes, deletes their files from
 * the Data Bank, then triggers a full vector purge and revectorize so the
 * vector index reflects only the restored timeline.
 * @param {object} char      Character object from ST context.
 * @param {object} nodeFile  Full node file object (already fetched by caller).
 */
async function restoreRagToNode(char, nodeFile) {
    const survivingFiles = nodeFile.state?.ragFiles ?? [];

    // ── 1. Scrub attachment registry ─────────────────────────────────────────
    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;

    const toRemove = allAttachments.filter(
        a => a.name?.startsWith(cnzRagPrefix) && !survivingFiles.includes(a.name)
    );
    const toKeep   = allAttachments.filter(a => !toRemove.includes(a));

    extension_settings.character_attachments[char.avatar] = toKeep;
    saveSettingsDebounced();

    // ── 2. Delete orphaned files from Data Bank ───────────────────────────────
    for (const attachment of toRemove) {
        await cnzDeleteFile(attachment.url);
    }

    // ── 3. Purge vector index and revectorize ─────────────────────────────────
    const { executeSlashCommandsWithOptions } = SillyTavern.getContext();
    await executeSlashCommandsWithOptions('/db-purge');
    await executeSlashCommandsWithOptions('/db-ingest');
}

/**
 * @section RAG Workshop
 * @architectural-role Modal Step 3 — Chunk Review UI
 * @description
 * Owns Step 3 of the review modal. Handles chunk card rendering, tab
 * switching, raw mode toggling, and the workshop entry/exit lifecycle.
 * Reuses the RAG Engine for individual chunk reclassification. Card state
 * is written back to _ragChunks so Finalize can detect what changed.
 * @core-principles
 *   1. Card edits mutate _ragChunks in memory only — no disk writes until Finalize.
 *   2. onEnterRagWorkshop and onLeaveRagWorkshop bracket the step lifecycle cleanly.
 * @api-declaration
 *   onEnterRagWorkshop, onLeaveRagWorkshop, renderRagWorkshop, renderRagCard,
 *   onRagTabSwitch, onRagRawInput, onRagRevertRaw, ragRegenCard
 * @contract
 *   assertions:
 *     external_io: [generateRaw]
 */
// ─── Modal: RAG Workshop Helpers ──────────────────────────────────────────────

/** Returns the compiled RAG document from current _ragChunks state. */
function compileRagFromChunks() {
    const ctx      = SillyTavern.getContext();
    const charName = ctx?.characters?.[ctx?.characterId]?.name ?? '';
    return buildRagDocument(_ragChunks, getSettings(), charName);
}

function autoResizeRagRaw() {
    const el = document.getElementById('cnz-rag-raw');
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function autoResizeRagCardHeader(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = el.scrollHeight + 'px';
}

function buildRagCardHTML(chunk) {
    const i          = chunk.chunkIndex;
    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    return `
<div class="cnz-rag-card" data-chunk-index="${i}" data-status="${chunk.status}">
  <div class="cnz-rag-card-header-row">
    <textarea class="cnz-input cnz-rag-card-header"
              data-chunk-index="${i}"
              ${isInFlight || _ragRawDetached ? 'disabled' : ''}>${escapeHtml(chunk.header)}</textarea>
    <span class="cnz-rag-card-spinner fa-solid fa-spinner fa-spin${isInFlight ? '' : ' cnz-hidden'}"></span>
    <span class="cnz-rag-queue-label${isPending ? '' : ' cnz-hidden'}">pending</span>
    <button class="cnz-btn cnz-btn-secondary cnz-btn-sm cnz-rag-card-regen"
            data-chunk-index="${i}"
            title="Regenerate this chunk's semantic header"
            ${_ragRawDetached ? 'disabled' : ''}>&#x21bb;</button>
  </div>
  <div class="cnz-rag-card-body">${escapeHtml(chunk.content)}</div>
</div>`;
}

function renderRagWorkshop() {
    const $cards = $('#cnz-rag-cards').empty();
    for (const chunk of _ragChunks) {
        $cards.append(buildRagCardHTML(chunk));
    }
    $cards.find('.cnz-rag-card-header').each(function () { autoResizeRagCardHeader(this); });
}

function ragRegenCard(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;

    chunk.status = 'pending';
    renderRagCard(chunkIndex);

    const messages  = SillyTavern.getContext().chat ?? [];
    const fullPairs = buildProsePairs(messages);
    const settings  = getSettings();
    setCurrentSettings(settings);
    dispatchContract('rag_classifier', {
        ragChunks:        [chunk],
        fullPairs,
        stagedPairs:      _stagedProsePairs,
        stagedPairOffset: _stagedPairOffset,
        splitPairIdx:     _splitPairIdx,
        scenario_hooks:   '',
    }, settings);
}

function onRagTabSwitch(tabName) {
    $('#cnz-rag-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-rag-tab-sectioned').toggleClass('cnz-hidden', tabName !== 'sectioned');
    $('#cnz-rag-tab-raw').toggleClass('cnz-hidden',      tabName !== 'raw');
    if (tabName === 'raw' && !_ragRawDetached) {
        $('#cnz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }
}

function onRagRawInput() {
    autoResizeRagRaw();
    if (!_ragRawDetached) {
        _ragRawDetached = true;
        $('#cnz-rag-raw').addClass('cnz-rag-detached');
        $('#cnz-rag-raw-detached-label').removeClass('cnz-hidden');
        $('#cnz-rag-detached-warn').removeClass('cnz-hidden');
        $('#cnz-rag-detached-revert').removeClass('cnz-hidden');
        $('.cnz-rag-card-header, .cnz-rag-card-regen').prop('disabled', true);
    }
}

function onRagRevertRaw() {
    _ragRawDetached = false;
    $('#cnz-rag-raw').val(compileRagFromChunks()).removeClass('cnz-rag-detached');
    autoResizeRagRaw();
    $('#cnz-rag-raw-detached-label, #cnz-rag-detached-warn, #cnz-rag-detached-revert').addClass('cnz-hidden');
    renderRagWorkshop();
}


function getRagModeLabel() {
    return 'Output: AI-classified summary + full text';
}

/**
 * Called when the user enters Step 3 (RAG Workshop). Guards against disabled RAG,
 * then renders existing `_ragChunks` or rebuilds them if the split boundary changed.
 */

function onEnterRagWorkshop() {
    if (!getSettings().enableRag) {
        $('#cnz-rag-mode-note').addClass('cnz-hidden');
        $('#cnz-rag-disabled').removeClass('cnz-hidden');
        return;
    }
    $('#cnz-rag-disabled').addClass('cnz-hidden');
    $('#cnz-rag-mode-note').text(getRagModeLabel()).removeClass('cnz-hidden');

    // Modal is a read-only view of _ragChunks. Sync owns all chunk building and dispatch.
    renderRagWorkshop();
    renderAllChunkChatLabels();

    // Auto-regen any pending chunks (e.g. restored from anchor with missing headers).
    // Only fires if no classifier jobs are already in-flight — avoids re-dispatching
    // chunks that a concurrent sync has already queued.
    const pendingChunks  = _ragChunks.filter(c => c.status === 'pending');
    const inFlightChunks = _ragChunks.filter(c => c.status === 'in-flight');
    if (pendingChunks.length > 0 && inFlightChunks.length === 0) {
        const messages = SillyTavern.getContext().chat ?? [];
        const fullPairs = buildProsePairs(messages);
        const settings  = getSettings();
        setCurrentSettings(settings);
        dispatchContract('rag_classifier', {
            ragChunks:        pendingChunks,
            fullPairs,
            stagedPairs:      _stagedProsePairs,
            stagedPairOffset: _stagedPairOffset,
            splitPairIdx:     _splitPairIdx,
            scenario_hooks:   '',
        }, settings);
    }
}

function onLeaveRagWorkshop() {
    // Fan-out jobs remain in-flight; invalidateAllJobs() handles cancellation on modal close.
}

/**
 * @section Hooks Workshop
 * @architectural-role Modal Step 1 — Hookseeker Review UI
 * @description
 * Owns Step 1 of the review modal. Builds the sync-window transcript for
 * display, drives hookseeker regen, manages tab switching between the
 * generated summary and the diff view, and renders the word-level diff
 * against the previous sync's hookseeker output.
 * @core-principles
 *   1. Regen updates _priorSituation and _beforeSituation in memory; disk write deferred to Finalize.
 *   2. Diff is always computed against the head anchor's before-state, never against a local variable.
 * @api-declaration
 *   buildSyncWindowTranscript, buildModalTranscript, onRegenHooksClick,
 *   onHooksTabSwitch, updateHooksDiff, setHooksLoading
 * @contract
 *   assertions:
 *     external_io: [generateRaw]
 */
// ─── Modal: Hooks Workshop ────────────────────────────────────────────────────

function setHooksLoading(isLoading) {
    _hooksLoading = isLoading;
    $('#cnz-spin-hooks').toggleClass('cnz-hidden', !isLoading);
    $('#cnz-regen-hooks').prop('disabled', isLoading);
    $('#cnz-situation-text').prop('disabled', isLoading);
}

/**
 * Builds a rolling window transcript for modal AI calls, using the full chat
 * (up to the latest turn). Used when "up to latest turn" is explicitly requested.
 * @param {number} horizonTurns  Number of trailing turns to include.
 * @returns {string}
 */
function buildModalTranscript(horizonTurns) {
    const context      = SillyTavern.getContext();
    const messages     = context.chat ?? [];
    const allPairs     = buildProsePairs(messages);
    const windowPairs  = allPairs.slice(-horizonTurns);
    const windowMsgs   = windowPairs.flatMap(p => [p.user, ...p.messages]);
    return buildTranscript(windowMsgs);
}

/**
 * Builds a transcript bounded by the sync window (_stagedProsePairs), so AI calls
 * never see turns beyond the edge of the last sync. Falls back to full context if no
 * sync has been staged yet.
 * Always enforces liveContextBuffer at read time — a no-op when _stagedProsePairs was
 * correctly pre-trimmed by runCnzSync, but prevents buffer leakage if that invariant
 * is ever violated by a future writer.
 * @param {number}   horizonTurns  Number of trailing turns to include.
 * @param {object[]} messages      Full chat message array.
 * @param {object}   settings      Active profile settings (liveContextBuffer).
 * @returns {string}
 */
function buildSyncWindowTranscript(horizonTurns, messages, settings) {
    const allPairs = buildProsePairs(messages);

    const lcb = settings.liveContextBuffer ?? 5;
    const tbb = Math.max(0, allPairs.length - lcb);   // trailing buffer boundary in pairs

    let windowPairs = allPairs.filter((_, i) => i < tbb);

    // SURGICAL UNLOCK: If the buffer is larger than the chat,
    // don't send an empty transcript. Send the last available pair.
    if (windowPairs.length === 0 && allPairs.length > 0) {
        windowPairs = [allPairs[allPairs.length - 1]];
    }

    const windowMsgs = windowPairs.slice(-horizonTurns).flatMap(p => [p.user, ...p.messages]);
    return buildTranscript(windowMsgs);
}

/**
 * Switches the Step 1 Hooks Workshop to the given tab ('workshop' | 'new' | 'old').
 * @param {string} tabName
 */
function onHooksTabSwitch(tabName) {
    $('#cnz-hooks-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-hooks-tab-workshop').toggleClass('cnz-hidden', tabName !== 'workshop');
    $('#cnz-hooks-tab-new').toggleClass('cnz-hidden',      tabName !== 'new');
    $('#cnz-hooks-tab-old').toggleClass('cnz-hidden',      tabName !== 'old');
}

/** Recomputes the Workshop tab diff display (textarea content vs `_beforeSituation`). */
function updateHooksDiff() {
    const current = $('#cnz-situation-text').val();
    $('#cnz-hooks-diff').html(wordDiff(_beforeSituation, current));
}

/**
 * Fires a fresh hookseeker AI call and updates `_priorSituation`, the textarea,
 * the New tab display, and the Workshop diff. Switches to Workshop tab on success.
 */
function onRegenHooksClick() {
    setHooksLoading(true);
    $('#cnz-error-1').addClass('cnz-hidden').text('');
    const horizon       = getSettings().hookseekerHorizon ?? 40;
    const regenMessages = SillyTavern.getContext().chat ?? [];
    const regenSettings = getSettings();
    const transcript    = buildSyncWindowTranscript(horizon, regenMessages, regenSettings);
    runHookseekerCall(transcript, _priorSituation)
        .then(text => {
            const trimmed = text.trim();
            _priorSituation = trimmed;
            $('#cnz-situation-text').val(trimmed);
            $('#cnz-hooks-new-display').text(trimmed);
            updateHooksDiff();
            setHooksLoading(false);
            onHooksTabSwitch('workshop');
        })
        .catch(err => {
            $('#cnz-error-1').text(`Hooks generation failed: ${err.message}`).removeClass('cnz-hidden');
            setHooksLoading(false);
        });
}

/**
 * @section Lorebook Workshop
 * @architectural-role Modal Step 2 — Suggestion Review UI
 * @description
 * Owns Step 2 of the review modal. Manages the suggestion ingester UI,
 * targeted generate, and draft staging. All entry edits go to _draftLorebook
 * only — no disk writes until Finalize. The ingester cycles through AI
 * suggestions and lets the user apply, reject, or revert each one individually,
 * with freeform editing available at any point.
 * @core-principles
 *   1. All mutations go to _draftLorebook — the ingester never touches _lorebookData directly.
 *   2. initWizardSession resets UI state only; _draftLorebook and _lorebookSuggestions persist.
 * @api-declaration
 *   onLbRegenClick, onLbTabSwitch, populateLbIngesterDropdown,
 *   populateTargetedEntrySelect, renderLbIngesterDetail,
 *   onLbSuggestionSelectChange, onLbIngesterEditorInput, onLbIngesterApply,
 *   onLbIngesterReject, onLbIngesterLoadLatest, onLbIngesterLoadPrev,
 *   onLbIngesterRegenerate, revertLbSuggestion, onLbApplyAllUnresolved,
 *   onTargetedGenerateClick, syncFreeformFromSuggestions
 * @contract
 *   assertions:
 *     external_io: [generateRaw]
 */
// ─── Modal: Lorebook Workshop ─────────────────────────────────────────────────

function setLbLoading(isLoading) {
    _lorebookLoading = isLoading;
    $('#cnz-lb-spinner').toggleClass('cnz-hidden', !isLoading);
    $('#cnz-lb-freeform-regen').prop('disabled', isLoading);
    if (isLoading) $('#cnz-lb-freeform').val('');
}


function showLbError(message) {
    setLbLoading(false);
    $('#cnz-lb-error').text(message).removeClass('cnz-hidden');
}

/**
 * Freeform Regen: fires a full lorebook sync AI call, resets the draft to the
 * parent node baseline, and rebuilds the suggestion list from scratch.
 * Asks for confirmation because it discards any corrections already made.
 */
async function onLbRegenClick() {
    // Lower CNZ overlay z-index temporarily so callPopup renders above it.
    // Must use an explicit value — setting '' just removes the inline style and the
    // stylesheet rule (.cnz-overlay { z-index: var(--cnz-z-modal) }) immediately
    // snaps back to 9999, so the overlay never actually drops.
    const $overlay = $('#cnz-overlay');
    $overlay.css('z-index', '1');
    let confirmed;
    try {
        confirmed = await callPopup(
            'This will run a fresh lorebook AI call and rebuild the suggestion list from scratch, resetting to the parent node baseline and discarding any corrections or previously committed lorebook changes made in this session. Continue?',
            'confirm',
        );
    } finally {
        $overlay.css('z-index', '');
    }
    if (!confirmed) return;

    setLbLoading(true);
    $('#cnz-lb-error').addClass('cnz-hidden').text('');

    // preSyncLorebook = parent anchor's lorebook — set by openReviewModal from DNA chain.
    // Falls back to _lorebookData if no parent anchor exists (first sync).
    const preSyncLorebook = _parentNodeLorebook
        ? structuredClone(_parentNodeLorebook)
        : structuredClone(_lorebookData ?? { entries: {} });

    const horizon       = getSettings().chunkEveryN ?? 20;
    const upToLatest    = $('#cnz-lb-up-to-latest').is(':checked');
    const lbRegenMsgs   = SillyTavern.getContext().chat ?? [];
    const lbRegenSet    = getSettings();
    const transcript    = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, lbRegenMsgs, lbRegenSet);
    runLorebookSyncCall(transcript, preSyncLorebook)
        .then(text => {

            // Reset draft AND server-copy baseline to pre-sync state (captured before this
            // async call).  Both must share the same reference point so isDraftDirty only
            // fires when the AI actually produced changes — otherwise a regen that yields
            // no suggestions would compare _draftLorebook (A) against a stale _lorebookData
            // that reflects a previously-committed lorebook (B), producing a false dirty and
            // overwriting B with A on Finalize.
            _draftLorebook = structuredClone(preSyncLorebook);
            _lorebookData  = structuredClone(preSyncLorebook);

            // Parse and auto-apply new suggestions
            const suggestions = parseLbSuggestions(text);
            _lorebookSuggestions = enrichLbSuggestions(suggestions);

            for (const s of _lorebookSuggestions) {
                if (s.linkedUid !== null) {
                    const entry = _draftLorebook.entries[String(s.linkedUid)];
                    if (entry) {
                        entry.comment = s.name;
                        entry.key     = s.keys;
                        entry.content = s.content;
                    }
                } else {
                    const uid = nextLorebookUid();
                    _draftLorebook.entries[String(uid)] = makeLbDraftEntry(uid, s.name, s.keys, s.content);
                    s.linkedUid = uid;
                }
                s._applied = false;
            }

            setLbLoading(false);
            _lbActiveIngesterIndex = Math.max(0, Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1));
            populateLbIngesterDropdown();
            if (_lorebookSuggestions[_lbActiveIngesterIndex]) renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
            syncFreeformFromSuggestions();
        })
        .catch(err => {
            showLbError(`Regeneration failed: ${err.message}`);
        });
}

/**
 * Activates the named lorebook tab (freeform / ingester).
 * @param {string} tabName  One of 'freeform', 'ingester'.
 */
function onLbTabSwitch(tabName) {
    $('#cnz-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === tabName);
    });
    $('#cnz-lb-tab-freeform').toggleClass('cnz-hidden',  tabName !== 'freeform');
    $('#cnz-lb-tab-ingester').toggleClass('cnz-hidden',  tabName !== 'ingester');

    if (tabName === 'ingester' && !_lorebookLoading) {
        _lbActiveIngesterIndex = Math.max(0, Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1));
        populateLbIngesterDropdown();
        populateTargetedEntrySelect();
        if (_lorebookSuggestions[_lbActiveIngesterIndex]) renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
    }
}

/**
 * Populates the targeted-generate entry dropdown from current _lorebookData.
 * Preserves the current selection if the entry still exists.
 */
function populateTargetedEntrySelect() {
    const $sel    = $('#cnz-targeted-entry-select');
    const prevVal = $sel.val();
    $sel.empty().append('<option value="">— Select entry —</option>');

    const entries = _draftLorebook?.entries ?? {};
    const sorted  = Object.values(entries)
        .sort((a, b) => (a.comment || '').localeCompare(b.comment || ''));

    for (const entry of sorted) {
        const name = entry.comment || String(entry.uid);
        $sel.append($('<option>').val(String(entry.uid)).text(name));
    }

    $sel.val(prevVal);  // jQuery no-ops silently if prevVal no longer exists
}

function populateLbIngesterDropdown() {
    const $sel = $('#cnz-lb-suggestion-select').empty();
    if (!_lorebookSuggestions.length) {
        $sel.append('<option disabled selected>(no sync changes — use Lane 2 or 3 to add entries)</option>');
        $('#cnz-lb-apply-one, #cnz-lb-reject-one, #cnz-lb-delete-one, #cnz-lb-apply-all-unresolved').prop('disabled', true);
        $('#cnz-lb-editor-name, #cnz-lb-editor-keys, #cnz-lb-editor-content').val('');
        $('#cnz-lb-ingester-diff').empty();
        return;
    }
    _lorebookSuggestions.forEach((s, i) => {
        const prefix = s._deleted  ? '\u2716 '
                     : s._applied  ? '\u2713 '
                     : s._rejected ? '\u2717 '
                     : '';
        const label  = s._deleted
            ? `${prefix}DELETE: ${s.name}`
            : `${prefix}${s.type}: ${s.name}`;
        $sel.append(`<option value="${i}">${escapeHtml(label)}</option>`);
    });
    $sel.val(_lbActiveIngesterIndex);
    $('#cnz-lb-apply-one, #cnz-lb-apply-all-unresolved').prop('disabled', false);
}

/**
 * Populates the shared editor fields and manages all ingester button states for
 * the given suggestion. This is the single authoritative place for verdict button
 * enable/disable logic — do not add button state changes elsewhere.
 * @param {object} suggestion  A _lorebookSuggestions entry.
 */
function renderLbIngesterDetail(suggestion) {
    if (!suggestion) return;
    $('#cnz-lb-editor-name').val(suggestion.name);
    $('#cnz-lb-editor-keys').val(suggestion.keys.join(', '));
    $('#cnz-lb-editor-content').val(suggestion.content);
    $('#cnz-lb-error-ingester').addClass('cnz-hidden').text('');
    // ← Latest: disabled if the AI never generated anything for this entry
    const hasAiSnapshot = !!(suggestion._aiSnapshot?.content);
    $('#cnz-lb-btn-latest').prop('disabled', !hasAiSnapshot);
    // ← Prev: disabled for brand-new entries; enabled on deleted entries with a prior version
    const hasPrev = suggestion.linkedUid !== null &&
        !!(_parentNodeLorebook?.entries?.[String(suggestion.linkedUid)]);
    $('#cnz-lb-btn-prev').prop('disabled', !hasPrev);
    // Verdict buttons: whichever verdict is active is disabled; the others are enabled
    const isDeleted  = !!suggestion._deleted;
    const isApplied  = !!suggestion._applied  && !isDeleted;
    const isRejected = !!suggestion._rejected && !isDeleted;
    $('#cnz-lb-apply-one').prop('disabled',  isApplied);
    $('#cnz-lb-reject-one').prop('disabled', isRejected);
    $('#cnz-lb-delete-one').prop('disabled', isDeleted);
    updateLbDiff();
}

/**
 * LCS-based word diff. Returns an HTML string with del/ins spans.
 * @param {string} base
 * @param {string} proposed
 * @returns {string}
 */
function wordDiff(base, proposed) {
    const tokenise = str => str.match(/[^\s]+\s*|\s+/g) || [];
    const bt = tokenise(base);
    const pt = tokenise(proposed);
    const m  = bt.length, n = pt.length;
    const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = m - 1; i >= 0; i--) {
        for (let j = n - 1; j >= 0; j--) {
            dp[i][j] = bt[i] === pt[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
    }
    const out = []; let del = [], ins = [];
    const flush = () => {
        if (del.length) { out.push(`<span class="cnz-diff-del">${escapeHtml(del.join(''))}</span>`); del = []; }
        if (ins.length) { out.push(`<span class="cnz-diff-ins">${escapeHtml(ins.join(''))}</span>`); ins = []; }
    };
    let i = 0, j = 0;
    while (i < m || j < n) {
        if (i < m && j < n && bt[i] === pt[j]) { flush(); out.push(escapeHtml(bt[i])); i++; j++; }
        else if (j < n && (i >= m || dp[i][j + 1] >= dp[i + 1][j])) { ins.push(pt[j]); j++; }
        else { del.push(bt[i]); i++; }
    }
    flush();
    return out.join('');
}

function updateLbDiff() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    const uid = s?.linkedUid != null
        ? String(s.linkedUid)
        : $('#cnz-targeted-entry-select').val() || null;
    if (!uid && !s) return;

    const name    = $('#cnz-lb-editor-name').val();
    const keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#cnz-lb-editor-content').val();
    const proposed = toVirtualDoc(name, keys, content);

    let base = '';
    if (uid) {
        const parentEntry = _parentNodeLorebook?.entries?.[uid];
        if (parentEntry) {
            base = toVirtualDoc(
                parentEntry.comment || '',
                Array.isArray(parentEntry.key) ? parentEntry.key : [],
                parentEntry.content || '',
            );
        }
        // no parentEntry → entry is new this sync → base stays ''
    }

    $('#cnz-lb-ingester-diff').html(wordDiff(base, proposed));
}

function onLbSuggestionSelectChange() {
    const idx = parseInt($('#cnz-lb-suggestion-select').val(), 10);
    if (!isNaN(idx) && _lorebookSuggestions[idx]) {
        _lbActiveIngesterIndex = idx;
        renderLbIngesterDetail(_lorebookSuggestions[idx]);
    }
}

function onLbIngesterEditorInput() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (s) {
        const newName = $('#cnz-lb-editor-name').val();
        s.name    = newName;
        s.keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
        s.content = $('#cnz-lb-editor-content').val();
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $('#cnz-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${newName}`));
        // Continuously sync _draftLorebook so corrections are never lost
        if (s.linkedUid !== null) {
            const entry = _draftLorebook?.entries?.[String(s.linkedUid)];
            if (entry) {
                entry.comment = s.name;
                entry.key     = s.keys;
                entry.content = s.content;
            }
        }
    }
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer = setTimeout(() => { updateLbDiff(); syncFreeformFromSuggestions(); }, 300);
}

/** ← Latest: loads the most recent AI snapshot back into the editor. */
function onLbIngesterLoadLatest() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s || !s._aiSnapshot) return;
    s.name = s._aiSnapshot.name; s.keys = [...s._aiSnapshot.keys]; s.content = s._aiSnapshot.content;
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#cnz-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    syncFreeformFromSuggestions();
}

/** ← Prev: loads the pre-sync version of this entry into the editor. */
function onLbIngesterLoadPrev() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s || s.linkedUid === null) return;

    const uidStr      = String(s.linkedUid);
    const parentEntry = _parentNodeLorebook?.entries?.[uidStr];
    if (!parentEntry) return;  // new entry — no parent-node baseline

    let entry = _draftLorebook?.entries?.[uidStr];
    if (!entry) {
        // Entry was deleted — re-add from parent state before restoring
        if (!_draftLorebook?.entries) return;
        _draftLorebook.entries[uidStr] = makeLbDraftEntry(
            parseInt(uidStr, 10),
            parentEntry.comment || '',
            Array.isArray(parentEntry.key) ? [...parentEntry.key] : [],
            parentEntry.content || '',
        );
        entry = _draftLorebook.entries[uidStr];
    }
    entry.comment = parentEntry.comment || '';
    entry.key     = Array.isArray(parentEntry.key) ? [...parentEntry.key] : [];
    entry.content = parentEntry.content || '';
    s.name    = entry.comment;
    s.keys    = [...entry.key];
    s.content = entry.content;
    s._deleted  = false;
    s._applied  = false;
    s._rejected = false;

    renderLbIngesterDetail(s);
    const prefix = s._deleted  ? '\u2716 '
                 : s._applied  ? '\u2713 '
                 : s._rejected ? '\u2717 '
                 : '';
    $('#cnz-lb-suggestion-select option').eq(_lbActiveIngesterIndex)
        .text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Regenerate: fires a fresh targeted AI call for the currently loaded entry.
 * Lands in the editor, keeps the suggestion unresolved for review.
 */
function onLbIngesterRegenerate() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;

    const mode    = s.linkedUid !== null ? 'update' : 'new';
    const entry   = s.linkedUid !== null ? (_draftLorebook?.entries?.[String(s.linkedUid)] ?? null) : null;
    const keys    = entry ? (Array.isArray(entry.key) ? entry.key.join(', ') : '') : s.keys.join(', ');
    const content = entry?.content ?? s.content;

    const horizon        = getSettings().hookseekerHorizon ?? 40;
    const upToLatest     = $('#cnz-lb-up-to-latest').is(':checked');
    const regenIngMsgs   = SillyTavern.getContext().chat ?? [];
    const regenIngSet    = getSettings();
    const transcript     = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, regenIngMsgs, regenIngSet);

    $('#cnz-lb-btn-regen').prop('disabled', true);

    runTargetedLbCall(mode, s.name, keys, content, transcript)
        .then(rawText => {
            const trimmed = rawText?.trim() ?? '';
            if (!trimmed || trimmed === 'NO CHANGES NEEDED' || trimmed === 'NO INFORMATION FOUND') {
                toastr.info('CNZ: No changes suggested by AI.');
                return;
            }

            const parsed = parseLbSuggestions(trimmed);
            if (!parsed.length) { toastr.warning('CNZ: Could not parse AI response.'); return; }

            const fresh = parsed[0];
            s.name    = fresh.name;
            s.keys    = [...fresh.keys];
            s.content = fresh.content;
            s._aiSnapshot = { name: fresh.name, keys: [...fresh.keys], content: fresh.content };
            s._applied  = false;
            s._rejected = false;

            renderLbIngesterDetail(s);
            $('#cnz-lb-suggestion-select option').eq(_lbActiveIngesterIndex)
                .text(escapeHtml(`${s.type}: ${s.name}`));
            syncFreeformFromSuggestions();
            toastr.success('CNZ: Regenerated — review in editor.');
        })
        .catch(err => {
            toastr.error(`CNZ: Regenerate failed: ${err.message}`);
        })
        .finally(() => {
            $('#cnz-lb-btn-regen').prop('disabled', false);
        });
}

function onLbIngesterNext() {
    const total = _lorebookSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (_lbActiveIngesterIndex + offset) % total;
        if (!_lorebookSuggestions[i]._applied && !_lorebookSuggestions[i]._rejected) {
            _lbActiveIngesterIndex = i;
            $('#cnz-lb-suggestion-select').val(i);
            renderLbIngesterDetail(_lorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All lorebook suggestions have been reviewed.');
}

function onLbIngesterApply() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    const name    = $('#cnz-lb-editor-name').val().trim();
    const keys    = $('#cnz-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#cnz-lb-editor-content').val().trim();
    if (!name || !content) return;
    s.name = name; s.keys = keys; s.content = content;
    if (s.linkedUid !== null) {
        const entry = _draftLorebook.entries[String(s.linkedUid)];
        if (entry) { entry.comment = name; entry.key = keys; entry.content = content; }
    } else {
        const newUid = nextLorebookUid();
        _draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
        s.linkedUid = newUid;
        // ← Prev is now enabled since we have a linked entry; update button state
        $('#cnz-lb-btn-prev').prop('disabled', !(_parentNodeLorebook?.entries?.[String(newUid)]));
    }
    s._applied = true; s._rejected = false;

    $('#cnz-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`\u2713 ${s.type}: ${s.name}`));
    updateLbDiff();
    syncFreeformFromSuggestions();
}

/**
 * Reverts the suggestion at `idx` to its parent-node state in _draftLorebook.
 * Restores entry content/keys in the draft if the entry existed before the sync;
 * removes it from the draft if it didn't. Also syncs s.name/s.keys/s.content on
 * the suggestion object so the editor and freeform reflect the reverted state
 * before rendering. Memory-only — no disk write.
 * @param {number} idx  Index into _lorebookSuggestions.
 */
function revertLbSuggestion(idx) {
    const s = _lorebookSuggestions[idx];
    if (!s) return;

    const uidStr = s.linkedUid !== null ? String(s.linkedUid) : null;

    if (uidStr !== null) {
        const parentEntry = _parentNodeLorebook?.entries?.[uidStr];
        if (parentEntry) {
            // Entry existed before this sync — restore to parent node state
            const entry = _draftLorebook?.entries?.[uidStr];
            if (entry) {
                entry.comment = parentEntry.comment || '';
                entry.key     = Array.isArray(parentEntry.key) ? [...parentEntry.key] : [];
                entry.content = parentEntry.content || '';
            }
        } else {
            // Entry did not exist before this sync — remove it
            if (_draftLorebook?.entries) delete _draftLorebook.entries[uidStr];
        }
    }

    if (uidStr !== null) {
        const parentEntry = _parentNodeLorebook?.entries?.[uidStr];
        if (parentEntry) {
            s.name    = parentEntry.comment || '';
            s.keys    = Array.isArray(parentEntry.key) ? [...parentEntry.key] : [];
            s.content = parentEntry.content || '';
        } else {
            // New entry — no prior version, clear content
            s.keys    = [];
            s.content = '';
        }
    }

    s._rejected = true;
    s._applied  = false;

    // Update ingester dropdown label
    $('#cnz-lb-suggestion-select option')
        .eq(idx)
        .text(escapeHtml(`\u2717 ${s.type}: ${s.name}`));

    // Refresh both panels if visible
    if (_lbActiveIngesterIndex === idx) {
        renderLbIngesterDetail(s);
        updateLbDiff();
    }
}

function onLbIngesterReject() {
    revertLbSuggestion(_lbActiveIngesterIndex);
    syncFreeformFromSuggestions();
}

/**
 * Marks the suggestion at `idx` as deleted: removes the entry from
 * _draftLorebook.entries so Finalize will not write it, clears keys and content
 * on the suggestion object, and sets _deleted = true. s.name is preserved as a
 * display label. Memory-only — no disk write.
 * @param {number} idx  Index into _lorebookSuggestions.
 */
function deleteLbEntry(idx) {
    const s = _lorebookSuggestions[idx];
    if (!s) return;

    // Remove from draft lorebook
    if (s.linkedUid !== null) {
        if (_draftLorebook?.entries) {
            delete _draftLorebook.entries[String(s.linkedUid)];
        }
    }

    // Update suggestion state
    s._deleted  = true;
    s._applied  = false;
    s._rejected = false;
    s.keys      = [];
    s.content   = '';
    // s.name preserved as label

    // Update dropdown
    $('#cnz-lb-suggestion-select option')
        .eq(idx)
        .text(escapeHtml(`\u2716 DELETE: ${s.name}`));

    if (_lbActiveIngesterIndex === idx) {
        renderLbIngesterDetail(s);
        updateLbDiff();
    }

    syncFreeformFromSuggestions();
}

async function onLbApplyAllUnresolved() {
    const unresolved = _lorebookSuggestions.filter(s => !s._applied && !s._rejected);
    if (!unresolved.length) { toastr.info('No unresolved lorebook suggestions to apply.'); return; }
    const count     = unresolved.length;
    const $overlay  = $('#cnz-overlay');
    $overlay.css('z-index', '1');
    let confirmed;
    try {
        confirmed = await callPopup(
            `This will apply all ${count} unreviewed suggestion${count !== 1 ? 's' : ''} to the Lorebook using the AI\'s current text. Continue?`,
            'confirm',
        );
    } finally {
        $overlay.css('z-index', '');
    }
    if (!confirmed) return;
    for (const s of unresolved) {
        const name = s.name.trim(), keys = [...s.keys], content = s.content.trim();
        if (!name || !content) continue;
        if (s.linkedUid !== null) {
            const entry = _draftLorebook.entries[String(s.linkedUid)];
            if (entry) { entry.comment = name; entry.key = keys; entry.content = content; }
        } else {
            const newUid = nextLorebookUid();
            _draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
            s.linkedUid = newUid;
        }
        s._applied = true; s._rejected = false;
    }
    populateLbIngesterDropdown();
    if (_lorebookSuggestions[_lbActiveIngesterIndex]) renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
    syncFreeformFromSuggestions();
    toastr.success(`Applied ${count} lorebook suggestion${count !== 1 ? 's' : ''} — will be saved on Finalize.`);
}

// ─── Modal: Commit Receipts Panel ─────────────────────────────────────────────

function showReceiptsPanel() { $('#cnz-receipts').removeClass('cnz-hidden'); }

function showRecoveryGuide() {
    $('#cnz-recovery-guide').removeClass('cnz-hidden');
    $('#cnz-cancel').text('Close');
}

function upsertReceiptItem(id, html) {
    if (!$(`#${id}`).length) {
        $('#cnz-receipts-content').append(`<div id="${id}" class="cnz-receipt-row"></div>`);
    }
    $(`#${id}`).html(html);
}

function receiptSuccess(text, hint = null) {
    return `<span class="cnz-receipt-item success">&#x2713; ${escapeHtml(text)}</span>` +
           (hint ? `<div class="cnz-receipt-hint">${escapeHtml(hint)}</div>` : '');
}

function receiptFailure(text) {
    return `<span class="cnz-receipt-item failure">&#x2717; ${escapeHtml(text)}</span>`;
}

// ─── Modal: Review & Commit Step ─────────────────────────────────────────────

function countDraftChanges() {
    if (!_draftLorebook || !_lorebookData) return 0;
    const orig  = _lorebookData.entries  ?? {};
    const draft = _draftLorebook.entries ?? {};
    return Object.values(draft).filter(e => {
        const o = orig[String(e.uid)];
        return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key);
    }).length;
}

function populateRagPanel() {
    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char || !getSettings().enableRag) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
    const headAnchor     = _dnaChain?.lkg;
    const ragExpected    = headAnchor && (headAnchor.ragHeaders?.length > 0 || headAnchor.ragUrl);
    if (!allAttachments.length && !ragExpected) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
    if (ragExpected && !allAttachments.length) {
        $('#cnz-rag-timeline').empty();
        $('#cnz-rag-warning').text('Narrative Memory file missing — confirm to rebuild from current chunks.').removeClass('cnz-hidden');
        $('#cnz-step4-rag').removeClass('cnz-hidden');
        return;
    }
    const rows = allAttachments.map(a =>
        `<div class="cnz-rag-item cnz-rag-item--existing">&#x2713; ${escapeHtml(a.name.replace(/\.txt$/i, ''))}</div>`,
    );
    $('#cnz-rag-timeline').html(rows.join(''));
    $('#cnz-rag-warning').addClass('cnz-hidden');
    $('#cnz-step4-rag').removeClass('cnz-hidden');
}

function populateStep4Summary() {
    const loreCount   = countDraftChanges();
    const loreLabel   = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb   = _lorebookSuggestions.filter(s => !s._applied && !s._rejected).length;
    const pendingText = pendingLb > 0
        ? ` \u26a0 ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    const hooksText    = $('#cnz-situation-text').val().trim();
    const hooksPreview = hooksText.length > 100 ? hooksText.slice(0, 100) + '\u2026' : (hooksText || '(empty)');
    $('#cnz-step4-hooks').text(`Hooks: ${hooksPreview}`);
    $('#cnz-step4-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
    populateRagPanel();
}

function abortCommitWithError(message) {
    $('#cnz-error-4').text(message).removeClass('cnz-hidden');
    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', false);
    showRecoveryGuide();
}

/**
 * Returns true if draft lorebook differs from base (content or keys changed).
 * @param {object} draft
 * @param {object} base
 * @returns {boolean}
 */
function isDraftDirty(draft, base) {
    if (!draft || !base) return false;
    const d = draft.entries  ?? {};
    const b = base.entries ?? {};
    if (Object.keys(d).length !== Object.keys(b).length) return true;
    for (const [uid, entry] of Object.entries(d)) {
        const orig = b[uid];
        if (!orig) return true;
        if (orig.content !== entry.content) return true;
        if (JSON.stringify(orig.key) !== JSON.stringify(entry.key)) return true;
    }
    return false;
}

/**
 * Handles the modal Confirm button. Conditionally writes back only what changed:
 * hooks (if textarea diverged from `_priorSituation`), lorebook (if `isDraftDirty`),
 * RAG (if any chunk header was manually edited or raw mode is detached).
 * Updates the head anchor in place — never writes a new anchor.
 * Closes the modal on completion.
 */
async function onConfirmClick() {
    const hooksText = $('#cnz-situation-text').val().trim();

    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char) { toastr.error('CNZ: No character in context.'); return; }

    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', true);
    $('#cnz-error-4').addClass('cnz-hidden').text('');
    showReceiptsPanel();

    // Freshness check — abort if a sync committed while this modal was open
    const liveChainNow = readDnaChain(SillyTavern.getContext().chat ?? []);
    if ((liveChainNow.lkg?.uuid ?? null) !== _modalOpenHeadUuid) {
        abortCommitWithError('A sync committed while this modal was open. Close and re-open to retry.');
        return;
    }

    let hooksChanged    = false;
    let lorebookChanged = false;
    let ragChanged      = false;
    let newRagUrl       = null;
    let newRagFileName  = null;

    // ── Step 1: Hooks save ───────────────────────────────────────────────────
    if (hooksText !== _priorSituation) {
        try {
            // UUID unchanged — Confirm patches the head anchor in-place
            writeCnzSummaryPrompt(char.avatar, hooksText, _dnaChain.lkg?.uuid ?? null);
            _priorSituation = hooksText;
            hooksChanged = true;
            upsertReceiptItem('cnz-receipt-hooks', receiptSuccess('Narrative Hooks updated in CNZ Summary prompt'));
        } catch (err) {
            console.error('[CNZ] Hooks save failed:', err);
            upsertReceiptItem('cnz-receipt-hooks', receiptFailure(`Hooks save failed: ${err.message}`));
            abortCommitWithError(err.message);
            return;
        }
    }

    // ── Step 2: Lorebook save ────────────────────────────────────────────────
    if (isDraftDirty(_draftLorebook, _lorebookData)) {
        if (_draftLorebook && _lorebookName) {
            try {
                const preLorebook = structuredClone(_lorebookData ?? { entries: {} });
                await lbSaveLorebook(_lorebookName, _draftLorebook);
                _lorebookData = structuredClone(_draftLorebook);

                lorebookChanged = true;

                const changedNames = Object.values(_draftLorebook.entries ?? {})
                    .filter(e => { const o = preLorebook.entries[String(e.uid)]; return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key); })
                    .map(e => e.comment || String(e.uid));
                upsertReceiptItem('cnz-receipt-lorebook', receiptSuccess(
                    `Lorebook committed: ${changedNames.length ? changedNames.map(n => `"${n}"`).join(', ') : '(no changes staged)'}`,
                ));
            } catch (err) {
                upsertReceiptItem('cnz-receipt-lorebook', receiptFailure(`Lorebook save failed: ${err.message}`));
                abortCommitWithError(err.message);
                return;
            }
        }
    }

    // Reverts are saved immediately but the head anchor still needs updating
    if (!lorebookChanged && _lorebookSuggestions.some(s => s._rejected)) {
        lorebookChanged = true;
    }

    // ── Step 3: RAG upload ───────────────────────────────────────────────────
    const hasManualChunks    = _ragChunks.some(c => c.status === 'manual');
    const hasSettledChunks   = _ragChunks.some(c => c.status === 'complete' || c.status === 'manual');
    const ragAttachments     = extension_settings.character_attachments?.[char.avatar] ?? [];
    const ragFileMissing     = hasSettledChunks && ragAttachments.length === 0;
    if (hasManualChunks || _ragRawDetached || ragFileMissing) {
        try {
            const _ragCtx      = SillyTavern.getContext();
            const _ragCharName = _ragCtx?.characters?.[_ragCtx?.characterId]?.name ?? '';
            const ragText = _ragRawDetached ? $('#cnz-rag-raw').val() : buildRagDocument(_ragChunks, getSettings(), _ragCharName);
            if (ragText.trim()) {
                newRagFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name);
                newRagUrl      = await uploadRagFile(ragText, newRagFileName);
                _lastRagUrl    = newRagUrl;
                const byteSize = new TextEncoder().encode(ragText).length;
                registerCharacterAttachment(char.avatar, newRagUrl, newRagFileName, byteSize);
                ragChanged = true;
                upsertReceiptItem('cnz-receipt-rag', receiptSuccess(`Narrative Memory saved: "${newRagFileName}" (${_ragChunks.length} chunks)`));
            }
        } catch (err) {
            upsertReceiptItem('cnz-receipt-rag', receiptFailure(`RAG save failed: ${err.message}`));
            abortCommitWithError(`RAG upload failed: ${err.message}`);
            return;
        }
    }

    // ── Step 4: Patch DNA anchor in chat ─────────────────────────────────────
    if (hooksChanged || lorebookChanged || ragChanged) {
        try {
            const liveChain = readDnaChain(SillyTavern.getContext().chat ?? []);
            const lkgRef    = liveChain.lkg ? { anchor: liveChain.lkg, msgIdx: liveChain.lkgMsgIdx } : null;
            if (!lkgRef) {
                console.warn('[CNZ] onConfirmClick: no lkg anchor to patch — skipping DNA update');
            } else {
                const chatMsgs  = SillyTavern.getContext().chat ?? [];
                const anchorMsg = chatMsgs[lkgRef.msgIdx];
                if (!anchorMsg) {
                    console.warn('[CNZ] onConfirmClick: anchor message not found at index', lkgRef.msgIdx);
                } else {
                    const existing      = lkgRef.anchor;
                    const ragHeadersNew = _ragChunks
                        .filter(c => c.status === 'complete' || c.status === 'manual')
                        .map(c => ({ chunkIndex: c.chunkIndex, header: c.header, turnRange: c.turnRange, pairStart: _stagedPairOffset + c.pairStart, pairEnd: _stagedPairOffset + c.pairEnd }));
                    anchorMsg.extra.cnz = Object.assign({}, existing, {
                        hooks:      hooksChanged    ? _priorSituation                                                          : existing.hooks,
                        lorebook:   lorebookChanged ? Object.assign({ name: _lorebookName }, structuredClone(_draftLorebook)) : existing.lorebook,
                        ragUrl:     ragChanged      ? newRagUrl     : existing.ragUrl,
                        ragHeaders: ragChanged      ? ragHeadersNew : existing.ragHeaders,
                    });
                    try {
                        await SillyTavern.getContext().saveChat();
                        upsertReceiptItem('cnz-receipt-anchor', receiptSuccess('DNA anchor updated'));
                    } catch (saveErr) {
                        console.error('[CNZ] onConfirmClick: saveChat failed:', saveErr);
                        upsertReceiptItem('cnz-receipt-anchor', receiptFailure(`DNA anchor save failed: ${saveErr.message} (content saved)`));
                    }
                }
            }
        } catch (err) {
            console.error('[CNZ] DNA anchor update failed:', err);
            upsertReceiptItem('cnz-receipt-anchor', receiptFailure(`DNA anchor update failed: ${err.message} (content saved)`));
            // Non-fatal
        }
    }

    closeModal();
}

/**
 * @section Modal Orchestration
 * @architectural-role Four-Step Wizard Lifecycle
 * @description
 * Owns the four-step review wizard lifecycle. Manages step transitions,
 * panel population, and the Finalize commit sequence that writes only what
 * changed to disk and patches the head anchor. Delegates all content
 * rendering to the three workshop sections. The key invariant is that
 * initWizardSession resets UI state only — engine state is never cleared here.
 * @core-principles
 *   1. initWizardSession resets UI only; engine state (_ragChunks, _draftLorebook, etc.) is preserved.
 *   2. onConfirmClick is the sole disk-write path from the modal — all other steps are staging only.
 * @api-declaration
 *   openReviewModal, initWizardSession, updateWizard, onConfirmClick,
 *   closeModal, injectModal
 * @contract
 *   assertions:
 *     external_io: [/api/worldinfo/*, /api/characters/edit, /api/files/upload, /api/files/delete, /api/chats/saveChat]
 */
// ─── Modal: Orchestration ─────────────────────────────────────────────────────

function injectModal() {
    if ($('#cnz-overlay').length) return;
    $('body').append(buildModalHTML());
    $('body').append(buildPromptModalHTML());
    $('body').append(buildDnaChainInspectorHTML());
    $('body').append(buildOrphanModalHTML());

    // Step 1 — Hooks Workshop
    $('#cnz-modal').on('click', '#cnz-hooks-tab-bar .cnz-tab-btn', function () {
        onHooksTabSwitch($(this).data('tab'));
    });
    $('#cnz-modal').on('input', '#cnz-situation-text', updateHooksDiff);
    $('#cnz-hooks-revert-old').on('click', () => {
        $('#cnz-situation-text').val(_beforeSituation);
        updateHooksDiff();
    });
    $('#cnz-hooks-revert-new').on('click', () => {
        $('#cnz-situation-text').val(_priorSituation);
        updateHooksDiff();
    });
    $('#cnz-regen-hooks').on('click', onRegenHooksClick);

    // Step 2 — Lorebook Workshop
    $('#cnz-lb-freeform-regen').on('click',       onLbRegenClick);
    $('#cnz-lb-suggestion-select').on('change',   onLbSuggestionSelectChange);
    $('#cnz-lb-editor-name').on('input',          onLbIngesterEditorInput);
    $('#cnz-lb-editor-keys').on('input',          onLbIngesterEditorInput);
    $('#cnz-lb-editor-content').on('input',       onLbIngesterEditorInput);
    $('#cnz-lb-ingester-next').on('click',        onLbIngesterNext);
    $('#cnz-lb-btn-latest').on('click',           onLbIngesterLoadLatest);
    $('#cnz-lb-btn-prev').on('click',             onLbIngesterLoadPrev);
    $('#cnz-lb-btn-regen').on('click',            onLbIngesterRegenerate);
    $('#cnz-lb-reject-one').on('click',           onLbIngesterReject);
    $('#cnz-lb-apply-one').on('click',            onLbIngesterApply);
    $('#cnz-lb-delete-one').on('click',           () => deleteLbEntry(_lbActiveIngesterIndex));
    $('#cnz-lb-apply-all-unresolved').on('click', onLbApplyAllUnresolved);
    $('#cnz-modal').on('click', '#cnz-lb-tab-bar .cnz-tab-btn', function () {
        onLbTabSwitch($(this).data('tab'));
    });
    // Lane 3 — selecting an existing lorebook entry loads it into the shared editor.
    // If the entry is already in Lane 1, sync the dropdowns; otherwise add it as a new suggestion.
    $('#cnz-modal').on('change', '#cnz-targeted-entry-select', function () {
        const uid = $(this).val();
        if (!uid) return;

        const entry = _draftLorebook?.entries?.[uid];
        if (!entry) return;

        const uidNum      = parseInt(uid, 10);
        const existingIdx = _lorebookSuggestions.findIndex(s => s.linkedUid === uidNum);

        if (existingIdx !== -1) {
            // Entry already tracked in Lane 1 — sync the dropdowns
            _lbActiveIngesterIndex = existingIdx;
            $('#cnz-lb-suggestion-select').val(existingIdx);
            renderLbIngesterDetail(_lorebookSuggestions[existingIdx]);
        } else {
            // Not yet tracked — add it as an UPDATE suggestion
            const name    = entry.comment || String(entry.uid ?? uid);
            const keys    = Array.isArray(entry.key) ? [...entry.key] : [];
            const content = entry.content ?? '';
            const newSuggestion = {
                type:        'UPDATE',
                name,
                keys,
                content,
                linkedUid:   uidNum,
                _applied:    true,
                _rejected:   false,
                _deleted:    false,
                _aiSnapshot: { name, keys: [...keys], content },
            };
            _lorebookSuggestions.push(newSuggestion);
            _lbActiveIngesterIndex = _lorebookSuggestions.length - 1;
            populateLbIngesterDropdown();
            renderLbIngesterDetail(newSuggestion);
            syncFreeformFromSuggestions();
        }
    });
    $('#cnz-modal').on('click', '#cnz-targeted-generate', onTargetedGenerateClick);

    // Step 3 — Narrative Memory Workshop
    $('#cnz-modal').on('click', '#cnz-rag-tab-bar .cnz-tab-btn', function () {
        onRagTabSwitch($(this).data('tab'));
    });
    $('#cnz-modal').on('input', '.cnz-rag-card-header', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        autoResizeRagCardHeader(this);
        if (!isNaN(idx) && _ragChunks[idx]) {
            _ragChunks[idx].header = $(this).val();
            _ragChunks[idx].status = 'manual';
            $(`.cnz-rag-card[data-chunk-index="${idx}"]`).attr('data-status', 'manual');
        }
    });
    $('#cnz-modal').on('click', '.cnz-rag-card-regen', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        if (!isNaN(idx)) ragRegenCard(idx);
    });
    $('#cnz-rag-raw').on('input', onRagRawInput);
    $('#cnz-rag-revert-raw-btn').on('click', onRagRevertRaw);

    // Shared wizard footer
    $('#cnz-cancel').on('click',    closeModal);
    $('#cnz-move-back').on('click', () => updateWizard(_currentStep - 1));
    $('#cnz-move-next').on('click', () => updateWizard(_currentStep + 1));
    $('#cnz-confirm').on('click',   onConfirmClick);
}

function showModal() {
    $('#cnz-overlay').removeClass('cnz-hidden');
}

/**
 * Hides the modal overlay and resets modal session state.
 * Must NOT clear engine state (`_ragChunks`, `_lorebookSuggestions`, `_priorSituation`, etc.).
 */
/**
 * Lane 2 — Generate: fires a targeted NEW-entry AI call for the supplied keyword.
 * The result is added as a new suggestion and loaded into the shared editor.
 */
function onTargetedGenerateClick() {
    const keyword = $('#cnz-targeted-keyword').val().trim();
    if (!keyword) {
        $('#cnz-targeted-error').text('Enter a concept name.').removeClass('cnz-hidden');
        return;
    }
    $('#cnz-targeted-error').addClass('cnz-hidden').text('');

    const horizon     = getSettings().hookseekerHorizon ?? 40;
    const upToLatest  = $('#cnz-lb-up-to-latest').is(':checked');
    const tgtMessages = SillyTavern.getContext().chat ?? [];
    const tgtSettings = getSettings();
    const transcript  = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon, tgtMessages, tgtSettings);

    $('#cnz-targeted-spinner').removeClass('cnz-hidden');
    $('#cnz-targeted-generate').prop('disabled', true);

    runTargetedLbCall('new', keyword, '', '', transcript)
        .then(rawText => {
            const trimmed = rawText?.trim() ?? '';
            if (!trimmed || trimmed === 'NO INFORMATION FOUND') {
                $('#cnz-targeted-error')
                    .text(trimmed || 'AI returned no output.')
                    .removeClass('cnz-hidden');
                return;
            }

            const parsed = parseLbSuggestions(trimmed);
            if (!parsed.length) {
                $('#cnz-targeted-error').text('Could not parse AI response.').removeClass('cnz-hidden');
                return;
            }

            const fresh = parsed[0];
            const newSuggestion = {
                type:        fresh.type || 'NEW',
                name:        fresh.name || keyword,
                keys:        fresh.keys,
                content:     fresh.content,
                linkedUid:   null,
                _applied:    false,
                _rejected:   false,
                _deleted:    false,
                _aiSnapshot: { name: fresh.name || keyword, keys: [...fresh.keys], content: fresh.content },
            };

            _lorebookSuggestions.push(newSuggestion);
            _lbActiveIngesterIndex = _lorebookSuggestions.length - 1;
            populateLbIngesterDropdown();
            renderLbIngesterDetail(newSuggestion);
            syncFreeformFromSuggestions();

            toastr.success('CNZ: New entry generated — review in editor.');
        })
        .catch(err => {
            $('#cnz-targeted-error').text(`Generate failed: ${err.message}`).removeClass('cnz-hidden');
        })
        .finally(() => {
            $('#cnz-targeted-spinner').addClass('cnz-hidden');
            $('#cnz-targeted-generate').prop('disabled', false);
        });
}

function closeModal() {
    $('#cnz-overlay').addClass('cnz-hidden');
    invalidateAllJobs();   // invalidates all in-flight bus jobs (genId replacement)
    // Reset modal UI state only (engine state must not be cleared here)
    _hooksLoading               = false;
    _lorebookLoading            = false;
    _lbActiveIngesterIndex      = 0;
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer            = null;
    _ragRawDetached             = false;
    _currentStep                = 1;
    _modalOpenHeadUuid          = null;
}

// ─── DNA Chain Inspector ───────────────────────────────────────────────────────

function closeDnaChainInspector() {
    $('#cnz-li-overlay').addClass('cnz-hidden');
}

// ─── Orphan Review Modal ───────────────────────────────────────────────────────

function closeOrphanModal() {
    $('#cnz-orphan-overlay').addClass('cnz-hidden');
}

/**
 * Opens the Orphan Review modal for a given list of orphaned file paths.
 * Each row shows the filename, a [Preview] toggle, and a [Delete] button.
 * A [Delete All] button at the footer deletes all remaining files at once.
 * @param {string[]} orphans  Client-relative paths of unreferenced files.
 */
function openOrphanModal(orphans) {
    const $overlay = $('#cnz-orphan-overlay');
    const $body    = $('#cnz-orphan-body');
    const $footer  = $overlay.find('.cnz-orphan-footer');

    $body.empty();
    $footer.show();

    if (!orphans.length) {
        $body.append('<div class="cnz-li-empty">No orphaned files found.</div>');
        $footer.hide();
        $overlay.removeClass('cnz-hidden');
        return;
    }

    $('#cnz-orphan-title').text(`Orphaned Files — ${orphans.length} file${orphans.length !== 1 ? 's' : ''}`);

    function checkResolved() {
        if ($body.find('.cnz-orphan-row').length === 0) {
            $body.html('<div class="cnz-li-empty">All orphaned files resolved.</div>');
            $footer.hide();
        }
    }

    orphans.forEach(path => {
        const filename = path.split('/').pop();
        const $row = $(`
<div class="cnz-orphan-row" data-path="${escapeHtml(path)}">
  <div class="cnz-orphan-row-header">
    <span class="cnz-orphan-filename">${escapeHtml(filename)}</span>
    <button class="cnz-orphan-preview-btn cnz-btn cnz-btn-secondary cnz-btn-sm">Preview</button>
    <button class="cnz-orphan-delete-btn cnz-btn cnz-btn-danger cnz-btn-sm">Delete</button>
  </div>
  <div class="cnz-orphan-preview-panel cnz-hidden"></div>
</div>`);

        // Preview toggle
        $row.find('.cnz-orphan-preview-btn').on('click', async function () {
            const $panel = $row.find('.cnz-orphan-preview-panel');
            if (!$panel.hasClass('cnz-hidden')) {
                $panel.addClass('cnz-hidden');
                $(this).text('Preview');
                return;
            }
            $(this).text('Loading…').prop('disabled', true);
            try {
                const res  = await fetch(path);
                const text = res.ok ? await res.text() : `(fetch failed: HTTP ${res.status})`;
                $panel.text(text);
            } catch (err) {
                $panel.text(`(fetch error: ${err.message})`);
            }
            $panel.removeClass('cnz-hidden');
            $(this).text('Collapse').prop('disabled', false);
        });

        // Delete single row
        $row.find('.cnz-orphan-delete-btn').on('click', async function () {
            $(this).prop('disabled', true);
            await cnzDeleteFile(path);
            $row.remove();
            checkResolved();
        });

        $body.append($row);
    });

    // Delete All
    $('#cnz-orphan-delete-all').off('click.orphan').on('click.orphan', async function () {
        $(this).prop('disabled', true);
        const paths = $body.find('.cnz-orphan-row').map((_, el) => $(el).data('path')).get();
        for (const p of paths) { await cnzDeleteFile(p); }
        $body.find('.cnz-orphan-row').remove();
        checkResolved();
    });

    // Close handlers
    $('#cnz-orphan-close').off('click.orphan').on('click.orphan', closeOrphanModal);
    $overlay.off('click.orphan').on('click.orphan', closeOrphanModal);
    $('#cnz-orphan-modal').off('click.orphan').on('click.orphan', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');
}

/**
 * Opens the DNA Chain Inspector modal for the current character.
 * Sections: uncommitted pair count, RAG file health, anchor list (HEAD first).
 * RAG file status is verified live against the server via /api/files/verify.
 */
async function openDnaChainInspector() {
    const ctx      = SillyTavern.getContext();
    const char     = ctx?.characters?.[ctx?.characterId];
    const messages = ctx?.chat ?? [];
    const chain    = readDnaChain(messages);

    const $overlay = $('#cnz-li-overlay');
    const $title   = $('#cnz-li-title');
    const $body    = $('#cnz-li-body');

    $title.text(`DNA Chain — ${char?.name ?? 'Unknown'}`);
    $body.empty();

    // Wire close handlers
    $('#cnz-li-close').off('click.li').on('click.li', closeDnaChainInspector);
    $overlay.off('click.li').on('click.li', closeDnaChainInspector);
    $('#cnz-li-modal').off('click.li').on('click.li', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');

    // ── Section 1: Uncommitted pairs ──────────────────────────────────────────
    const afterAnchor = chain.lkgMsgIdx >= 0 ? messages.slice(chain.lkgMsgIdx + 1) : messages;
    const uncommitted = afterAnchor.filter(m => !m.is_system && m.is_user).length;
    const pairWord    = uncommitted === 1 ? 'pair' : 'pairs';
    $body.append(`<div class="cnz-li-summary">${uncommitted} uncommitted ${pairWord} since last update</div>`);

    // ── Section 2: RAG coverage map ───────────────────────────────────────────
    // Shows each anchor in chronological order with its RAG file status.
    // verifiedOnDisk is reused by the Section 3 anchor expand handler.
    $body.append('<div class="cnz-li-section-label">Narrative Memory</div>');

    const verifiedOnDisk = new Set();

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-rag-row"><span class="cnz-li-rag-name cnz-li-status-muted">No syncs committed yet.</span></div>');
    } else {
        // Verify all URLs referenced by anchors plus the attachment registry in one call.
        const attachments = extension_settings.character_attachments?.[char?.avatar] ?? [];
        const anchorUrls  = chain.anchors.map(({ anchor }) => anchor.ragUrl).filter(Boolean);
        const allUrls     = [...new Set([...anchorUrls, ...attachments.map(a => a.url)])];

        if (allUrls.length > 0) {
            try {
                const res = await fetch('/api/files/verify', {
                    method:  'POST',
                    headers: getRequestHeaders(),
                    body:    JSON.stringify({ urls: allUrls }),
                });
                if (res.ok) {
                    const verified = await res.json();
                    for (const [url, exists] of Object.entries(verified)) {
                        if (exists) verifiedOnDisk.add(url);
                    }
                }
            } catch (err) {
                console.warn('[CNZ] openDnaChainInspector: RAG verify failed:', err);
            }
        }

        // Render one row per anchor, oldest first.
        // firstSeenLabel tracks the label of the anchor that first introduced each ragUrl,
        // so repeated files show "(same as #N)" instead of just "(same)".
        const total         = chain.anchors.length;
        const firstSeenLabel = new Map(); // ragUrl → label string

        for (let i = 0; i < chain.anchors.length; i++) {
            const { anchor }  = chain.anchors[i];
            const label       = i === total - 1 ? 'HEAD' : `#${i + 1}`;
            const shortUuid   = anchor.uuid?.slice(0, 8) ?? '—';
            const labelText   = `${label}  ${shortUuid}`;

            let statusCls, statusChr, nameHtml;
            if (!anchor.ragUrl) {
                statusCls = 'cnz-li-status-warn';
                statusChr = '⚠';
                nameHtml  = '<span class="cnz-li-rag-name cnz-li-status-muted">no file</span>';
            } else {
                const onDisk = verifiedOnDisk.has(anchor.ragUrl);
                statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                statusChr = onDisk ? '✓' : '✗';
                if (firstSeenLabel.has(anchor.ragUrl)) {
                    const ref = escapeHtml(firstSeenLabel.get(anchor.ragUrl));
                    nameHtml = `<span class="cnz-li-rag-name cnz-li-status-muted">(same as ${ref})</span>`;
                } else {
                    firstSeenLabel.set(anchor.ragUrl, label);
                    const fileName = escapeHtml(anchor.ragUrl.split('/').pop());
                    nameHtml = `<span class="cnz-li-rag-name">${fileName}</span>`;
                }
            }

            $body.append(`<div class="cnz-li-rag-row">
                <span class="cnz-li-rag-label">${escapeHtml(labelText)}</span>
                <span class="cnz-li-rag-status ${statusCls}">${statusChr}</span>
                ${nameHtml}
            </div>`);
        }
    }

    // ── Section 3: Anchor list ────────────────────────────────────────────────
    $body.append('<div class="cnz-li-section-label">Sync History</div>');

    if (chain.anchors.length === 0) {
        $body.append('<div class="cnz-li-empty">No syncs committed yet.</div>');
        return;
    }

    const total   = chain.anchors.length;
    const reversed = [...chain.anchors].reverse(); // HEAD first

    for (let i = 0; i < reversed.length; i++) {
        const { anchor } = reversed[i];
        const label     = i === 0 ? 'HEAD' : `#${total - i}`;
        const shortUuid = anchor.uuid?.slice(0, 8) ?? '—';
        const entries   = Object.keys(anchor.lorebook?.entries ?? {}).length;
        const chunks    = anchor.ragHeaders?.length ?? 0;
        const dateStr   = anchor.committedAt ? anchor.committedAt.slice(0, 16).replace('T', ' ') : '—';
        const summary   = `${label}  ${shortUuid}  ${entries} ${entries === 1 ? 'entry' : 'entries'}  ${chunks} ${chunks === 1 ? 'chunk' : 'chunks'}  ${dateStr}`;

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
                const lbName  = escapeHtml(anchor.lorebook?.name ?? '—');
                let ragFileHtml;
                if (!anchor.ragUrl) {
                    ragFileHtml = '<span class="cnz-li-status-muted">none</span>';
                } else {
                    const fileName  = escapeHtml(anchor.ragUrl.split('/').pop());
                    const onDisk    = verifiedOnDisk.has(anchor.ragUrl);
                    const statusCls = onDisk ? 'cnz-li-status-ok' : 'cnz-li-status-warn';
                    const statusChr = onDisk ? '✓' : '✗';
                    ragFileHtml = `<span class="${statusCls}">${statusChr}</span> ${fileName}`;
                }
                $nodeBody.html(`
                    <div class="cnz-li-field"><span class="cnz-li-field-label">UUID: </span>${escapeHtml(anchor.uuid ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Parent: </span>${escapeHtml(anchor.parentUuid ?? 'root')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Committed: </span>${escapeHtml(anchor.committedAt ?? '—')}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">Lorebook: </span>${lbName}</div>
                    <div class="cnz-li-field"><span class="cnz-li-field-label">RAG file: </span>${ragFileHtml}</div>
                    <div class="cnz-li-field cnz-li-hooks-block">
                        <span class="cnz-li-field-label">Hooks:</span>
                        <div class="cnz-li-hooks-preview">${escapeHtml(anchor.hooks || '(none)')}</div>
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


/**
 * Resets wizard UI to its initial state (tab selection, error panels, loading spinners).
 * Must NOT touch engine state. Pass `preserveSuggestions = true` from `openReviewModal`
 * to retain lorebook suggestions and raw text populated by the last sync.
 * @param {boolean} [preserveSuggestions=false]
 */
function initWizardSession(preserveSuggestions = false) {
    // Hooks Workshop reset
    $('#cnz-hooks-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'workshop');
    });
    $('#cnz-hooks-tab-workshop').removeClass('cnz-hidden');
    $('#cnz-hooks-tab-new, #cnz-hooks-tab-old').addClass('cnz-hidden');
    $('#cnz-hooks-diff').empty();
    // Lorebook tab reset — Ingester is the default landing tab
    $('#cnz-lb-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'ingester');
    });
    $('#cnz-lb-tab-ingester').removeClass('cnz-hidden');
    $('#cnz-lb-tab-freeform').addClass('cnz-hidden');
    // Lane 2/3 reset
    $('#cnz-targeted-entry-select').empty().append('<option value="">— Select entry —</option>');
    $('#cnz-targeted-keyword').val('');
    $('#cnz-targeted-spinner').addClass('cnz-hidden');
    $('#cnz-targeted-error').addClass('cnz-hidden').text('');
    $('#cnz-targeted-generate').prop('disabled', false);
    populateTargetedEntrySelect();
    // Lorebook and general reset
    $('#cnz-lb-title').text(`Lorebook: ${_lorebookName}`);
    $('#cnz-lb-freeform').val('');
    $('#cnz-lb-error').addClass('cnz-hidden').text('');
    $('#cnz-lb-error-ingester').addClass('cnz-hidden').text('');
    $('#cnz-error-1').addClass('cnz-hidden').text('');
    $('#cnz-error-4').addClass('cnz-hidden').text('');
    $('#cnz-receipts').addClass('cnz-hidden');
    $('#cnz-receipts-content').empty();
    $('#cnz-recovery-guide').addClass('cnz-hidden');
    $('#cnz-cancel').text('Cancel').prop('disabled', false);
    $('#cnz-confirm').prop('disabled', false);
    // RAG Workshop reset
    $('#cnz-rag-cards').empty();
    $('#cnz-rag-no-summary, #cnz-rag-disabled').addClass('cnz-hidden');
    $('#cnz-rag-detached-warn, #cnz-rag-detached-revert').addClass('cnz-hidden');
    $('#cnz-rag-raw').val('').removeClass('cnz-rag-detached');
    $('#cnz-rag-raw-detached-label').addClass('cnz-hidden');
    $('#cnz-rag-tab-bar .cnz-tab-btn').each(function () {
        $(this).toggleClass('cnz-tab-active', $(this).data('tab') === 'sectioned');
    });
    $('#cnz-rag-tab-sectioned').removeClass('cnz-hidden');
    $('#cnz-rag-tab-raw').addClass('cnz-hidden');
    // Lorebook ingester reset (engine state _lorebookSuggestions must NOT be cleared here)
    if (!preserveSuggestions) {
        _lbActiveIngesterIndex = 0;
    }
    setHooksLoading(false);
    setLbLoading(false);
}

/**
 * Shows the given wizard step (1–4), hides all others, and updates footer
 * button visibility. Triggers workshop population on step entry.
 */
function updateWizard(n) {
    if (_currentStep === 3 && n < 3) onLeaveRagWorkshop();
    _currentStep = n;
    for (let i = 1; i <= 4; i++) {
        $(`#cnz-step-${i}`).toggleClass('cnz-hidden', i !== n);
    }
    $('#cnz-move-back').toggleClass('cnz-hidden', n === 1);
    $('#cnz-move-next').toggleClass('cnz-hidden', n === 4);
    $('#cnz-confirm').toggleClass('cnz-hidden',   n !== 4);
    if (n === 3) onEnterRagWorkshop();
    if (n === 4) populateStep4Summary();
}

/**
 * Opens the CNZ review modal. Loads committed hooks from character scenario,
 * ensures lorebook and DNA chain are loaded, then shows Step 1.
 * Called from the sync toast "Review" link.
 */
async function openReviewModal() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    // Ensure lorebook is loaded
    const lbName = getSettings().lorebookName || char.name;
    if (_lorebookName !== lbName || !_lorebookData) {
        try {
            _lorebookName  = lbName;
            _lorebookData  = await lbEnsureLorebook(_lorebookName);
            _draftLorebook = structuredClone(_lorebookData);
        } catch (err) {
            console.error('[CNZ] openReviewModal: lorebook load failed:', err);
            _lorebookData  = { entries: {} };
            _draftLorebook = { entries: {} };
        }
    }

    // Read current hooks from the CNZ Summary prompt (source of truth after a sync).
    // Fall back to the head anchor's hooks field if the prompt is unavailable or stale.
    const _pm          = getCnzPromptManager();
    const _cnzPrompt   = _pm?.getPromptById(CNZ_SUMMARY_ID);
    _priorSituation    = (_cnzPrompt && _cnzPrompt.cnz_avatar === char.avatar)
        ? (_cnzPrompt.content ?? '')
        : '';

    // Derive before/after states from DNA chain — no network fetches needed.
    _dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(_dnaChain);
    const headRef   = _dnaChain.lkg ? { anchor: _dnaChain.lkg, msgIdx: _dnaChain.lkgMsgIdx } : null;
    const parentRef = headRef ? (_dnaChain.anchors[_dnaChain.anchors.length - 2] ?? null) : null;

    if (headRef) {
        _lorebookData  = structuredClone(headRef.anchor.lorebook ?? { entries: {} });
        _draftLorebook = structuredClone(_lorebookData);
        _lorebookName  = headRef.anchor.lorebook?.name || _lorebookName;

        // Restore RAG state from the last committed anchor when no sync has run this session.
        // Guard: if _stagedProsePairs is already populated, a sync is in progress — leave it alone.
        if (_ragChunks.length === 0 && _stagedProsePairs.length === 0) {
            const messages  = SillyTavern.getContext().chat ?? [];
            const allPairs  = buildProsePairs(messages);
            const { pairs, pairOffset } = deriveLastCommittedPairs(allPairs, messages, _dnaChain);
            if (pairs.length > 0) {
                _stagedProsePairs = pairs;
                _stagedPairOffset = pairOffset;
                _splitPairIdx     = pairs.length;
                _ragChunks        = buildRagChunks(pairs, pairOffset, getSettings());

                // Apply stored headers — chunks not present in the anchor stay 'pending' for auto-regen.
                const headerMap = new Map((headRef.anchor.ragHeaders ?? []).map(h => [h.chunkIndex, h]));
                for (const chunk of _ragChunks) {
                    const stored = headerMap.get(chunk.chunkIndex);
                    if (stored?.header) {
                        chunk.header = stored.header;
                        chunk.status = 'complete';
                    }
                }
            }
        }
    }

    if (parentRef) {
        _beforeSituation    = parentRef.anchor.hooks ?? '';
        _parentNodeLorebook = parentRef.anchor.lorebook ?? null;
    } else {
        _beforeSituation    = '';
        _parentNodeLorebook = null;
    }

    _lorebookSuggestions = headRef ? deriveSuggestionsFromAnchorDiff(_parentNodeLorebook, _draftLorebook) : [];
    _modalOpenHeadUuid   = headRef?.anchor?.uuid ?? null;

    // Link lorebook to character if not already set.
    const charForLink = char;
    if (_lorebookName && charForLink?.data?.extensions?.world !== _lorebookName) {
        patchCharacterWorld(charForLink, _lorebookName).catch(e =>
            console.error('[CNZ] openReviewModal: lorebook link failed:', e.message ?? e),
        );
    }

    initWizardSession(true);

    // Populate panels before showModal()
    $('#cnz-situation-text').val(_priorSituation);
    $('#cnz-hooks-new-display').text(_priorSituation);
    $('#cnz-hooks-old-display').text(_beforeSituation);
    updateHooksDiff();
    $('#cnz-lb-freeform').val(serialiseSuggestionsToFreeform(_lorebookSuggestions));
    if (_lorebookSuggestions.length) {
        populateLbIngesterDropdown();
        renderLbIngesterDetail(_lorebookSuggestions[0]);
    }

    showModal();
    updateWizard(1);
    emit(BUS_EVENTS.MODAL_OPENED, {});
}


function logSyncStart(hookPairs, lbPairs, ragPairs, coverAll, chunkEveryN) {
    const fmt = pairs => pairs.length > 0
        ? `turns ${pairs[0].validIdx + 1}–${pairs[pairs.length - 1].validIdx + 1} (${pairs.length} pairs)`
        : '(none)';
    const lbLabel = lbPairs === hookPairs ? `${fmt(lbPairs)} [same as hookseeker]` : fmt(lbPairs);
    console.log(
        `[CNZ] ── SYNC START ── coverAll=${coverAll} window=${chunkEveryN}\n` +
        `  hookseeker: ${fmt(hookPairs)}\n` +
        `  lorebook:   ${lbLabel}\n` +
        `  rag:        ${fmt(ragPairs)}`
    );
}


// ─── CNZ Core ────────────────────────────────────────────────────────────────

/**
 * Parses raw lorebook AI output and applies all suggestions to _draftLorebook,
 * then saves to disk. Silent — no modal interaction.
 * @param {string} rawText  Raw AI output from runLorebookSyncCall.
 * @returns {Promise<void>}
 */
async function processLorebookUpdate(rawText) {
    if (!rawText.trim() || rawText.trim() === 'NO CHANGES NEEDED') return;
    const suggestions = parseLbSuggestions(rawText);
    _lorebookSuggestions = enrichLbSuggestions(suggestions);
    for (const s of _lorebookSuggestions) {
        if (s.linkedUid !== null) {
            const entry = _draftLorebook?.entries?.[String(s.linkedUid)];
            if (entry) {
                if (s.comment  !== undefined) entry.comment = s.comment;
                if (s.keys     !== undefined) entry.key     = s.keys;
                if (s.content  !== undefined) entry.content = s.content;
            }
        } else {
            const uid = nextLorebookUid();
            _draftLorebook.entries[String(uid)] = makeLbDraftEntry(uid, s.name, s.keys, s.content);
            s.linkedUid = uid;
        }
        s._applied = false;
    }
    await lbSaveLorebook(_lorebookName, _draftLorebook);
    _lorebookData = structuredClone(_draftLorebook);
}

/**
 * IO Executor. Writes new hookseeker text into the CNZ Summary prompt.
 * Anchor UUID is null at this point — stamped after commitDnaAnchor.
 * @param {string} hooksText  Raw hookseeker output.
 */
function processHooksUpdate(hooksText) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');
    writeCnzSummaryPrompt(char.avatar, hooksText.trim(), null);
}

/**
 * Builds RAG chunks for the current sync window, classifies them, uploads the
 * RAG document, and registers it as a character attachment.
 *
 * Expects _stagedProsePairs and _stagedPairOffset to have been set by the caller
 * (runCnzSync) before this function is invoked. The surgical-unlock fallback below
 * guards against direct calls outside that context only.
 *
 * @returns {Promise<void>}
 */
async function runRagPipeline() {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    if (!char) throw new Error('No character selected');

    const messages = ctx.chat ?? [];
    const allPairs = buildProsePairs(messages);

    // Surgical unlock: guard against direct calls where staged pairs were not set.
    if (_stagedProsePairs.length === 0 && allPairs.length > 0) {
        _stagedProsePairs = [allPairs[allPairs.length - 1]];
        const firstValidIdx = _stagedProsePairs[0].validIdx;
        const foundIdx      = allPairs.findIndex(p => p.validIdx >= firstValidIdx);
        _stagedPairOffset   = foundIdx === -1 ? 0 : foundIdx;
    }

    _splitPairIdx           = _stagedProsePairs.length;
    const ragSettings = getSettings();
    _ragChunks              = buildRagChunks(_stagedProsePairs, _stagedPairOffset, ragSettings);

    hydrateChunkHeadersFromChat();
    setCurrentSettings(ragSettings);
    dispatchContract('rag_classifier', {
        ragChunks:        _ragChunks,
        fullPairs:        allPairs,
        stagedPairs:      _stagedProsePairs,
        stagedPairOffset: _stagedPairOffset,
        splitPairIdx:     _splitPairIdx,
        scenario_hooks:   '',
    }, ragSettings);
    await waitForRagChunks(120_000);

    const ctx2      = SillyTavern.getContext();
    const charName2 = ctx2?.characters?.[ctx2?.characterId]?.name ?? '';
    const ragText   = buildRagDocument(_ragChunks, getSettings(), charName2);
    if (!ragText.trim()) return;

    const charName   = char.name;
    const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), charName);
    _lastRagUrl      = await uploadRagFile(ragText, ragFileName);

    const byteSize = new TextEncoder().encode(ragText).length;
    registerCharacterAttachment(char.avatar, _lastRagUrl, ragFileName, byteSize);
}

/**
 * Commits the current sync cycle to the DNA chain by writing a CnzAnchor
 * onto the last pair of the sync window.
 * @param {object}   char      Character object from ST context.
 * @param {object[]} messages  Full chat message array.
 * @returns {Promise<void>}
 */
async function commitDnaAnchor(messages) {
    if (_stagedProsePairs.length === 0) {
        console.warn('[CNZ] commitDnaAnchor: no staged pairs — skipping anchor write');
        return;
    }

    const anchorPairIdx = _stagedProsePairs.length - 1;
    const anchorPair   = _stagedProsePairs[anchorPairIdx];

    const lkg        = getLkgAnchor(messages);
    const parentUuid = lkg?.anchor?.uuid ?? null;

    const ragHeaders = _ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({ chunkIndex: c.chunkIndex, header: c.header, turnRange: c.turnRange, pairStart: _stagedPairOffset + c.pairStart, pairEnd: _stagedPairOffset + c.pairEnd }));

    const anchor = buildAnchorPayload({
        uuid:        crypto.randomUUID(),
        committedAt: new Date().toISOString(),
        hooks:       _priorSituation,
        lorebook:    Object.assign({ name: _lorebookName }, structuredClone(_draftLorebook ?? { entries: {} })),
        ragUrl:      _lastRagUrl || null,
        ragHeaders,
        parentUuid,
    });

    await writeDnaAnchor(anchorPair, anchor);
    await writeDnaLinks(_stagedProsePairs, anchorPairIdx, anchor.uuid, _stagedPairOffset);

    _dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(_dnaChain);
    console.log('[CNZ] commitDnaAnchor: anchor written uuid=' + anchor.uuid + ' pairs=' + _stagedProsePairs.length);
}

/**
 * Computes the pair slice for a sync cycle, anchored to the DNA chain head.
 *
 * Standard mode: first chunkEveryN uncommitted pairs after the LKG anchor.
 * CoverAll mode: all uncommitted pairs from the LKG anchor to the live context
 *                buffer boundary.
 *
 * "Uncommitted" means validIdx >= priorSeq (after the LKG anchor) AND
 * validIdx < tbb (before the live context buffer).
 *
 * Pure function — all inputs passed explicitly. No module state reads.
 *
 * @param {object[]} allPairs   Full pair array from buildProsePairs(messages).
 * @param {object[]} messages   Full chat message array.
 * @param {object}   settings   Active profile settings.
 * @param {boolean}  coverAll   true = full gap, false = standard window.
 * @param {object}   dnaChain   Current _dnaChain value (may be null).
 * @returns {{ syncPairs: object[], syncPairOffset: number }}
 */
function computeSyncWindow(allPairs, messages, settings, coverAll, dnaChain) {
    const lcb   = settings.liveContextBuffer ?? 5;
    const every = settings.chunkEveryN ?? 20;
    const tbb   = Math.max(0, allPairs.length - lcb);   // trailing buffer boundary in pairs

    // Non-system turns committed up to and including the LKG anchor message.
    const lkgIdx   = dnaChain?.lkgMsgIdx ?? -1;
    const priorSeq = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system).length
        : 0;

    // Pairs that lie in the uncommitted gap (after committed boundary, before live buffer).
    const uncommitted = allPairs.filter((p, i) => p.validIdx >= priorSeq && i < tbb);

    const syncPairs = coverAll ? uncommitted : uncommitted.slice(0, every);

    const firstPair      = syncPairs[0];
    const syncPairOffset = firstPair ? allPairs.indexOf(firstPair) : 0;

    return { syncPairs, syncPairOffset };
}

/**
 * Derives the prose-pair slice that was committed in the most recent sync cycle.
 * Inverse of computeSyncWindow — returns the pairs between the parent anchor and
 * the head anchor rather than the uncommitted pairs after the head.
 * Pure function — no module state reads.
 *
 * @param {object[]} allPairs   Full pair array from buildProsePairs(messages).
 * @param {object[]} messages   Full chat message array.
 * @param {object}   dnaChain   Current _dnaChain value (may be null).
 * @returns {{ pairs: object[], pairOffset: number }}
 */
function deriveLastCommittedPairs(allPairs, messages, dnaChain) {
    const anchors = dnaChain?.anchors ?? [];
    if (anchors.length === 0) return { pairs: [], pairOffset: 0 };

    const headRef   = anchors[anchors.length - 1];
    const parentRef = anchors.length >= 2 ? anchors[anchors.length - 2] : null;

    const headPriorSeq   = messages.slice(0, headRef.msgIdx + 1).filter(m => !m.is_system).length;
    const parentPriorSeq = parentRef
        ? messages.slice(0, parentRef.msgIdx + 1).filter(m => !m.is_system).length
        : 0;

    const pairs      = allPairs.filter(p => p.validIdx >= parentPriorSeq && p.validIdx < headPriorSeq);
    const pairOffset = pairs.length > 0 ? allPairs.indexOf(pairs[0]) : 0;

    return { pairs, pairOffset };
}

/**
 * Fires every chunkEveryN turns (MESSAGE_RECEIVED handler).
 * Executes the full background sync pipeline:
 *   1. Compute the sync window anchored to the DNA chain head.
 *   2. Fire Lorebook + Hookseeker in parallel (each with its own transcript).
 *   3. Apply lorebook updates silently.
 *   4. Write Hookseeker output into the character scenario anchor block.
 *   5. Build, classify, and upload RAG chunks as a character attachment.
 *   6. Commit a DNA chain node recording this milestone.
 *
 * Each step is guarded individually; a failure emits a warning toast but
 * does not abort subsequent steps or throw to the caller.
 *
 * @param {object} char     Character object from ST context at trigger time.
 * @param {Array}  messages Full chat message array at trigger time.
 * @param {boolean} coverAll true = full gap, false = standard window.
 */
async function runCnzSync(char, messages, { coverAll = false } = {}) {
    console.log(`[CNZ] ══ SYNC START ══ char="${char?.name}" coverAll=${coverAll} msgs=${messages.length}`);
    setSyncInProgress(true);
    const settings  = getSettings();
    const allPairs  = buildProsePairs(messages);
    const { syncPairs, syncPairOffset } = computeSyncWindow(allPairs, messages, settings, coverAll, _dnaChain);

    if (syncPairs.length === 0) {
        console.warn('[CNZ] runCnzSync: no uncommitted pairs in window — aborting');
        setSyncInProgress(false);
        return;
    }

    // Stage pairs so commitDnaAnchor and runRagPipeline both land on the right range.
    _stagedProsePairs = syncPairs;
    _stagedPairOffset = syncPairOffset;

    // Hookseeker transcript: sync pairs plus lookback into committed turns for continuity.
    const horizon       = settings.hookseekerHorizon ?? 40;
    const lookbackStart = Math.max(0, syncPairOffset - (horizon - syncPairs.length));
    const hookPairs     = allPairs.slice(lookbackStart, syncPairOffset + syncPairs.length);
    const hookMsgs      = hookPairs.flatMap(p => [p.user, ...p.messages]);
    const hookTranscript = buildTranscript(hookMsgs);

    // Lorebook transcript: sync pairs only (syncPoint), or rolling horizon (latestTurn).
    const lbSyncStart   = settings.lorebookSyncStart ?? 'syncPoint';
    let lbPairsForLog;
    let lbTranscript;
    if (lbSyncStart === 'latestTurn') {
        lbPairsForLog = hookPairs;   // same window as hookseeker
        lbTranscript  = hookTranscript;
    } else {
        lbPairsForLog = syncPairs;
        const lbMsgs  = syncPairs.flatMap(p => [p.user, ...p.messages]);
        lbTranscript  = buildTranscript(lbMsgs);
    }

    logSyncStart(hookPairs, lbPairsForLog, syncPairs, coverAll, settings.chunkEveryN ?? 20);

    // Ensure lorebook is loaded before lanes start — auto-sync may run before openReviewModal.
    if (!_draftLorebook) {
        const lbName   = settings.lorebookName || char.name;
        _lorebookName  = lbName;
        _lorebookData  = await lbEnsureLorebook(_lorebookName);
        _draftLorebook = structuredClone(_lorebookData);
        console.log(`[CNZ] Lorebook lazy-loaded: "${_lorebookName}" (${Object.keys(_lorebookData.entries ?? {}).length} entries)`);
    }
    // Link lorebook to character if not already set.
    if (char?.data?.extensions?.world !== _lorebookName) {
        try {
            await patchCharacterWorld(char, _lorebookName);
            console.log(`[CNZ] Lorebook linked to character: "${char.name}" → "${_lorebookName}"`);
        } catch (e) {
            console.error('[CNZ] Lorebook link failed:', e.message ?? e);
        }
    }

    // --- LANE 1: LOREBOOK (Independent) ---
    const lbPromise = (async () => {
        console.log('[CNZ] Lane 1 (lorebook): starting');
        try {
            const text = await runLorebookSyncCall(lbTranscript, _lorebookData);
            await processLorebookUpdate(text);
            console.log('[CNZ] Lane 1 (lorebook): ✓ ok');
            return true;
        } catch (e) {
            console.error('[CNZ] Lane 1 (lorebook): ✗ failed —', e.message ?? e, e);
            return false;
        }
    })();

    // --- LANE 2: HOOKS (Independent) ---
    const hooksPromise = (async () => {
        console.log('[CNZ] Lane 2 (hooks): starting');
        try {
            const text = await runHookseekerCall(hookTranscript, _priorSituation);
            await processHooksUpdate(text);
            _priorSituation = text;
            console.log('[CNZ] Lane 2 (hooks): ✓ ok');
            return true;
        } catch (e) {
            console.error('[CNZ] Lane 2 (hooks): ✗ failed —', e.message ?? e, e);
            _priorSituation = 'Current Action';
            return false;
        }
    })();

    // --- LANE 3: RAG (Independent) ---
    const ragPromise = (async () => {
        if (!settings.enableRag) { console.log('[CNZ] Lane 3 (RAG): skipped (disabled)'); return true; }
        console.log('[CNZ] Lane 3 (RAG): starting');
        try {
            await runRagPipeline();
            console.log('[CNZ] Lane 3 (RAG): ✓ ok');
            return true;
        } catch (e) {
            console.error('[CNZ] Lane 3 (RAG): ✗ failed —', e.message ?? e, e);
            return false;
        }
    })();

    const [lbOk, hooksOk, ragOk] = await Promise.all([lbPromise, hooksPromise, ragPromise]);

    // Commit the DNA anchor regardless of individual lane success.
    console.log('[CNZ] DNA chain: committing anchor');
    let anchorOk = false;
    try {
        await commitDnaAnchor(messages);
        anchorOk = true;
        console.log('[CNZ] DNA chain: ✓ ok');
        // Stamp the now-known anchor UUID onto the CNZ Summary prompt
        const newUuid = _dnaChain.lkg?.uuid ?? null;
        if (newUuid) writeCnzSummaryPrompt(char.avatar, _priorSituation, newUuid);
    } catch (e) {
        console.error('[CNZ] DNA chain: ✗ failed —', e.message ?? e, e);
    }

    setSyncInProgress(false);

    const failures = [
        !lbOk    && 'lorebook',
        !hooksOk && 'hooks',
        !ragOk   && 'RAG',
        !anchorOk && 'anchor commit',
    ].filter(Boolean);

    if (failures.length === 0) {
        console.log('[CNZ] ══ SYNC COMPLETE ══ all lanes ok');
        toastr.success('Sync processed');
    } else {
        console.warn(`[CNZ] ══ SYNC COMPLETE ══ failed: ${failures.join(', ')}`);
        toastr.warning(`Sync processed — failed: ${failures.join(', ')}`);
    }
}

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the DNA chain against the current chat history to detect branches.
 * If a branch is found, restores the lorebook and hooks block to the last valid
 * anchor and rolls the DNA chain head back.
 *
 * Outcomes:
 *   - Same timeline (head hash matches) → silent return.
 *   - No matching node (pre-CNZ or unrelated chat) → silent return.
 *   - Branch detected → restore + toastr.warning.
 *   - Restoration failure → toastr.error.
 *
 * @param {object} char         Current character object from context.
 * @param {string} chatFileName Current chat filename (unused directly; kept for signature parity).
 */
async function runHealer(char, _chatFileName) {
    const context  = SillyTavern.getContext();
    const messages = context.chat ?? [];
    if (!messages.length) return;

    _dnaChain = readDnaChain(messages);
    setDnaChain(_dnaChain);
    if (_dnaChain.anchors.length === 0) return;

    // ── Head check — same timeline? ───────────────────────────────────────────
    const headRef = _dnaChain.anchors[_dnaChain.anchors.length - 1];
    if (messages[headRef.msgIdx]?.extra?.cnz?.uuid === headRef.anchor.uuid) return;

    // ── Find deepest still-valid anchor ──────────────────────────────────────
    const lkgRef = findLkgAnchorByPosition(_dnaChain.anchors, messages);
    if (!lkgRef) return; // chat predates CNZ or is unrelated

    // ── Branch detected ───────────────────────────────────────────────────────
    const restorePoint = lkgRef.msgIdx + 1;

    const confirmed = await callPopup(
        `<h3>CNZ: Timeline Branch Detected</h3>
        <p>The current chat diverges from the last committed sync point at
        <strong>message ${restorePoint}</strong>.</p>
        <p>CNZ will restore world state to that point:</p>
        <ul>
            <li>Lorebook entries rolled back</li>
            <li>Narrative hooks rolled back</li>
            <li>RAG files for orphaned turns removed</li>
            <li>Vector index purged and rebuilt</li>
        </ul>
        <p>This cannot be undone.</p>`,
        'confirm',
    );

    if (!confirmed) {
        toastr.warning(
            'CNZ: Timeline branch detected but restoration was cancelled — ' +
            'world state may not match the current chat.',
            '',
            { timeOut: 0, extendedTimeOut: 0, closeButton: true },
        );
        return;
    }

    try {
        const nodeFile   = buildNodeFileFromAnchor(lkgRef.anchor);
        const nodeDummy  = { nodeId: lkgRef.anchor.uuid }; // safe dummy for error messages in restore fns

        await restoreLorebookToNode(char, nodeDummy, nodeFile);
        await restoreHooksToNode(char, nodeDummy, nodeFile);

        try {
            await restoreRagToNode(char, nodeFile);
        } catch (err) {
            console.error('[CNZ] Healer: RAG reconciliation failed:', err);
            toastr.warning('CNZ: Branch healed but RAG reconciliation failed — vector index may be inconsistent.');
        }

        _dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
        setDnaChain(_dnaChain);

        toastr.warning(`CNZ: Branch detected — restored to message ${restorePoint}. Vector index rebuilt.`);
    } catch (err) {
        console.error('[CNZ] Healer: restoration failed:', err);
        toastr.error('CNZ: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}

// ─── Prompt Modal ─────────────────────────────────────────────────────────────

/**
 * Opens the prompt-editor popup for a given settings key.
 * Changes are saved live on input; the modal is closed with the Close button
 * or by clicking the overlay backdrop.
 * @param {string}      settingsKey        Key in extension_settings[EXT_NAME] to read/write.
 * @param {string}      title              Title displayed in the modal header.
 * @param {string}      defaultValue       Value used by the "Reset to Default" button.
 * @param {string[]}    vars               Template variable names to display as badges.
 */
function openPromptModal(settingsKey, title, defaultValue, vars = []) {
    const $overlay  = $('#cnz-pm-overlay');
    const $textarea = $('#cnz-pm-textarea');
    const $titleEl  = $('#cnz-pm-title');
    const $reset    = $('#cnz-pm-reset');
    const $close    = $('#cnz-pm-close');
    const $vars     = $('#cnz-pm-vars');

    $titleEl.text(title);
    $textarea.val(getSettings()[settingsKey] ?? defaultValue);
    $vars.html(vars.map(v => `<code class="cnz-pm-var">{{${v}}}</code>`).join(' '));

    // Unbind any previous open's handlers before re-binding
    $textarea.off('input.pm');
    $reset.off('click.pm');
    $close.off('click.pm');
    $overlay.off('click.pm');
    $('#cnz-pm-modal').off('click.pm').on('click.pm', e => e.stopPropagation());

    $textarea.on('input.pm', function () {
        getSettings()[settingsKey] = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $reset.on('click.pm', function () {
        getSettings()[settingsKey] = defaultValue;
        $textarea.val(defaultValue);
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    const closePromptModal = (e) => {
        e?.stopPropagation();
        $overlay.addClass('cnz-hidden');
    };
    $close.on('click.pm', closePromptModal);
    $overlay.on('click.pm', function (e) {
        if (e.target === this) closePromptModal(e);
    });

    $overlay.removeClass('cnz-hidden');
    requestAnimationFrame(() => $textarea[0]?.focus());
}

/**
 * @section Settings Panel
 * @architectural-role Extension Settings UI
 * @description
 * Owns the extension settings UI rendered in the ST extensions panel.
 * Manages profile creation, switching, and deletion; binds all input
 * handlers to activeState; and controls visibility of dependent controls
 * (e.g. RAG AI controls hidden when RAG is disabled). The prompt modal
 * for editing multi-line prompts is also launched from here.
 * @core-principles
 *   1. All handlers write to activeState first, then call saveSettingsDebounced.
 *   2. refreshSettingsUI is the single source of truth for control state — never set DOM directly.
 * @api-declaration
 *   injectSettingsPanel, bindSettingsHandlers, refreshSettingsUI,
 *   refreshProfileDropdown, updateDirtyIndicator,
 *   updateRagAiControlsVisibility, openPromptModal
 * @contract
 *   assertions:
 *     external_io: [none]
 */
// ─── Settings Panel ───────────────────────────────────────────────────────────

/** True if activeState differs from the saved profile snapshot. */
function isStateDirty() {
    const meta = getMetaSettings();
    return JSON.stringify(meta.activeState) !== JSON.stringify(meta.profiles[meta.currentProfileName]);
}

/** Updates the profile dropdown label to append '*' when state is dirty. */
function updateDirtyIndicator() {
    const meta  = getMetaSettings();
    const label = meta.currentProfileName + (isStateDirty() ? ' *' : '');
    const $sel  = $('#cnz-profile-select');
    $sel.find(`option[value="${CSS.escape(meta.currentProfileName)}"]`).text(label);
    $sel.val(meta.currentProfileName);
}

/**
 * Repopulates all settings inputs from activeState. Called after loading a profile.
 * Connection profile dropdowns are re-initialized via handleDropdown, which
 * requires the element to already be in the DOM.
 */
function refreshSettingsUI() {
    const s = getSettings();

    $('#cnz-set-live-context-buffer').val(s.liveContextBuffer ?? 5);
    $('#cnz-set-chunk-every-n').val(s.chunkEveryN ?? 20);
    $('#cnz-set-gap-snooze').val(s.gapSnoozeTurns ?? 5);
    $('#cnz-set-hookseeker-horizon').val(s.hookseekerHorizon ?? 40);
    $('#cnz-set-lorebook-sync-start').val(s.lorebookSyncStart ?? 'syncPoint');
    $('#cnz-set-auto-advance-mask').prop('checked', s.autoAdvanceMask ?? false);
    $('#cnz-set-enable-rag').prop('checked', s.enableRag ?? false);
    $('#cnz-rag-settings-body').toggleClass('cnz-disabled', !(s.enableRag ?? false));
    $('#cnz-set-rag-separator').val(s.ragSeparator ?? DEFAULT_SEPARATOR);
    $('#cnz-set-rag-contents').val(s.ragContents ?? 'summary+full');

    const hasSummary = (s.ragContents ?? 'summary+full') !== 'full';
    $('#cnz-rag-summary-source-row').toggleClass('cnz-hidden', !hasSummary);
    $('#cnz-set-rag-summary-source').val(s.ragSummarySource ?? 'defined');
    $('#cnz-set-rag-max-tokens').val(s.ragMaxTokens ?? 100);
    $('#cnz-set-rag-chunk-size').val(s.ragChunkSize ?? 2);
    $('#cnz-set-rag-chunk-overlap').val(s.ragChunkOverlap ?? 0);
    $('#cnz-set-rag-classifier-history').val(s.ragClassifierHistory ?? 0);
    $('#cnz-set-rag-max-concurrent').val(s.maxConcurrentCalls ?? DEFAULT_CONCURRENCY);
    $('#cnz-set-rag-retries').val(s.ragMaxRetries ?? 1);
    updateRagAiControlsVisibility();

    // Re-initialize connection profile dropdowns with the newly loaded values.
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile',
            s.profileId ?? '',
            (profile) => { getSettings().profileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile',
            s.ragProfileId ?? '',
            (profile) => { getSettings().ragProfileId = profile?.id ?? null; saveSettingsDebounced(); updateDirtyIndicator(); },
        );
    } catch (e) { /* silent */ }

    updateDirtyIndicator();
}

/** Rebuilds the profile <select> options from the current profiles dict. */
function refreshProfileDropdown() {
    const meta = getMetaSettings();
    const $sel = $('#cnz-profile-select');
    $sel.empty();
    for (const name of Object.keys(meta.profiles)) {
        $sel.append($('<option>').val(name).text(name));
    }
    updateDirtyIndicator();
}

/**
 * Hard-resets the external world to match the LKG anchor, then rebuilds a single
 * combined RAG file from all chunk data stored in the chain.
 *
 * Order of operations:
 *   1. Delete all CNZ RAG files for this character from the Data Bank.
 *   2. Restore the lorebook from the LKG anchor.
 *   3. Restore the hooks summary from the LKG anchor.
 *   4. Reconstruct one combined RAG document from every anchor's ragHeaders
 *      (using stored pairStart/pairEnd for content slicing, stored header text).
 *   5. Upload, register, update LKG anchor ragUrl, save chat.
 *   6. Purge and re-ingest the vector index.
 *
 * Stateful owner: reads module state (isSyncInProgress), writes nothing directly —
 * delegates all state mutation to the existing restore/register helpers.
 */
async function purgeAndRebuild() {
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync in progress — wait for it to complete.');
        return;
    }
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('CNZ: No character selected.'); return; }

    const messages = ctx.chat ?? [];
    const chain    = readDnaChain(messages);
    if (!chain.lkg) {
        toastr.warning('CNZ: No anchor found in this chat — nothing to restore from.');
        return;
    }

    const confirmed = await callPopup(`
<h3>Purge &amp; Rebuild</h3>
<p>For <strong>${escapeHtml(char.name)}</strong>, this will:</p>
<ul>
  <li>Delete all CNZ RAG files from the Data Bank</li>
  <li>Clear and restore the lorebook from the last anchor</li>
  <li>Restore the hooks summary from the last anchor</li>
  <li>Rebuild a single RAG file from the full chain history</li>
</ul>
<label style="display:flex;align-items:center;gap:0.5em;margin-top:0.75em;">
  <input type="checkbox" id="cnz-purge-deep">
  Reclassify all chunks with AI (slow)
</label>
<p style="margin-top:0.5em">This cannot be undone.</p>`, 'confirm');
    if (!confirmed) return;

    const deepReclassify = document.getElementById('cnz-purge-deep')?.checked ?? false;

    try {
        // ── 1. Delete all CNZ RAG files ──────────────────────────────────────────
        const cnzRagPrefix   = `cnz_${cnzAvatarKey(char.avatar)}_rag_`;
        const allAttachments = extension_settings.character_attachments?.[char.avatar] ?? [];
        const cnzFiles       = allAttachments.filter(a => a.name?.startsWith(cnzRagPrefix));
        for (const f of cnzFiles) {
            await cnzDeleteFile(f.url);
        }
        extension_settings.character_attachments[char.avatar] = allAttachments.filter(a => !cnzFiles.includes(a));
        saveSettingsDebounced();

        // ── 2 & 3. Restore lorebook and hooks from LKG ───────────────────────────
        const fakeNodeFile = { state: { uuid: chain.lkg.uuid ?? null, lorebook: chain.lkg.lorebook, hooks: chain.lkg.hooks } };
        await restoreLorebookToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);
        await restoreHooksToNode(char, { nodeId: 'rebuild' }, fakeNodeFile);

        // ── 4. Reconstruct combined RAG document ──────────────────────────────────
        const allPairs   = buildProsePairs(messages);
        const ragSettings = getSettings();

        // Fast path: hydrate from cnz_chunk_header stamps already on messages.
        // Deep path: reclassify every chunk fresh via the AI classifier fan-out,
        //   using the same dispatch + bus pattern as runRagPipeline.
        let combinedChunks;
        if (deepReclassify) {
            // Set module state so the fan-out and bus subscriber operate correctly.
            _stagedProsePairs = allPairs;
            _stagedPairOffset = 0;
            _splitPairIdx     = allPairs.length;
            _ragChunks        = buildRagChunks(allPairs, 0, ragSettings); // all status: 'pending'

            setCurrentSettings(ragSettings);
            dispatchContract('rag_classifier', {
                ragChunks:        _ragChunks,
                fullPairs:        allPairs,
                stagedPairs:      allPairs,
                stagedPairOffset: 0,
                splitPairIdx:     allPairs.length,
                scenario_hooks:   chain.lkg.hooks ?? '',
            }, ragSettings);
            // Longer timeout — full chat history, not just one sync window.
            await waitForRagChunks(300_000);
            combinedChunks = _ragChunks.filter(c => c.status === 'complete');
        } else {
            // Fast path: walk messages and collect cnz_chunk_header stamps directly.
            // Do NOT re-chunk — new chunk boundaries won't align with original stamps
            // if the chat has grown since the original sync.
            combinedChunks = [];
            let prevPairEnd = 0;
            for (let i = 0; i < allPairs.length; i++) {
                const pair    = allPairs[i];
                const lastMsg = pair?.messages?.[pair.messages.length - 1];
                if (!lastMsg?.extra?.cnz_chunk_header) continue;
                const pairStart = prevPairEnd;
                const pairEnd   = i + 1;
                const window    = allPairs.slice(pairStart, pairEnd);
                const content   = window.map(p => {
                    const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                    for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                    return parts.join('\n\n');
                }).join('\n\n');
                combinedChunks.push({
                    chunkIndex: combinedChunks.length,
                    header:     lastMsg.extra.cnz_chunk_header,
                    turnRange:  lastMsg.extra.cnz_turn_label?.replace(/^\*+\s*Memory:\s*/i, '') ?? `Pairs ${pairStart + 1}–${pairEnd}`,
                    content,
                    status:     'complete',
                });
                prevPairEnd = pairEnd;
            }
        }

        if (combinedChunks.length === 0) {
            toastr.warning('CNZ: No classified chunks found in chain — RAG file not rebuilt. Run a sync first.');
            return;
        }

        // ── 5. Upload, register, patch LKG anchor, save ───────────────────────────
        const charName    = char.name ?? '';
        const ragText     = buildRagDocument(combinedChunks, ragSettings, charName);
        const ragFileName = cnzFileName(cnzAvatarKey(char.avatar), 'rag', Date.now(), char.name);
        const ragUrl      = await uploadRagFile(ragText, ragFileName);
        const byteSize    = new TextEncoder().encode(ragText).length;
        registerCharacterAttachment(char.avatar, ragUrl, ragFileName, byteSize);

        for (const { msgIdx } of chain.anchors) {
            const msg = messages[msgIdx];
            if (msg?.extra?.cnz) {
                msg.extra.cnz = Object.assign({}, msg.extra.cnz, { ragUrl });
            }
        }
        await ctx.saveChat();

        // ── 6. Re-vectorize ───────────────────────────────────────────────────────
        const { executeSlashCommandsWithOptions } = ctx;
        await executeSlashCommandsWithOptions('/db-purge');
        await executeSlashCommandsWithOptions('/db-ingest');

        toastr.success(`CNZ: Rebuild complete — ${combinedChunks.length} chunks re-indexed.`);
    } catch (err) {
        console.error('[CNZ] purgeAndRebuild:', err);
        toastr.error(`CNZ: Rebuild failed: ${err.message}`);
    }
}

function bindSettingsHandlers() {
    // ── Summary / Lorebook ────────────────────────────────────────────────────
    $('#cnz-set-live-context-buffer').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 5);
        getSettings().liveContextBuffer = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-chunk-every-n').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 20);
        getSettings().chunkEveryN = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-gap-snooze').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 5);
        getSettings().gapSnoozeTurns = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-hookseeker-horizon').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 40);
        getSettings().hookseekerHorizon = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-lorebook-sync-start').on('change', function () {
        getSettings().lorebookSyncStart = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-auto-advance-mask').on('change', function () {
        getSettings().autoAdvanceMask = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
    });


    $('#cnz-edit-summary-prompt').on('click', () =>
        openPromptModal('hookseekerPrompt', 'Edit Summary Prompt', DEFAULT_HOOKSEEKER_PROMPT,
            ['transcript', 'prev_summary']));

    $('#cnz-edit-lorebook-prompt').on('click', () =>
        openPromptModal('lorebookSyncPrompt', 'Edit Lorebook Sync Prompt', DEFAULT_LOREBOOK_SYNC_PROMPT,
            ['lorebook_entries', 'transcript']));

    $('#cnz-edit-targeted-update-prompt').on('click', () =>
        openPromptModal('targetedUpdatePrompt', 'Edit Targeted Update Prompt',
            DEFAULT_TARGETED_UPDATE_PROMPT,
            ['entry_name', 'entry_keys', 'entry_content', 'transcript']));

    $('#cnz-edit-targeted-new-prompt').on('click', () =>
        openPromptModal('targetedNewPrompt', 'Edit Targeted New Entry Prompt',
            DEFAULT_TARGETED_NEW_PROMPT,
            ['entry_name', 'transcript']));

    // ── RAG ───────────────────────────────────────────────────────────────────
    $('#cnz-set-enable-rag').on('change', function () {
        getSettings().enableRag = $(this).prop('checked');
        saveSettingsDebounced(); updateDirtyIndicator();
        $('#cnz-rag-settings-body').toggleClass('cnz-disabled', !getSettings().enableRag);
    });

    $('#cnz-set-rag-separator').on('change', function () {
        const newVal   = $(this).val();
        const oldVal   = getSettings().ragSeparator ?? '';
        if (newVal === oldVal) return;

        // Count stored chunk headers in the current chat
        const chat       = SillyTavern.getContext().chat ?? [];
        const storedCount = chat.filter(m => m.extra?.cnz_chunk_header).length;

        if (storedCount > 0) {
            const approxTurns = storedCount * (getSettings().ragChunkSize ?? 2);
            const confirmed   = confirm(
                `Changing the separator invalidates ${storedCount} stored chunk header(s) ` +
                `(~${approxTurns} turns).\n\n` +
                `All headers will be cleared and reclassified, and your external vector store ` +
                `will need to resync.\n\nProceed?`
            );
            if (!confirmed) {
                $(this).val(oldVal);   // revert the input
                return;
            }
            // Clear stored headers from all chat messages
            for (const m of chat) {
                if (m.extra?.cnz_chunk_header) {
                    delete m.extra.cnz_chunk_header;
                    delete m.extra.cnz_turn_label;
                }
            }
            SillyTavern.getContext().saveChat().catch(err =>
                console.error('[CNZ] saveChat after separator clear failed:', err),
            );
            // Mark any in-memory chunks as pending so they reclassify on next open
            for (const c of _ragChunks) {
                if (c.status === 'complete' || c.status === 'manual') c.status = 'pending';
            }
        }

        getSettings().ragSeparator = newVal;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-contents').on('change', function () {
        getSettings().ragContents = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        const hasSummary = $(this).val() !== 'full';
        $('#cnz-rag-summary-source-row').toggleClass('cnz-hidden', !hasSummary);
        updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-summary-source').on('change', function () {
        getSettings().ragSummarySource = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
        updateRagAiControlsVisibility();
    });

    $('#cnz-set-rag-max-tokens').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) {
            getSettings().ragMaxTokens = val;
            saveSettingsDebounced(); updateDirtyIndicator();
        }
    });

    $('#cnz-set-rag-chunk-size').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 2);
        getSettings().ragChunkSize = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-chunk-overlap').on('change', function () {
        getSettings().ragChunkOverlap = parseInt($(this).val()) || 0;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-max-concurrent').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || DEFAULT_CONCURRENCY);
        getSettings().maxConcurrentCalls = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-retries').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().ragMaxRetries = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-set-rag-classifier-history').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().ragClassifierHistory = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-classifier-prompt').on('click', () =>
        openPromptModal('ragClassifierPrompt', 'Edit Classifier Prompt', DEFAULT_RAG_CLASSIFIER_PROMPT,
            ['summary', 'history', 'target_turns']));

    // ── Connection profiles ───────────────────────────────────────────────────
    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-profile',
            getSettings().profileId ?? '',
            (profile) => {
                getSettings().profileId = profile?.id ?? null;
                saveSettingsDebounced(); updateDirtyIndicator();
            },
        );
    } catch (e) {
        console.warn('[CNZ] Could not initialize profile dropdown:', e);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#cnz-set-rag-profile',
            getSettings().ragProfileId ?? '',
            (profile) => {
                getSettings().ragProfileId = profile?.id ?? null;
                saveSettingsDebounced(); updateDirtyIndicator();
            },
        );
    } catch (e) {
        console.warn('[CNZ] Could not initialize RAG profile dropdown:', e);
    }

    // ── Profile management ────────────────────────────────────────────────────
    $('#cnz-profile-select').on('change', function () {
        const newName = $(this).val();
        const meta    = getMetaSettings();
        if (!meta.profiles[newName]) return;
        meta.currentProfileName = newName;
        meta.activeState        = structuredClone(meta.profiles[newName]);
        saveSettingsDebounced();
        refreshSettingsUI();
    });

    $('#cnz-profile-save').on('click', function () {
        const meta = getMetaSettings();
        meta.profiles[meta.currentProfileName] = structuredClone(meta.activeState);
        saveSettingsDebounced();
        updateDirtyIndicator();
    });

    $('#cnz-profile-add').on('click', async function () {
        const rawName = await callPopup('<h3>New profile name</h3>', 'input', '');
        const name    = (rawName ?? '').trim();
        if (!name) return;
        const meta = getMetaSettings();
        if (meta.profiles[name]) {
            toastr.warning(`Profile "${name}" already exists.`);
            return;
        }
        meta.profiles[name]     = structuredClone(meta.activeState);
        meta.currentProfileName = name;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#cnz-profile-rename').on('click', async function () {
        const meta    = getMetaSettings();
        const rawName = await callPopup('<h3>Rename profile</h3>', 'input', meta.currentProfileName);
        const newName = (rawName ?? '').trim();
        if (!newName || newName === meta.currentProfileName) return;
        if (meta.profiles[newName]) {
            toastr.warning(`Profile "${newName}" already exists.`);
            return;
        }
        meta.profiles[newName] = meta.profiles[meta.currentProfileName];
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = newName;
        saveSettingsDebounced();
        refreshProfileDropdown();
    });

    $('#cnz-profile-delete').on('click', async function () {
        const meta = getMetaSettings();
        if (Object.keys(meta.profiles).length <= 1) {
            toastr.warning('Cannot delete the only profile.');
            return;
        }
        const confirmed = await callPopup(
            `<h3>Delete profile "${escapeHtml(meta.currentProfileName)}"?</h3>This cannot be undone.`,
            'confirm',
        );
        if (!confirmed) return;
        delete meta.profiles[meta.currentProfileName];
        meta.currentProfileName = Object.keys(meta.profiles)[0];
        meta.activeState        = structuredClone(meta.profiles[meta.currentProfileName]);
        saveSettingsDebounced();
        refreshProfileDropdown();
        refreshSettingsUI();
    });

    $('#cnz-inspect-chain').on('click', function () {
        openDnaChainInspector();
    });


    $('#cnz-purge-chain').on('click', function () { purgeAndRebuild(); });
}

/**
 * Shows/hides the RAG AI controls subgroup based on current ragContents and
 * ragSummarySource settings. Called on init and on dropdown changes.
 */
function updateRagAiControlsVisibility() {
    const s = getSettings();
    const hasSummary    = (s.ragContents ?? 'summary+full') !== 'full';
    const isDefinedHere = (s.ragSummarySource ?? 'defined') === 'defined';
    $('#cnz-rag-ai-controls').toggleClass('cnz-disabled', !(hasSummary && isDefinedHere));
}

function injectSettingsPanel() {
    if ($('#cnz-settings').length) return;
    const meta = getMetaSettings();
    $('#extensions_settings').append(
        buildSettingsHTML(getSettings(), escapeHtml, Object.keys(meta.profiles), meta.currentProfileName),
    );
    bindSettingsHandlers();
    refreshProfileDropdown();
    updateRagAiControlsVisibility();
}

/**
 * @section Event Handlers and Init
 * @architectural-role ST Event Bindings and Extension Entry Point
 * @description
 * Owns the ST event bindings, the wand button, and the extension entry point.
 * The SYNC_TRIGGERED bus event fires after each AI message (via scheduler) and
 * drives sync cycles. onChatChanged resets session state and triggers
 * the Healer on character switch. Delegated click handlers dispatch wand menu
 * actions. `init` registers all event listeners and injects persistent UI.
 * @core-principles
 *   1. No business logic here — handlers delegate immediately to engine functions.
 *   2. checkOrphans runs once on init and on chat change; it never blocks the event loop.
 * @api-declaration
 *   onChatChanged, onWandButtonClick, injectWandButton,
 *   checkOrphans, init
 * @contract
 *   assertions:
 *     external_io: [eventSource, /api/chats/saveChat]
 */
// ─── Event Handlers ───────────────────────────────────────────────────────────

/**
 * Scans the character attachment registry for files belonging to characters
 * that no longer exist in ST. Wipes dead registry keys, verifies surviving
 * files on disk, then toasts with a Review link if any remain.
 * Called on character switch — fires-and-forgets, never blocks the event loop.
 */
async function checkOrphans() {
    const ctx            = SillyTavern.getContext();
    const liveAvatars    = new Set((ctx.characters ?? []).map(c => c.avatar));
    const allAttachments = extension_settings.character_attachments ?? {};

    // Collect urls for dead-character keys and wipe them from the registry.
    const orphanUrls = [];
    for (const [avatarKey, files] of Object.entries(allAttachments)) {
        if (!liveAvatars.has(avatarKey)) {
            orphanUrls.push(...(files ?? []).map(f => f.url).filter(Boolean));
            delete extension_settings.character_attachments[avatarKey];
        }
    }

    if (orphanUrls.length === 0) return;
    saveSettingsDebounced();

    // Verify which files are still on disk — no point listing already-gone files.
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
        console.warn('[CNZ] checkOrphans: verify request failed:', err);
    }

    if (existing.length === 0) return;

    _pendingOrphans = existing;
    const n = existing.length;
    toastr.warning(
        `CNZ: ${n} orphaned file${n !== 1 ? 's' : ''} from deleted character${n !== 1 ? 's' : ''}. ` +
        `<a href="#" class="cnz-orphan-review">Review</a> &nbsp; <a href="#" class="cnz-orphan-dismiss">Dismiss</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

/**
 * Resets all session-level state on character switch.
 * Called by onChatChanged when the character changes.
 * Never called by closeModal — modal state is separate.
 */
/**
 * Resets staged pair and chunk state without clearing lorebook, DNA chain,
 * or other session fields. Called by the purge handler and (via resetSessionState)
 * on character switch.
 */
function resetStagedState() {
    _stagedProsePairs       = [];
    _stagedPairOffset       = 0;
    _splitPairIdx           = 0;
    _ragChunks              = [];
    clearChunkChatLabels();
}

function resetSessionState() {
    invalidateAllJobs();
    resetScheduler();
    _dnaChain               = null;
    setDnaChain(null);
    _lorebookData           = null;
    _draftLorebook          = null;
    _lorebookName           = '';
    _lorebookSuggestions    = [];
    _parentNodeLorebook     = null;
    _priorSituation         = '';
    _beforeSituation        = '';
    _lastRagUrl             = '';
    resetStagedState();
}

function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        _lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    // Character switched — reset all session state, then heal.
    if (!char || char.avatar !== _lastKnownAvatar) {
        _lastKnownAvatar = char?.avatar ?? null;
        resetSessionState();
        const chatMessages = SillyTavern.getContext().chat ?? [];
        _dnaChain = readDnaChain(chatMessages);
        setDnaChain(_dnaChain);
        syncCnzSummaryOnCharacterSwitch(char, _dnaChain);
        if (char) {
            runHealer(char, char.chat).catch(err =>
                console.error('[CNZ] onChatChanged: healer failed:', err),
            );
            checkOrphans().catch(err =>
                console.error('[CNZ] checkOrphans failed:', err),
            );
        }
        return;
    }

    // Same character, different chat — Healer territory
    if (chatFileName) {
        runHealer(char, chatFileName).catch(err =>
            console.error('[CNZ] runHealer uncaught error:', err),
        );
    }
}

// ─── Wand Menu Button ─────────────────────────────────────────────────────────

/**
 * Shows a three-button choice dialog. Returns a Promise that resolves to
 * 'full', 'window', or 'cancel'.
 * @param {string} bodyHtml   Inner HTML for the message body.
 * @param {string} fullLabel  Label for the "full gap" button.
 * @param {string} winLabel   Label for the "standard window" button.
 */
function showSyncChoicePopup(bodyHtml, fullLabel, winLabel) {
    return new Promise(resolve => {
        const $overlay = $(`
            <div class="cnz-choice-overlay">
                <div class="cnz-choice-dialog">
                    ${bodyHtml}
                    <div class="cnz-choice-buttons">
                        <button class="cnz-choice-full menu_button">${fullLabel}</button>
                        <button class="cnz-choice-win menu_button">${winLabel}</button>
                        <button class="cnz-choice-cancel menu_button">Cancel</button>
                    </div>
                </div>
            </div>
        `);
        $overlay.find('.cnz-choice-full').on('click',   () => { $overlay.remove(); resolve('full'); });
        $overlay.find('.cnz-choice-win').on('click',    () => { $overlay.remove(); resolve('window'); });
        $overlay.find('.cnz-choice-cancel').on('click', () => { $overlay.remove(); resolve('cancel'); });
        $('body').append($overlay);
    });
}

/**
 * Handles the CNZ wand toolbar button. Decision tree:
 *  - gap < chunkEveryN:  open review modal only (not enough turns to sync)
 *  - gap === chunkEveryN: run standard sync then open modal
 *  - gap > chunkEveryN:  show blocking choice popup (window vs all)
 */
async function onWandButtonClick() {
    const ctx = SillyTavern.getContext();
    if (!ctx || ctx.groupId || ctx.characterId == null) {
        toastr.error('CNZ: No character selected.');
        return;
    }
    if (isSyncInProgress()) {
        toastr.warning('CNZ: Sync already in progress — please wait.');
        return;
    }

    const char     = ctx.characters[ctx.characterId];
    const messages = ctx.chat ?? [];
    const settings = getSettings();
    const gap      = getGap(settings);

    // Nothing new to sync yet (everything committed, or gap below threshold) — open modal directly.
    if (gap < (settings.chunkEveryN ?? 20)) {
        openReviewModal();
        return;
    }

    if (gap === (settings.chunkEveryN ?? 20)) {
        toastr.info('CNZ: Running sync…');
        await runCnzSync(char, messages);
        openReviewModal();
        return;
    }

    // gap > chunkEveryN — ask the user how much to cover.
    // Check which middle turns are truly unRAGged vs already captured.
    const winSize       = settings.chunkEveryN ?? 20;
    const lkgIdx        = _dnaChain?.lkgMsgIdx ?? -1;
    const lcb           = settings.liveContextBuffer ?? 5;
    const pairCount     = messages.filter(m => !m.is_system && m.is_user).length;
    const priorPairs    = lkgIdx >= 0
        ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system && m.is_user).length
        : 0;
    const trailingBound = Math.max(0, pairCount - lcb);
    const allPairs      = buildProsePairs(messages);
    const gapPairs      = allPairs.slice(priorPairs, trailingBound);
    const middlePairs   = gapPairs.slice(0, Math.max(0, gapPairs.length - winSize));
    const unragged      = middlePairs.filter(p => {
        const lastMsg = p.messages.length > 0 ? p.messages[p.messages.length - 1] : p.user;
        return !lastMsg?.extra?.cnz_chunk_header;
    });

    let extraWarning;
    if (middlePairs.length === 0) {
        extraWarning = '';
    } else if (unragged.length === 0) {
        extraWarning = `<p class="cnz-choice-info">✓ All ${middlePairs.length} middle turn(s) are already in RAG — Standard window will only skip the anchor update.</p>`;
    } else if (unragged.length < middlePairs.length) {
        extraWarning = `<p class="cnz-choice-warn">⚠ ${unragged.length} of ${middlePairs.length} middle turn(s) have never been in RAG and will be lost with Standard window.</p>`;
    } else {
        extraWarning = `<p class="cnz-choice-warn">⚠ ${unragged.length} turn(s) in the middle have never been in RAG and will be lost with Standard window.</p>`;
    }

    const choice = await showSyncChoicePopup(
        `<h3>How much should this sync cover?</h3>
        <p>${gap} turn(s) have accumulated since the last sync (window size: ${winSize}).</p>
        ${extraWarning}`,
        `Full gap (${gap} turns)`,
        `Standard window (last ${winSize} turns)`,
    );
    if (choice === 'cancel') return;
    const coverAll = choice === 'full';

    toastr.info(`CNZ: Running sync (${coverAll ? `full ${gap}-turn gap` : `last ${winSize} turns`})…`);
    await runCnzSync(char, messages, { coverAll });
    openReviewModal();
}

function injectWandButton() {
    if ($('#cnz-wand-btn').length) return;
    const btn = $(
        '<div id="cnz-wand-btn" class="list-group-item flex-container flexGap5" title="Run Canonize">' +
        '<i class="fa-solid fa-book-open"></i>' +
        '<span>Run Canonize</span>' +
        '</div>'
    );
    btn.on('click', () => onWandButtonClick().catch(err => {
        console.error('[CNZ] Wand button error:', err);
        toastr.error(`CNZ: ${err.message}`);
    }));
    $('#extensionsMenu').append(btn);
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    initSettings();
    initScheduler(Triggers, getSettings);
    injectModal();
    injectSettingsPanel();
    injectWandButton();
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

    // Delegated click handler for the review toast link (registered once — not per-sync)
    $(document).on('click', '.cnz-review-link', (e) => {
        e.preventDefault();
        openReviewModal();
    });
    // Delegated click handlers for the orphan-check toast links
    $(document).on('click', '.cnz-orphan-review', (e) => {
        e.preventDefault();
        toastr.clear();
        openOrphanModal(_pendingOrphans);
    });
    $(document).on('click', '.cnz-orphan-dismiss', (e) => {
        e.preventDefault();
        toastr.clear();
    });
    // Delegated handlers for the large-gap toast
    $(document).on('click', '.cnz-gap-sync-all', (e) => {
        e.preventDefault();
        toastr.clear();
        const ctx = SillyTavern.getContext();
        if (!ctx || ctx.characterId == null) return;
        const char     = ctx.characters[ctx.characterId];
        const messages = ctx.chat ?? [];
        runCnzSync(char, messages, { coverAll: true }).catch(err =>
            console.error('[CNZ] Gap sync-all failed:', err),
        );
    });
    $(document).on('click', '.cnz-gap-snooze', (e) => {
        e.preventDefault();
        toastr.clear();
        invalidateAllJobs();
        const ctx          = SillyTavern.getContext();
        const messages     = ctx?.chat ?? [];
        const pairCount    = messages.filter(m => !m.is_system && m.is_user).length;
        const snoozePairs  = getSettings().gapSnoozeTurns ?? 5;
        snooze(snoozePairs, pairCount);
    });

    // ── Bus subscribers ───────────────────────────────────────────────────────

    // RAG fan-out: mark chunk in-flight when its contract is dispatched
    on(BUS_EVENTS.CONTRACT_DISPATCHED, ({ recipeId, inputs }) => {
        if (recipeId !== 'rag_classifier') return;
        const chunk = _ragChunks[inputs?.chunkIndex];
        if (!chunk) return;
        chunk.status = 'in-flight';
        renderRagCard(inputs.chunkIndex);
    });

    // RAG fan-out: apply chunk results when all jobs settle
    on(BUS_EVENTS.CYCLE_STORE_UPDATED, ({ key, value }) => {
        if (key !== 'rag_chunk_results' || !value) return;
        for (const { chunkIndex, header } of value) {
            const chunk = _ragChunks[chunkIndex];
            if (!chunk) continue;
            if (header == null) {
                // Failed chunk — leave as pending for retry
                chunk.status = 'pending';
            } else {
                chunk.header = header.trim() || chunk.turnRange;
                chunk.status = 'complete';
                writeChunkHeaderToChat(chunkIndex).catch(err =>
                    console.error('[CNZ] writeChunkHeaderToChat error:', err));
            }
            renderRagCard(chunkIndex);
            renderChunkChatLabel(chunkIndex);
        }
    });

    // Auto-sync pump — fired by the auto_sync trigger in recipes.js
    on(BUS_EVENTS.SYNC_TRIGGERED, ({ char, messages, gap, every, trailingBoundary, largeGap }) => {
        console.log(`[CNZ] ══ SYNC TRIGGERED ══ gap=${gap}/${every} largeGap=${largeGap} char="${char?.name}"`);
        if (!largeGap) {
            runCnzSync(char, messages).catch(err =>
                console.error('[CNZ] runCnzSync uncaught error:', err),
            );
            return;
        }

        // Large-gap path — run window sync first, then offer to cover the rest
        if (isSyncInProgress()) return;

        (async () => {
            try {
                await runCnzSync(char, messages);
            } catch (err) {
                console.error('[CNZ] runCnzSync uncaught error:', err);
                return;
            }

            // Re-read DNA chain after the window sync — it may have closed the gap.
            const freshChain = readDnaChain(messages);
            const newLkgIdx  = freshChain.lkgMsgIdx;
            const newPrior   = newLkgIdx >= 0
                ? messages.slice(0, newLkgIdx + 1).filter(m => !m.is_system && m.is_user).length
                : 0;
            const remaining  = trailingBoundary - newPrior;
            if (remaining < every) return;

            const snoozePairs = getSettings().gapSnoozeTurns ?? 5;
            toastr.warning(
                `CNZ: ${remaining} uncaptured pair(s). ` +
                `<a href="#" class="cnz-gap-sync-all">Sync all</a> &nbsp; ` +
                `<a href="#" class="cnz-gap-snooze">Snooze ${snoozePairs} pairs</a>`,
                '',
                { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
            );
        })();
    });

    // Context mask — registered as a ST generate_interceptor in manifest.json.
    // ST core calls cnzMaskMessages() directly before each generation.
    globalThis.cnzMaskMessages = function(chat) {
        if (!getSettings().autoAdvanceMask) return;
        const IGNORE = SillyTavern.getContext().symbols.ignore;
        // Scan from the tail for the most recent anchor in this chat slice.
        // If ST's context window truncated the anchor out, all remaining messages
        // are post-anchor and nothing should be hidden.
        let anchorIdx = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.extra?.cnz?.type === 'anchor') { anchorIdx = i; break; }
        }
        if (anchorIdx < 0) return;
        for (let i = 0; i <= anchorIdx; i++) {
            chat[i] = structuredClone(chat[i]);
            chat[i].extra ??= {};
            chat[i].extra[IGNORE] = true;
        }
    };

}

await init();
