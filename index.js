/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-03-22T00:00:00.000Z"}
 * @version 0.9.54
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern Narrative Engine (CNZ) — autonomous background engine that
 * silently canonizes roleplay turns every N turns into three persistent
 * stores: a lorebook (structured world facts), a scenario anchor block
 * (hookseeker prose summary of active threads), and a RAG document
 * (searchable narrative memory archive uploaded as a character attachment).
 *
 * A four-step review modal lets the user inspect and correct each sync
 * cycle's output before finalizing corrections to disk. The Ledger engine
 * tracks narrative milestones via hash-chained node files, enabling the
 * Healer to detect chat branches and restore the correct world state for
 * the active timeline.
 *
 * Modal steps:
 * (1) Hooks Workshop — edit/regen the hookseeker summary, diff vs previous sync
 * (2) Lorebook Workshop — review AI suggestions, targeted generate, stage corrections
 * (3) RAG Workshop — review chunk cards, edit headers, regen individual chunks
 * (4) Finalize — confirm corrections, write only what changed, update head node
 *
 * @core-principles
 * 1. SYNC OWNS ITS COMMIT: runCnzSync writes lorebook, hooks, RAG, and ledger
 *    node to disk as its own atomic operation. The modal corrects, it does not
 *    re-commit the sync.
 * 2. MODAL STAGES ONLY: All edits in the modal mutate _draftLorebook in memory.
 *    Nothing writes to disk until the user clicks Finalize.
 *    Suggestion objects carry three mutually exclusive verdict flags (_applied,
 *    _rejected, _deleted); all three start false so every suggestion opens
 *    unresolved for user review. Deleted entries are absent from
 *    _draftLorebook.entries and are therefore not written by Finalize.
 * 3. LEDGER IS SOURCE OF TRUTH: Before-states for all modal diffs come from
 *    ledger node files, never from ephemeral sync-cycle variables.
 * 4. HEAD NODE UPDATED IN PLACE: Finalize patches the existing head node file.
 *    No new ledger node is created for modal corrections.
 * 5. ENGINE STATE SURVIVES MODAL: closeModal resets UI state only. All engine
 *    state (_ragChunks, _draftLorebook, _lorebookSuggestions, etc.) persists
 *    until character switch.
 * 6. CONTEXT MASK: The main AI prompt sees only turns above the ledger head.
 *    Older turns are replaced by the hookseeker summary and RAG chunks.
 * 
 * @docs
 *   Architecture overview:  docs/cnz_overview.md
 *   Context window spec:    docs/cnz_window_spec.md
 *   Modal spec:             docs/cnz_modal_spec.md
 *   Lorebook workshop spec: docs/cnz_lorebook_workshop_spec.md
 *   System spec:            docs/cnz_system_spec.md
 *
 * @api-declaration
 * Entry points: onWandButtonClick() (manual), onMessageReceived() (auto-sync).
 * Sync pipeline: runCnzSync(), runHealer().
 * Modal: openReviewModal(), onConfirmClick(), closeModal().
 * Ledger: fetchOrBootstrapLedger(), commitLedgerManifest(), fetchLedgerNodeFile().
 * AI calls: runLorebookSyncCall(), runHookseekerCall(), runRagClassifierCall().
 * RAG: buildRagChunks(), buildRagDocument(), ragFireChunk(), ragDrainQueue().
 * Lorebook: parseLbSuggestions(), serialiseSuggestionsToFreeform(), enrichLbSuggestions(), updateLbDiff(),
 *           deleteLbEntry(), revertLbSuggestion().
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [
 *       _lorebookData, _draftLorebook, _parentNodeLorebook,
 *       _ledgerManifest, _sessionStartId,
 *       _priorSituation, _beforeSituation,
 *       _lorebookName, _lorebookSuggestions, _lorebookDelta,
 *       _stagedProsePairs, _stagedPairOffset, _splitPairIdx,
 *       _ragChunks, _splitIndexWhenRagBuilt, _lastSummaryUsedForRag,
 *       _lastRagUrl, _ragGlobalGenId, _ragInFlightCount, _ragCallQueue,
 *       _syncInProgress, _cnzGenerating, _snoozeUntilCount, _lastKnownAvatar,
 *       _currentStep, _hooksGenId, _lorebookGenId, _targetedGenId,
 *       _hooksLoading, _lorebookLoading, _lbActiveIngesterIndex,
 *       _lbDebounceTimer,
 *       _ragRawDetached, _pendingOrphans,
 *       extension_settings.cnz]
 *     external_io: [
 *       generateRaw, ConnectionManagerRequestService,
 *       /api/worldinfo/*, /api/characters/edit,
 *       /api/files/upload, /api/files/delete,
 *       /api/chats/saveChat] 
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, eventSource, event_types, callPopup, chat_metadata } from '../../../../script.js';
import { extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { updateWorldInfoList } from '../../../../scripts/world-info.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { buildModalHTML, buildPromptModalHTML, buildSettingsHTML, buildLedgerInspectorHTML, buildOrphanModalHTML } from './ui.js';

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

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME            = 'cnz';
const DEFAULT_CONCURRENCY = 3;
const HOOKS_START         = '<!-- Current Scenario State -->';
const HOOKS_END           = '<!--  -->';

const DEFAULT_LOREBOOK_SYNC_PROMPT = `
[SYSTEM: TASK — LOREBOOK CURATOR]
You are reviewing a session transcript and the current lorebook entries for a character.
Your job is to suggest targeted updates to existing entries and identify new concepts
that warrant a lorebook entry.

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by
  the transcript, output an UPDATE block.
- For each new person, place, faction, item, or recurring concept introduced in the
  transcript that does NOT already have an entry, output a NEW block.
- Keep entries concise (2–6 sentences). Write in third-person present tense.
- Keys: the most natural words a reader would search for (lowercase, 2–5 keys per entry).
- If no changes are needed, output exactly: NO CHANGES NEEDED

### OUTPUT FORMAT — use exactly this structure for each suggestion:

**UPDATE: [Exact Entry Name to Match]**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this entry — write the complete entry, not just the changed part.]
*Reason: One sentence explaining what changed and why.*

**NEW: [Suggested Entry Name]**
Keys: keyword1, keyword2
[Full content for this new entry.]
*Reason: One sentence explaining why this warrants a new entry.*
`;

const DEFAULT_HOOKSEEKER_PROMPT = `
[SYSTEM: TASK — NARRATIVE CHRONICLER]
Analyze the TRANSCRIPT below and write a concise (150–300 word) present-tense summary
of: active plot threads, unresolved tensions, immediate threats or stakes, and current
character emotional states and intentions.

Constraints:
- No preamble. No "This is a summary." No bullet points.
- Write as flowing narrative prose in present tense.
- Focus on what is actively unresolved or in motion — not what has been settled.

TRANSCRIPT:
{{transcript}}
`;

const DEFAULT_RAG_CLASSIFIER_PROMPT = `
You are a precise Narrative Memory Classifier.

Output rules — follow exactly, no exceptions:
- Output ONLY the 2–3 sentence header text in present tense.
- No quotes. No final punctuation. No explanations. No other text at all.
- Capture ONLY the core dramatic event, revelation, confrontation, decision, or emotional shift in the TARGET TURNS.
- Ignore any history and global summary except as loose context.

Focus priority:
- Most significant narrative moment only
- Present tense, concise (2–3 sentences max)

Example:
TARGET TURNS: [character finds hidden letter] [reads it] [gasps] "It was you all along."
Header: The protagonist discovers undeniable proof of betrayal in the hidden letter. Shock and realization hit as the truth becomes clear

GLOBAL CHAPTER SUMMARY (context only — do NOT classify):
{{summary}}

{{#if history}}
PRECEDING TURNS (context only — do NOT classify):
{{history}}

{{/if}}
TARGET TURNS:
{{target_turns}}
`;

const DEFAULT_TARGETED_UPDATE_PROMPT = `
[SYSTEM: TASK — NARRATIVE FACT UPDATER]
You are maintaining a persistent world knowledge base for an ongoing roleplay narrative.
A knowledge record for the concept below already exists. Your job is to revise it to
reflect new information revealed in the transcript, producing a single complete,
up-to-date record.

A knowledge record captures durable, referenceable facts about a person, place, object,
faction, or recurring concept — the current state of the story world as understood at
this point in the narrative. Write in third-person present tense. Be concise and
specific: 2–6 sentences.

CONCEPT: {{entry_name}}
CURRENT KEYS: {{entry_keys}}

CURRENT RECORD:
{{entry_content}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- Write the record as a single complete replacement — not a patch or addendum.
- Integrate old and new information into one coherent, present-tense account.
- Where the transcript contradicts the existing record, trust the transcript.
- Where the transcript adds new detail, incorporate it naturally.
- Where the existing record covers things the transcript does not touch, preserve them.
- Keep search keys unless the transcript clearly warrants adding or removing one.
- If the transcript contains no new information relevant to this concept, output exactly:
  NO CHANGES NEEDED

### OUTPUT FORMAT:

**UPDATE: {{entry_name}}**
Keys: keyword1, keyword2, keyword3
[Full replacement content for this record.]
`;

const DEFAULT_TARGETED_NEW_PROMPT = `
[SYSTEM: TASK — NARRATIVE FACT EXTRACTOR]
You are maintaining a persistent world knowledge base for an ongoing roleplay narrative.
Your job is to write a single, focused knowledge record for the concept identified below,
drawn entirely from what the transcript reveals.

A knowledge record captures durable, referenceable facts about a person, place, object,
faction, or recurring concept — things a reader would need to know to understand the
current state of the story world. Write in third-person present tense. Be concise and
specific: 2–6 sentences. Do not speculate beyond what the transcript supports.

CONCEPT: {{entry_name}}

SESSION TRANSCRIPT:
{{transcript}}

SEARCH KEYS: Choose 2–5 lowercase words or short phrases that a reader would naturally
think of when looking for this concept. Prefer the most recognisable name or label for
the thing, plus meaningful aliases or related terms. Avoid generic words that would match
many entries (e.g. "character", "place", "important").

If the transcript contains no meaningful information about this concept, output exactly:
NO INFORMATION FOUND

### OUTPUT FORMAT:

**NEW: {{entry_name}}**
Keys: keyword1, keyword2
[Full content for this record.]
`;

// Profile-level configuration keys — saved per profile, loaded into activeState.
// Meta-state keys (lastLorebookSyncAt, ledgerPaths, profiles, currentProfileName,
// activeState) live at the root of extension_settings[EXT_NAME] and are never
// included in a profile object.
const PROFILE_DEFAULTS = Object.freeze({
    chunkEveryN:              20,
    gapSnoozeTurns:           5,
    hookseekerHorizon:        70,
    autoSync:                 true,
    profileId:                null,
    // Summary / Lorebook
    liveContextBuffer:        5,
    lorebookSyncStart:        'syncTurn',   // 'syncTurn' | 'lastSync'
    lorebookSyncPrompt:       DEFAULT_LOREBOOK_SYNC_PROMPT,
    hookseekerPrompt:         DEFAULT_HOOKSEEKER_PROMPT,
    hookseekerTrailingPrompt: '',
    // Rolling trim
    autoAdvanceMask:          false,
    ledgerMaxNodes:           0,    // 0 = keep all; >0 = prune to N most recent nodes on each sync
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
let _ledgerManifest = null;  // in-memory manifest fetched/bootstrapped on demand
let _sessionStartId = null;  // headNodeId captured at session start
let _sessionHeadEditToken = null;  // editToken of head node file at lock-check time

// Concurrency guard — prevents overlapping syncs
let _syncInProgress = false;

// Set to true while CNZ itself drives a generateWithProfile/generateRaw call so
// the CHAT_COMPLETION_PROMPT_READY handler knows to skip the context mask.
let _cnzGenerating = false;

// Large-gap snooze — suppress the top-up offer until this non-system count is exceeded
let _snoozeUntilCount = 0;

// Healer tracking — updated on CHAT_CHANGED
let _lastKnownAvatar = null;

// ─── Engine State ──────────────────────────────────────────────────────────────
// Variables required by preserved infrastructure functions.
// Active management begins in Phase 2+.

let _lorebookName          = '';
let _lorebookSuggestions   = [];
let _ragChunks             = [];
let _ragGlobalGenId        = 0;
let _ragInFlightCount      = 0;
let _ragCallQueue          = [];
let _stagedProsePairs      = [];
let _stagedPairOffset      = 0;   // pairs preceding _stagedProsePairs[0] in the full chat
let _lastSummaryUsedForRag = null;
let _splitPairIdx          = 0;

// Ledger node fields — set each sync cycle
let _chapterName   = '';
let _lastRagUrl    = '';
let _lorebookDelta = null;
let _baseScenario   = '';
let _priorSituation  = '';
let _beforeSituation = '';  // hooks text from before the last sync
                             // read from parent node's state.hooks in openReviewModal
                             // never set by runCnzSync
let _parentNodeLorebook = null;  // lorebook snapshot from parent node — diff baseline
                                  // set in runCnzSync and openReviewModal, read by updateLbDiff

// Orphan check state — set by checkOrphans(), read by openOrphanModal()
let _pendingOrphans = [];

// ─── Modal Session State ──────────────────────────────────────────────────────
// Cleared by closeModal(). Kept separate from engine state so modal open/close
// does not disrupt background sync cycles.

let _currentStep             = 1;    // active wizard step (1–4)
let _hooksGenId              = 0;    // incremented each regen call; stale callbacks self-discard
let _hooksLoading            = false;
let _lorebookGenId           = 0;
let _lorebookLoading         = false;
let _lbActiveIngesterIndex   = 0;
let _lbDebounceTimer         = null;
let _ragRawDetached          = false;
let _splitIndexWhenRagBuilt  = null;  // _splitPairIdx at last chunk build; null = not built
let _targetedGenId           = 0;     // stale-callback guard for targeted generate calls

// ─── Settings ─────────────────────────────────────────────────────────────────

/** Returns the active profile configuration. The engine always reads from here. */
function getSettings() {
    return extension_settings[EXT_NAME].activeState;
}

/** Returns the root settings object (profiles dict, meta-state, ledger paths). */
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
        // Meta-state keys (lastLorebookSyncAt, ledgerPaths) are not in
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

    // Ensure meta-state keys are always present at root.
    root.lastLorebookSyncAt ??= null;
    root.ledgerPaths        ??= {};
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
 * Computes a SHA-256 hash that chains a message's content, its index, and
 * the previous node's hash. Used by the Healer to detect timeline branches.
 * @param {object[]} messages    Full chat message array.
 * @param {number}   turnIndex   Index of the message to hash.
 * @param {string|null} prevHash Hash of the preceding Ledger node, or null.
 * @returns {Promise<string>}    Hex-encoded SHA-256 digest.
 */
async function hashMilestone(messages, turnIndex, prevHash) {
    const raw = messages[turnIndex]?.mes + String(turnIndex) + (prevHash ?? '');
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(raw));
    return Array.from(new Uint8Array(buf))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

/**
 * Returns the index in `messages` of the Nth non-system message (1-based),
 * or -1 if the chat does not contain that many non-system messages.
 * @param {object[]} messages
 * @param {number}   nonSystemCount  1-based target count.
 * @returns {number}
 */
function findMessageIndexAtCount(messages, nonSystemCount) {
    let count = 0;
    for (let i = 0; i < messages.length; i++) {
        if (!messages[i].is_system) count++;
        if (count === nonSystemCount) return i;
    }
    return -1;
}

function interpolate(template, vars) {
    // Process {{#if key}}...{{/if}} blocks first
    let result = template.replace(
        /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
        (_, key, inner) => (vars[key] ? inner : ''),
    );
    // Then substitute {{variable}} tokens
    result = result.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
    return result;
}

// ─── Scenario Anchor Management ───────────────────────────────────────────────

/**
 * Returns the text between the CNZ hooks anchor comments, or null if absent.
 * Pure function — no side effects.
 * @param {string} scenarioText
 * @returns {string|null}
 */
function extractHookseekerBlock(scenarioText) {
    const start = scenarioText.indexOf(HOOKS_START);
    const end   = scenarioText.indexOf(HOOKS_END);
    if (start === -1 || end === -1 || end <= start) return null;
    return scenarioText.slice(start + HOOKS_START.length, end);
}

/**
 * Replaces the content between the CNZ hooks anchor comments with `newContent`.
 * If the anchors are absent, appends them (with two newlines of separation) to the
 * end of `scenarioText`. Returns the full updated scenario string.
 * Pure function — no side effects.
 * @param {string} scenarioText
 * @param {string} newContent
 * @returns {string}
 */
function writeHookseekerBlock(scenarioText, newContent) {
    const start = scenarioText.indexOf(HOOKS_START);
    const end   = scenarioText.indexOf(HOOKS_END);
    if (start !== -1 && end !== -1 && end > start) {
        return (
            scenarioText.slice(0, start + HOOKS_START.length) +
            '\n' + newContent.trim() + '\n' +
            scenarioText.slice(end)
        );
    }
    const sep = scenarioText.length > 0 ? '\n\n' : '';
    return scenarioText + sep + HOOKS_START + '\n' + newContent.trim() + '\n' + HOOKS_END;
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
 *   2. Generation IDs gate every async callback; stale results are silently dropped.
 * @api-declaration
 *   buildRagChunks, buildRagDocument, ragFireChunk, ragDrainQueue,
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
 * @param {Array} ragChunks
 * @returns {string}
 */
const DEFAULT_SEPARATOR = 'Chunk {{chunk_number}} ({{turn_range}})';

function buildRagDocument(ragChunks) {
    if (!ragChunks.length) return '';
    const settings    = getSettings();
    const contents    = settings.ragContents    ?? 'summary+full';
    const sepTemplate = settings.ragSeparator?.trim() || DEFAULT_SEPARATOR;
    const ctx         = SillyTavern.getContext();
    const charName    = ctx?.characters?.[ctx?.characterId]?.name ?? '';

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
 * @param {Array} pairs
 * @returns {Array}
 */
function buildRagChunks(pairs, pairOffset = 0) {
    // Exclude user-only pairs (no AI response yet) — they produce empty RAG chunks
    // that confuse the classifier with a stimulus and no reply.
    // Note: filtering here shifts turn indices for any pair that follows a removed one,
    // which would misalign chunk turn labels. In practice user-only pairs only appear at
    // the trailing edge of an active conversation (buildProsePairs never produces them
    // mid-sequence), so no label misalignment occurs.
    pairs = pairs.filter(p => p.messages.length > 0);
    const chunks    = [];
    const settings  = getSettings();
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
                genId:   0,
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
                genId:   0,
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
    const queuePos   = _ragCallQueue.indexOf(chunkIndex);
    const queueText  = queuePos >= 0 ? `queued ${queuePos + 1}` : 'pending';
    const disabled   = isInFlight || _ragRawDetached;

    $card.attr('data-status', chunk.status);
    const $header = $card.find('.cnz-rag-card-header').val(chunk.header).prop('disabled', disabled);
    autoResizeRagCardHeader($header[0]);
    $card.find('.cnz-rag-card-spinner').toggleClass('cnz-hidden', !isInFlight);
    $card.find('.cnz-rag-queue-label').toggleClass('cnz-hidden', !isPending).text(queueText);
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
function resolveClassifierHistory(pairStart, historyN, fullPairs) {
    if (historyN <= 0) return '';

    // Absolute index of chunk.pairStart in the full pair array
    const absoluteStart = _stagedPairOffset + pairStart;

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

async function ragFireChunk(chunkIndex, delayMs = 0, fullPairs = null) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;
    const localGenId       = ++chunk.genId;
    const globalGenId      = _ragGlobalGenId;
    const summaryAtCall    = _lastSummaryUsedForRag;

    chunk.status = 'in-flight';
    _ragInFlightCount++;
    renderRagCard(chunkIndex);

    try {
        if (delayMs > 0) {
            await new Promise(r => setTimeout(r, delayMs));
            if (_ragGlobalGenId !== globalGenId || chunk.genId !== localGenId) return;
        }

        const pairStart    = chunk.pairStart ?? chunkIndex;
        const pairEnd      = chunk.pairEnd   ?? (pairStart + 1);
        const targetPairs  = _stagedProsePairs.slice(pairStart, Math.min(pairEnd, _splitPairIdx));

        if (targetPairs.length === 0) {
            console.warn(`[CNZ] RAG chunk ${chunkIndex} (${chunk.turnRange}) — classifier received no turns (pairStart=${pairStart} pairEnd=${pairEnd} splitPairIdx=${_splitPairIdx}); aborting`);
            chunk.status = 'pending';
            return;
        }

        const historyN   = getSettings().ragClassifierHistory ?? 0;
        const pairs      = fullPairs ?? buildProsePairs(SillyTavern.getContext().chat ?? []);
        const historyStr = resolveClassifierHistory(pairStart, historyN, pairs);

        const maxRetries = getSettings().ragMaxRetries ?? 1;
        let header;
        let lastErr;
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            if (_ragGlobalGenId !== globalGenId || chunk.genId !== localGenId) return;
            try {
                header = await runRagClassifierCall(summaryAtCall, targetPairs, historyStr);
                lastErr = null;
                break;
            } catch (err) {
                lastErr = err;
            }
        }
        if (lastErr) throw lastErr;

        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        if (globalStale || localStale) return;

        if (_lastSummaryUsedForRag !== summaryAtCall) {
            chunk.status = 'stale';
        } else {
            chunk.header = header.trim() || chunk.turnRange;
            chunk.status = 'complete';
            writeChunkHeaderToChat(chunkIndex).catch(err =>
                console.error('[CNZ] writeChunkHeaderToChat error:', err),
            );
        }
    } catch (err) {
        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        console.error(`[CNZ-DBG] ragFireChunk ERROR chunk=${chunkIndex} globalStale=${globalStale} localStale=${localStale} inFlight=${_ragInFlightCount}`, err);
        if (err.cause) console.error(`[CNZ-DBG] ragFireChunk ERROR cause:`, err.cause);
        if (globalStale || localStale) return;
        chunk.status = 'pending';
    } finally {
        const globalStale = _ragGlobalGenId !== globalGenId;
        if (!globalStale) {
            _ragInFlightCount = Math.max(0, _ragInFlightCount - 1);
            ragDrainQueue();
        }
    }

    if (_ragGlobalGenId === globalGenId) {
        renderRagCard(chunkIndex);
        renderChunkChatLabel(chunkIndex);
    }
}

/**
 * Fires queued chunks up to the maxConcurrentCalls limit.
 */
function ragDrainQueue() {
    const max       = getSettings().maxConcurrentCalls ?? DEFAULT_CONCURRENCY;
    const messages  = SillyTavern.getContext().chat ?? [];
    const fullPairs = buildProsePairs(messages);
    let staggerIdx  = 0;
    while (_ragInFlightCount < max && _ragCallQueue.length > 0) {
        const idx = _ragCallQueue.shift();
        ragFireChunk(idx, (staggerIdx + 1) * 500, fullPairs);
        staggerIdx++;
    }
}

/**
 * Polls until all _ragChunks have left the 'in-flight' state, or timeoutMs elapses.
 * Marks timed-out in-flight chunks as 'pending' so the next sync can retry them.
 * @param {number} timeoutMs
 */
async function waitForRagChunks(timeoutMs = 120_000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (_ragChunks.every(c => c.status !== 'in-flight')) return;
        await new Promise(r => setTimeout(r, 300));
    }
    for (const c of _ragChunks) {
        if (c.status === 'in-flight') c.status = 'pending';
    }
    console.warn(`[CNZ] RAG chunk wait timed out after ${timeoutMs}ms — some chunks may be incomplete`);
}

/**
 * Builds and fires the prompt for a single RAG classification call.
 * @param {string} summaryText
 * @param {Array}  targetPairs
 * @returns {Promise<string>}
 */
async function runRagClassifierCall(summaryText, targetPairs) {
    // If summaryText is empty/undefined, DON'T BAIL. 
    // Provide a generic context so the AI can still classify.
    const safeSummary = summaryText || "Continuing the previous scene.";
    
    const prompt = interpolate(getSettings().ragClassifierPrompt, {
        summary: safeSummary, // Never empty
        target_turns: formatPairs(targetPairs),
    });
    
    return generateWithRagProfile(prompt);
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
 *   runHookseekerCall, runRagClassifierCall, runTargetedLbCall
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

async function generateWithProfile(prompt, maxTokens = null) {
    _cnzGenerating = true;
    try {
        const profileId = getSettings().profileId;
        if (profileId) {
            const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens);
            return result.content;
        }
        return generateRaw({ prompt, trimNames: false, responseLength: maxTokens });
    } finally {
        _cnzGenerating = false;
    }
}

/**
 * Like generateWithProfile but uses the RAG-specific connection profile.
 * Capped at ragMaxTokens to prevent runaway outputs.
 */
async function generateWithRagProfile(prompt) {
    const ragMaxTokens = getSettings().ragMaxTokens ?? 100;
    const ragProfileId = getSettings().ragProfileId;
    if (ragProfileId) {
        const result = await ConnectionManagerRequestService.sendRequest(ragProfileId, prompt, ragMaxTokens);
        return result.content;
    }
    return generateWithProfile(prompt, ragMaxTokens);
}

/**
 * Fires the Lorebook Sync AI call.
 * @param {string}      transcript  Prose transcript to analyse.
 * @param {object|null} lorebook    Lorebook state to use as context. Defaults to `_lorebookData` if null.
 * @returns {Promise<string>}
 */
async function runLorebookSyncCall(transcript, lorebook = null) {
    const prompt = interpolate(getSettings().lorebookSyncPrompt || DEFAULT_LOREBOOK_SYNC_PROMPT, {
        lorebook_entries: formatLorebookEntries(lorebook ?? _lorebookData),
        transcript,
    });
    return generateWithProfile(prompt);
}

/**
 * Fires the Hookseeker AI call.
 * @param {string} transcript
 * @returns {Promise<string>}
 */
async function runHookseekerCall(transcript, prevSummary = '') {
    const s = getSettings();
    let prompt = interpolate(s.hookseekerPrompt || DEFAULT_HOOKSEEKER_PROMPT, {
        transcript,
        prev_summary: prevSummary,
    });
    const trailing = (s.hookseekerTrailingPrompt ?? '').trim();
    if (trailing) prompt = prompt + '\n\n' + trailing;
    return generateWithProfile(prompt);
}

/**
 * Fires a targeted lorebook AI call for a single entry (update or new).
 * @param {'update'|'new'} mode
 * @param {string} entryName     Entry name or freeform keyword.
 * @param {string} entryKeys     Comma-separated existing keys (empty string for new).
 * @param {string} entryContent  Existing entry content (empty string for new).
 * @param {string} transcript    Sync-window transcript.
 * @returns {Promise<string>}    Raw AI output block.
 */
async function runTargetedLbCall(mode, entryName, entryKeys, entryContent, transcript) {
    const s = getSettings();
    const template = mode === 'update'
        ? (s.targetedUpdatePrompt || DEFAULT_TARGETED_UPDATE_PROMPT)
        : (s.targetedNewPrompt    || DEFAULT_TARGETED_NEW_PROMPT);
    const prompt = interpolate(template, {
        entry_name:    entryName,
        entry_keys:    entryKeys,
        entry_content: entryContent,
        transcript,
    });
    return generateWithProfile(prompt);
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
 *   patchCharacterScenario, uploadRagFile, registerCharacterAttachment,
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
 * enriching suggestions with ledger-diff context, diffing entry content,
 * and constructing new draft entries from canonical defaults.
 * @core-principles
 *   1. All functions here are pure or operate only on the passed-in draft object.
 *   2. No fetch calls, no engine state reads — callers supply all inputs.
 * @api-declaration
 *   parseLbSuggestions, enrichLbSuggestions, deriveSuggestionsFromLedgerDiff,
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
 * entirely from ledger node data — no ephemeral sync-cycle variables needed.
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
function deriveSuggestionsFromLedgerDiff(before, after) {
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
async function patchCharacterScenario(char, newScenario) {
    const formData = new FormData();
    formData.append('ch_name',                   char.name);
    formData.append('description',               char.description                      ?? '');
    formData.append('personality',               char.personality                      ?? '');
    formData.append('scenario',                  newScenario);
    formData.append('first_mes',                 char.first_mes                        ?? '');
    formData.append('mes_example',               char.mes_example                      ?? '');
    formData.append('creator_notes',             char.data?.creator_notes              ?? '');
    formData.append('system_prompt',             char.data?.system_prompt              ?? '');
    formData.append('post_history_instructions', char.data?.post_history_instructions  ?? '');
    //formData.append('tags', char.tags ?? []);
    formData.append('creator',                   char.data?.creator                    ?? '');
    formData.append('character_version',         char.data?.character_version          ?? '');
    //formData.append('alternate_greetings', char.data?.alternate_greetings ?? []);
    formData.append('json_data',                 JSON.stringify(char));
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
    if (!res.ok) throw new Error(`Scenario patch failed (HTTP ${res.status})`);
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
 * Uploads content to the ST Data Bank. Accepts a string or an object (JSON-serialised).
 * Returns the client-relative path as returned by the upload API.
 * @param {string}        filename   Already-safe filename (from cnzFileName).
 * @param {string|object} content    Text content or JSON-serialisable object.
 * @returns {Promise<string>}        Stored path for use with cnzDeleteFile.
 */
async function cnzUploadFile(filename, content) {
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: filename, data: utf8ToBase64(text) }),
    });
    if (!res.ok) throw new Error(`[CNZ] File upload failed (HTTP ${res.status}): ${filename}`);
    const json = await res.json();
    if (!json.path) throw new Error(`[CNZ] File upload returned no path: ${filename}`);
    // Register in knownFiles registry for orphan check
    const meta = getMetaSettings();
    if (!meta.knownFiles) meta.knownFiles = [];
    if (!meta.knownFiles.includes(json.path)) meta.knownFiles.push(json.path);
    saveSettingsDebounced();
    return json.path;
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
 * Derives the fetch URL for a CNZ node file given the manifest's stored path.
 * All CNZ files share the same directory; only the filename differs.
 * @param {string} manifestPath  Path stored in ledgerPaths[avatarKey], e.g. "user_data/files/cnz_x_manifest.json"
 * @param {string} avatarKey     Raw avatar filename (will be sanitised internally).
 * @param {string} nodeId        UUID of the target node.
 * @returns {string}             Derived fetch URL for the node file.
 */
function cnzNodeFilePath(manifestPath, avatarKey, nodeId) {
    const lastSlash = manifestPath.lastIndexOf('/');
    const baseDir   = lastSlash >= 0 ? manifestPath.slice(0, lastSlash + 1) : '';
    return baseDir + cnzFileName(cnzAvatarKey(avatarKey), 'node', nodeId);
}

/**
 * @section Narrative Ledger Engine
 * @architectural-role Manifest and Node Lifecycle
 * @description
 * Owns the manifest and node file lifecycle. Fetches and bootstraps the
 * chain index on first use, commits updated manifests after each sync,
 * and fetches individual node files by hash for modal diff and Healer
 * restoration. The manifest is a small chain index with no state data;
 * node files are full world-state snapshots written once per sync.
 * @core-principles
 *   1. Node files are write-once — never mutated after the sync that created them.
 *   2. The manifest is the only mutable ledger artifact; it is patched in place by Finalize.
 * @api-declaration
 *   fetchOrBootstrapLedger, verifyFreshnessLock, buildLedgerNode,
 *   commitLedgerManifest, fetchLedgerNodeFile
 * @contract
 *   assertions:
 *     external_io: [/api/files/upload, /api/files/delete]
 */
// ─── Narrative Ledger Engine ──────────────────────────────────────────────────

/**
 * Returns the sanitized Data Bank filename for a given character avatar key.
 * @param {string} avatarKey  e.g. "seraphina.png"
 * @returns {string}          e.g. "cnz_ledger_seraphina.png.json"
 */
function ledgerFileName(avatarKey) {
    const safe = avatarKey.replace(/[^A-Za-z0-9_\-.]/g, '_');
    return `cnz_ledger_${safe}.json`;
}

/**
 * Fetches the ledger manifest for `avatarKey` or bootstraps a fresh empty one.
 * Detects and purges the old monolithic format (nodes with snapshot.lorebookDelta).
 * Sets `_ledgerManifest` and `_sessionStartId`.
 * @param {string} avatarKey  Raw avatar filename (e.g. "seraphina.png").
 */
async function fetchOrBootstrapLedger(avatarKey) {
    const storedPath = (getMetaSettings().ledgerPaths ?? {})[avatarKey];
    if (storedPath) {
        try {
            const res = await fetch(storedPath);
            if (res.ok) {
                const manifest = await res.json();

                // ── Old-format detection: nodes embedded snapshot.lorebookDelta ──
                // Delta data cannot be promoted to full snapshots without the
                // baseline lorebook at each historical commit — purge and restart.
                const isOldFormat = manifest.nodes &&
                    Object.values(manifest.nodes).some(n => n.snapshot?.lorebookDelta !== undefined);
                if (isOldFormat) {
                    console.warn('[CNZ] Old ledger format detected (lorebookDelta) — purging and restarting.');
                    await cnzDeleteFile(storedPath);
                    delete getMetaSettings().ledgerPaths[avatarKey];
                    saveSettingsDebounced();
                    // fall through to bootstrap below
                } else {
                    _ledgerManifest = manifest;
                    _sessionStartId = manifest.headNodeId;
                    return;
                }
            }
        } catch (_) { /* fall through to bootstrap */ }
    }
    _ledgerManifest = {
        storyId:   crypto.randomUUID(),
        headNodeId: null,
        avatarKey:  cnzAvatarKey(avatarKey),
        charName:   '',
        nodes:      {},
    };
    _sessionStartId = null;
}

/**
 * Re-fetches the ledger and compares its `headNodeId` against `_sessionStartId`.
 * Returns null on success, or a human-readable error string on failure.
 * @param {string} avatarKey
 * @returns {Promise<null|string>}
 */
async function verifyFreshnessLock(avatarKey) {
    const storedPath = (getMetaSettings().ledgerPaths ?? {})[avatarKey];
    if (!storedPath) {
        return _sessionStartId === null
            ? null
            : 'Ledger path is missing but a session ID exists — state is inconsistent. Try reloading the page.';
    }
    try {
        const res = await fetch(storedPath);
        if (!res.ok) return `Ledger manifest file not found (HTTP ${res.status}). The Data Bank file may have been deleted. Try Settings → Canonize → Reset Ledger.`;
        const freshManifest = await res.json();
        if (freshManifest.headNodeId !== _sessionStartId) return 'A sync committed while this modal was open. Close and re-open to retry.';
        _ledgerManifest = freshManifest;
        // Also capture the head node's editToken so step 4 can detect
        // concurrent in-place writes that don't change headNodeId.
        if (freshManifest.headNodeId) {
            const headNode = await fetchLedgerNodeFile(avatarKey, freshManifest.headNodeId);
            if (!headNode) return 'Head ledger node file not found. The Data Bank may be incomplete. Try Settings → Canonize → Reset Ledger.';
            _sessionHeadEditToken = headNode.editToken ?? null;
        } else {
            _sessionHeadEditToken = null;
        }
        return null;
    } catch (err) {
        return `Could not read the ledger manifest: ${err.message}`;
    }
}

/**
 * Constructs a new LedgerNode with the full world-state snapshot for this sync.
 * The node is written to its own file by commitLedgerManifest; it is NOT embedded
 * in the manifest. node.state.ragFiles is initialised to [] and must be set by
 * the caller (runCnzSync) after the RAG file is uploaded.
 * @param {string|null} parentNodeId
 * @param {number}      sequenceNum   trailingBufferBoundary at commit time.
 * @param {object}      _unused       Reserved for backward compat (ignored).
 * @param {string|null} milestoneHash SHA-256 chain hash, or null.
 * @returns {object}
 */
function buildLedgerNode(parentNodeId, sequenceNum, _unused, milestoneHash = null) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    return {
        nodeId:        crypto.randomUUID(),
        editToken:     crypto.randomUUID(),
        parentId:      parentNodeId,
        sequenceNum,
        milestoneHash: milestoneHash,
        committedAt:   new Date().toISOString(),
        charName:      char.name,
        chatFile:      char.chat ?? '',
        state: {
            hooks:    _priorSituation,
            lorebook: Object.assign(
                { name: _lorebookName },
                structuredClone(_draftLorebook ?? { entries: {} })
            ),
            ragFiles: [],   // populated by runCnzSync after RAG upload
        },
    };
}

/**
 * Uploads the current `_ledgerManifest` as JSON (upload-first, then deletes old).
 * When `node` is provided, also uploads the node as a separate file and adds
 * its chain summary (nodeId, parentId, sequenceNum, milestoneHash) to the
 * manifest before uploading. The caller must NOT pre-insert the node into
 * `_ledgerManifest.nodes` when passing `node` here.
 *
 * Pass `node = null` for manifest-only re-uploads (e.g. Healer rollback).
 *
 * @param {string}      avatarKey  Raw avatar filename (e.g. "seraphina.png").
 * @param {object|null} node       Full node object from buildLedgerNode, or null.
 */
async function commitLedgerManifest(avatarKey, node = null) {
    const safeKey = cnzAvatarKey(avatarKey);

    if (node) {
        // 1. Upload the node file (full state snapshot).
        const nodeFileName = cnzFileName(safeKey, 'node', node.nodeId);
        await cnzUploadFile(nodeFileName, node);

        // 2. Add only the chain summary to the manifest (no state data).
        if (!_ledgerManifest.nodes) _ledgerManifest.nodes = {};
        _ledgerManifest.nodes[node.nodeId] = {
            nodeId:        node.nodeId,
            parentId:      node.parentId,
            sequenceNum:   node.sequenceNum,
            milestoneHash: node.milestoneHash,
        };
        _ledgerManifest.headNodeId = node.nodeId;
        _ledgerManifest.charName   = node.charName;
    }

    // 3. Upload the updated manifest first — old file still exists if this throws.
    const manifestFileName = cnzFileName(safeKey, 'manifest');
    const newPath = await cnzUploadFile(manifestFileName, _ledgerManifest);

    // 4. Persist the new path before deleting old, so a crash here leaves two
    //    copies rather than zero.
    if (!getMetaSettings().ledgerPaths) getMetaSettings().ledgerPaths = {};
    const oldPath = (getMetaSettings().ledgerPaths ?? {})[avatarKey];
    getMetaSettings().ledgerPaths[avatarKey] = newPath;
    saveSettingsDebounced();

    // 5. Delete the old manifest (best-effort — safe to lose now that new is live).
    await cnzDeleteFile(oldPath);
}

/**
 * Prunes node files older than the `ledgerMaxNodes` limit.
 * Walks the chain from HEAD, keeps the newest N nodes, deletes the rest from the
 * Data Bank, removes them from the in-memory manifest, and re-uploads the manifest.
 * The oldest surviving node becomes the new chain root (parentId set to null).
 * No-op when ledgerMaxNodes is 0 or the chain is already within the limit.
 * @param {string} avatarKey  Raw avatar filename (e.g. "seraphina.png").
 * @returns {Promise<number>} Number of nodes pruned.
 */
async function pruneOldLedgerNodes(avatarKey) {
    const maxNodes = getSettings().ledgerMaxNodes ?? 0;
    if (maxNodes <= 0 || !_ledgerManifest?.nodes) return 0;

    const chain = buildNodeChain(_ledgerManifest);
    if (chain.length <= maxNodes) return 0;

    const toPrune = chain.slice(0, chain.length - maxNodes);
    const toKeep  = chain.slice(chain.length - maxNodes);

    const manifestPath = getMetaSettings().ledgerPaths?.[avatarKey];
    if (!manifestPath) return 0;
    const lastSlash = manifestPath.lastIndexOf('/');
    const baseDir   = lastSlash >= 0 ? manifestPath.slice(0, lastSlash + 1) : '';
    const safeKey   = cnzAvatarKey(avatarKey);

    for (const node of toPrune) {
        const nodePath = baseDir + cnzFileName(safeKey, 'node', node.nodeId);
        await cnzDeleteFile(nodePath);
        delete _ledgerManifest.nodes[node.nodeId];
    }

    // Sever the chain at the new root so buildNodeChain stays consistent.
    const newRootId = toKeep[0]?.nodeId;
    if (newRootId && _ledgerManifest.nodes[newRootId]) {
        _ledgerManifest.nodes[newRootId] = Object.assign(
            {}, _ledgerManifest.nodes[newRootId], { parentId: null },
        );
    }

    await commitLedgerManifest(avatarKey, null);
    console.log(`[CNZ] GC: pruned ${toPrune.length} node(s) (limit ${maxNodes}), ${toKeep.length} retained.`);
    return toPrune.length;
}

/**
 * Fetches the full node file for a given nodeId from the ST Data Bank.
 * Derives the file path from the stored manifest path + naming convention.
 * Returns null if the file cannot be fetched (missing, network error, etc.).
 * @param {string} avatarKey  Raw avatar filename (e.g. "seraphina.png").
 * @param {string} nodeId     UUID of the node to fetch.
 * @returns {Promise<object|null>}
 */
async function fetchLedgerNodeFile(avatarKey, nodeId) {
    const manifestPath = getMetaSettings().ledgerPaths?.[avatarKey];
    if (!manifestPath || !nodeId) return null;
    const nodePath = cnzNodeFilePath(manifestPath, avatarKey, nodeId);
    try {
        const res = await fetch(nodePath);
        if (!res.ok) return null;
        return await res.json();
    } catch (_) {
        return null;
    }
}

/**
 * @section Healer
 * @architectural-role Branch Detection and State Restoration
 * @description
 * Owns branch detection and state restoration. Walks the ledger hash chain
 * against the current chat to find the divergence point, then restores
 * lorebook and hooks from the last valid node and rolls the ledger head
 * back to that node. Runs automatically during onChatChanged when a
 * mismatch is detected.
 * @core-principles
 *   1. Healer never writes a new ledger node — it only rolls the head back.
 *   2. Restoration targets are always fetched from ledger node files, never from memory.
 * @api-declaration
 *   runHealer, buildNodeChain, restoreLorebookToNode, restoreHooksToNode
 * @contract
 *   assertions:
 *     external_io: [/api/worldinfo/*, /api/characters/edit, /api/files/upload, /api/files/delete]
 */
// ─── Healer Utilities ─────────────────────────────────────────────────────────

/**
 * Walks the Ledger manifest's parentId chain from head to root and returns
 * an ordered array of node objects (index 0 = root, last = head).
 * @param {object} manifest  _ledgerManifest
 * @returns {object[]}
 */
function buildNodeChain(manifest) {
    const headId = manifest.headNodeId;
    if (!headId || !manifest.nodes[headId]) return [];
    const chain = [];
    let nodeId = headId;
    while (nodeId) {
        const node = manifest.nodes[nodeId];
        if (!node) break;
        chain.unshift(node);
        nodeId = node.parentId;
    }
    return chain;
}

/**
 * Restores the lorebook to the full snapshot stored in `node.state.lorebook`.
 * Fetches the node file, writes `state.lorebook` to disk, and updates in-memory state.
 * @param {object} char  Character object (avatar key used for node file lookup).
 * @param {object} node  Chain summary entry from the ledger manifest.
 */
async function restoreLorebookToNode(char, node, nodeFile = null) {
    const nodeFile_ = nodeFile ?? await fetchLedgerNodeFile(char.avatar, node.nodeId);
    if (!nodeFile_?.state?.lorebook) throw new Error(`[CNZ] No lorebook state in node ${node.nodeId}`);
    const lbData = nodeFile_.state.lorebook;
    const lbName = lbData.name || _lorebookName;
    await lbSaveLorebook(lbName, lbData);
    _lorebookName  = lbName;
    _lorebookData  = structuredClone(lbData);
    _draftLorebook = structuredClone(lbData);
}

/**
 * Restores the character's scenario hooks block to the state stored in `node.state.hooks`.
 * Fetches the node file and writes hooks back via patchCharacterScenario.
 * @param {object} char  Character object from ST context.
 * @param {object} node  Chain summary entry from the ledger manifest.
 */
async function restoreHooksToNode(char, node, nodeFile = null) {
    const nodeFile_ = nodeFile ?? await fetchLedgerNodeFile(char.avatar, node.nodeId);
    const hooksText = nodeFile_?.state?.hooks ?? '';
    const freshCtx  = SillyTavern.getContext();
    const freshChar = freshCtx.characters.find(c => c.avatar === char.avatar);
    if (!freshChar) throw new Error('Character not found in context for hooks restoration.');
    const newScenario = writeHookseekerBlock(freshChar.scenario ?? '', hooksText);
    await patchCharacterScenario(freshChar, newScenario);
    await SillyTavern.getContext().getOneCharacter(freshChar.avatar);
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
function compileRagFromChunks() { return buildRagDocument(_ragChunks); }

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
    const queuePos   = _ragCallQueue.indexOf(i);
    const queueText  = queuePos >= 0 ? `queued ${queuePos + 1}` : 'pending';
    return `
<div class="cnz-rag-card" data-chunk-index="${i}" data-status="${chunk.status}">
  <div class="cnz-rag-card-header-row">
    <textarea class="cnz-input cnz-rag-card-header"
              data-chunk-index="${i}"
              ${isInFlight || _ragRawDetached ? 'disabled' : ''}>${escapeHtml(chunk.header)}</textarea>
    <span class="cnz-rag-card-spinner fa-solid fa-spinner fa-spin${isInFlight ? '' : ' cnz-hidden'}"></span>
    <span class="cnz-rag-queue-label${isPending ? '' : ' cnz-hidden'}">${queueText}</span>
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
    if (!chunk || !_lastSummaryUsedForRag) return;
    if (chunk.status === 'in-flight') {
        _ragInFlightCount = Math.max(0, _ragInFlightCount - 1);
    }
    _ragCallQueue = _ragCallQueue.filter(i => i !== chunkIndex);
    chunk.status  = 'pending';
    renderRagCard(chunkIndex);
    const messages  = SillyTavern.getContext().chat ?? [];
    const fullPairs = buildProsePairs(messages);
    ragFireChunk(chunkIndex, 0, fullPairs);
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

function showRagNoSummaryMessage() {
    $('#cnz-rag-no-summary').removeClass('cnz-hidden');
    $('#cnz-rag-tab-bar, #cnz-rag-tab-sectioned, #cnz-rag-tab-raw').addClass('cnz-hidden');
    $('#cnz-rag-detached-warn, #cnz-rag-detached-revert').addClass('cnz-hidden');
}

function hideRagNoSummaryMessage() {
    $('#cnz-rag-no-summary').addClass('cnz-hidden');
    $('#cnz-rag-tab-bar').removeClass('cnz-hidden');
    const activeTab = $('#cnz-rag-tab-bar .cnz-tab-active').data('tab') ?? 'sectioned';
    $('#cnz-rag-tab-sectioned').toggleClass('cnz-hidden', activeTab !== 'sectioned');
    $('#cnz-rag-tab-raw').toggleClass('cnz-hidden', activeTab !== 'raw');
}

function getRagModeLabel() {
    return 'Output: AI-classified summary + full text';
}

/**
 * Called when the user enters Step 3 (RAG Workshop). Guards against disabled RAG,
 * then renders existing `_ragChunks` or rebuilds them if the split boundary changed.
 */
/**
 * Reconstructs _stagedProsePairs, _stagedPairOffset, _splitPairIdx, _ragChunks,
 * and _splitIndexWhenRagBuilt from the ledger manifest and live chat.
 * Called when the RAG workshop is opened after a page reload with no prior sync
 * in the current session.
 *
 * Returns true if reconstruction succeeded and _ragChunks is populated.
 * Returns false if the ledger has no committed window or the chat no longer
 * contains the committed turns.
 *
 * @returns {boolean}
 */
function reconstructStagedPairsFromLedger() {
    if (!_ledgerManifest?.headNodeId) return false;

    const headChainEntry   = _ledgerManifest.nodes[_ledgerManifest.headNodeId];
    const parentChainEntry = headChainEntry?.parentId
        ? _ledgerManifest.nodes[headChainEntry.parentId]
        : null;

    const windowStart = parentChainEntry?.sequenceNum ?? 0;  // inclusive
    const windowEnd   = headChainEntry?.sequenceNum   ?? 0;  // exclusive

    if (windowEnd <= windowStart) return false;

    const messages = SillyTavern.getContext().chat ?? [];
    const allPairs = buildProsePairs(messages);

    const windowPairs = allPairs.filter(
        p => p.validIdx >= windowStart && p.validIdx < windowEnd
    );

    if (!windowPairs.length) return false;

    // Set module state
    const pairStartIdx    = allPairs.findIndex(p => p.validIdx >= windowStart);
    _stagedPairOffset     = pairStartIdx === -1 ? 0 : pairStartIdx;
    _stagedProsePairs     = windowPairs;
    _splitPairIdx         = windowPairs.length;  // all committed window pairs are archive

    // Build chunk skeleton and hydrate from chat
    _ragChunks              = buildRagChunks(windowPairs, _stagedPairOffset);
    _splitIndexWhenRagBuilt = _splitPairIdx;
    hydrateChunkHeadersFromChat();

    console.log(
        `[CNZ] RAG reconstruction: window=${windowStart}–${windowEnd} ` +
        `pairs=${windowPairs.length} chunks=${_ragChunks.length} ` +
        `complete=${_ragChunks.filter(c => c.status === 'complete').length}`,
    );

    return true;
}

function onEnterRagWorkshop() {
    if (!getSettings().enableRag) {
        $('#cnz-rag-mode-note').addClass('cnz-hidden');
        $('#cnz-rag-disabled').removeClass('cnz-hidden');
        return;
    }
    $('#cnz-rag-disabled').addClass('cnz-hidden');
    $('#cnz-rag-mode-note').text(getRagModeLabel()).removeClass('cnz-hidden');

    // ── Path 1: No staged pairs — attempt reconstruction ─────────────────────
    if (_stagedProsePairs.length === 0) {
        const ok = reconstructStagedPairsFromLedger();
        if (!ok) {
            toastr.warning('CNZ: No prior sync found — run a sync before opening the workshop.');
            showRagNoSummaryMessage();
            return;
        }
        // Reconstruction succeeded — _ragChunks is now populated and hydrated.
        // Fall through to the shared classification path below.
    }

    // ── Path 2: Staged pairs exist — check if chunk rebuild is needed ─────────
    if (_ragChunks.length === 0) {
        const archivePairs = _stagedProsePairs.slice(0, _splitPairIdx);
        if (!archivePairs.length) {
            showRagNoSummaryMessage();
            return;
        }
        _ragChunks              = buildRagChunks(archivePairs, _stagedPairOffset);
        _splitIndexWhenRagBuilt = _splitPairIdx;
        hydrateChunkHeadersFromChat();
    } else if (_splitPairIdx !== _splitIndexWhenRagBuilt) {
        toastr.warning('Sync window has changed — Narrative Memory chunks will be rebuilt.');
        const archivePairs      = _stagedProsePairs.slice(0, _splitPairIdx);
        _ragChunks              = buildRagChunks(archivePairs, _stagedPairOffset);
        _splitIndexWhenRagBuilt = _splitPairIdx;
        hydrateChunkHeadersFromChat();
    }

    // ── Shared: Render workshop UI ────────────────────────────────────────────
    renderRagWorkshop();
    renderAllChunkChatLabels();

    // Restore raw tab if active
    const activeTab = $('#cnz-rag-tab-bar .cnz-tab-active').data('tab') ?? 'sectioned';
    if (activeTab === 'raw' && !_ragRawDetached) {
        $('#cnz-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }

    // ── Shared: Summary change detection and classification ───────────────────
    // _lastSummaryUsedForRag is seeded from the ledger head in openReviewModal
    // so it is available even after a page reload.
    if (!_lastSummaryUsedForRag) {
        showRagNoSummaryMessage();
        return;
    }
    hideRagNoSummaryMessage();

    // Detect summary change since last classification
    const currentSummary = $('#cnz-situation-text').val().trim();
    if (currentSummary && currentSummary !== _lastSummaryUsedForRag) {
        toastr.warning('Hooks text has changed — stale headers will be refreshed.');
        for (const chunk of _ragChunks) {
            if (chunk.status === 'complete') chunk.status = 'stale';
        }
        _lastSummaryUsedForRag = currentSummary;
    } else if (currentSummary) {
        _lastSummaryUsedForRag = currentSummary;
    }
    // If textarea is empty (step 1 not yet visited this session),
    // _lastSummaryUsedForRag retains its ledger-seeded value — correct.

    // If all chunks are already complete (or manual), nothing left to do.
    if (_ragChunks.every(c => c.status === 'complete' || c.status === 'manual')) return;

    // Enqueue pending and stale chunks
    _ragCallQueue = [];
    for (let i = 0; i < _ragChunks.length; i++) {
        const s = _ragChunks[i].status;
        if (s === 'pending' || s === 'stale') _ragCallQueue.push(i);
    }
    ragDrainQueue();
}

function onLeaveRagWorkshop() {
    _ragCallQueue = [];
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
 *   2. Diff is always computed against the ledger node's before-state, never against a local variable.
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
 * @param {number} horizonTurns  Number of trailing turns to include.
 * @returns {string}
 */
function buildSyncWindowTranscript(horizonTurns) {
    const settings = getSettings();
    const messages = SillyTavern.getContext().chat ?? [];
    const allPairs = buildProsePairs(messages);
    
    // Window logic: Head -> (Total - Buffer)
    const lcb = settings.liveContextBuffer ?? 5;
    const totalNS = messages.filter(m => !m.is_system).length;
    const tbb = Math.max(0, totalNS - lcb);

    let windowPairs = allPairs.filter(p => p.validIdx < tbb);

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
    const hooksId    = ++_hooksGenId;
    const horizon    = getSettings().hookseekerHorizon ?? 70;
    const transcript = buildSyncWindowTranscript(horizon);
    runHookseekerCall(transcript, _priorSituation)
        .then(text => {
            if (_hooksGenId !== hooksId) return;
            const trimmed = text.trim();
            _priorSituation = trimmed;
            $('#cnz-situation-text').val(trimmed);
            $('#cnz-hooks-new-display').text(trimmed);
            updateHooksDiff();
            setHooksLoading(false);
            onHooksTabSwitch('workshop');
        })
        .catch(err => {
            if (_hooksGenId !== hooksId) return;
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

// populateLbFreeform — kept for call-site safety; freeform is now always driven by syncFreeformFromSuggestions.
function populateLbFreeform(_text) {
    setLbLoading(false);
    syncFreeformFromSuggestions();
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
    const confirmed = await callPopup(
        'This will run a fresh lorebook AI call and rebuild the suggestion list from scratch, resetting to the parent node baseline and discarding any corrections or previously committed lorebook changes made in this session. Continue?',
        'confirm',
    );
    if (!confirmed) return;

    setLbLoading(true);
    $('#cnz-lb-error').addClass('cnz-hidden').text('');

    // preSyncLorebook = parent node's lorebook (the baseline the AI ran against).
    // Fetch from ledger — stable across modal opens, no ephemeral delta needed.
    let preSyncLorebook = null;
    try {
        const ctx              = SillyTavern.getContext();
        const char             = ctx?.characters?.[ctx?.characterId];
        const headChainEntry   = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
        if (headChainEntry && char) {
            const headNodeFile = await fetchLedgerNodeFile(char.avatar, headChainEntry.nodeId);
            const parentId     = headNodeFile?.parentId ?? null;
            if (parentId) {
                const parentNodeFile = await fetchLedgerNodeFile(char.avatar, parentId);
                preSyncLorebook      = parentNodeFile?.state?.lorebook ?? null;
            }
        }
    } catch (err) {
        console.warn('[CNZ] onLbRegenClick: could not fetch parent node for baseline:', err);
        showLbError('Lorebook baseline fetch failed — regenerating against cached pre-sync state. Results may be inaccurate.');
    }
    // Prefer _parentNodeLorebook (set by openReviewModal from the same ledger chain) over
    // _lorebookData, which already reflects the post-sync head and is the wrong baseline.
    preSyncLorebook ??= _parentNodeLorebook ? structuredClone(_parentNodeLorebook) : structuredClone(_lorebookData ?? { entries: {} });

    const lbId       = ++_lorebookGenId;
    const horizon    = getSettings().chunkEveryN ?? 20;
    const upToLatest = $('#cnz-lb-up-to-latest').is(':checked');
    const transcript = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon);
    runLorebookSyncCall(transcript, preSyncLorebook)
        .then(text => {
            if (_lorebookGenId !== lbId) return;

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
            if (_lorebookGenId !== lbId) return;
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

    const horizon    = getSettings().hookseekerHorizon ?? 70;
    const upToLatest = $('#cnz-lb-up-to-latest').is(':checked');
    const transcript = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon);

    const targetedId = ++_targetedGenId;
    $('#cnz-lb-btn-regen').prop('disabled', true);

    runTargetedLbCall(mode, s.name, keys, content, transcript)
        .then(rawText => {
            if (_targetedGenId !== targetedId) return;

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
            if (_targetedGenId !== targetedId) return;
            toastr.error(`CNZ: Regenerate failed: ${err.message}`);
        })
        .finally(() => {
            if (_targetedGenId !== targetedId) return;
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
    const confirmed = await callPopup(
        `This will apply all ${count} unreviewed suggestion${count !== 1 ? 's' : ''} to the Lorebook using the AI\'s current text. Continue?`,
        'confirm',
    );
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
    if (!allAttachments.length) { $('#cnz-step4-rag').addClass('cnz-hidden'); return; }
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
 * Updates the head ledger node file in place — never creates a new node.
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

    // Freshness lock — abort if another sync committed since modal opened
    const freshnessError = await verifyFreshnessLock(char.avatar);
    if (freshnessError) {
        abortCommitWithError(freshnessError);
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
            const freshCtx  = SillyTavern.getContext();
            const freshChar = freshCtx.characters.find(c => c.avatar === char.avatar);
            if (freshChar) {
                const newScenario = writeHookseekerBlock(freshChar.scenario ?? '', hooksText);
                await patchCharacterScenario(freshChar, newScenario);
                await SillyTavern.getContext().getOneCharacter(freshChar.avatar);
                _priorSituation = hooksText;
                hooksChanged = true;
                upsertReceiptItem('cnz-receipt-hooks', receiptSuccess('Narrative Hooks updated in character scenario'));
            }
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

                // Derive delta inline — _lorebookDelta is no longer relied upon as ephemeral state
                const createdUids = [], modifiedEntries = {};
                for (const [uid, entry] of Object.entries(_draftLorebook.entries ?? {})) {
                    const orig = preLorebook.entries?.[uid];
                    if (!orig) {
                        createdUids.push(uid);
                    } else if (orig.content !== entry.content || JSON.stringify(orig.key) !== JSON.stringify(entry.key)) {
                        modifiedEntries[uid] = { content: orig.content, key: [...(orig.key ?? [])] };
                    }
                }
                // _lorebookDelta kept in sync for any remaining references (revert buttons etc.)
                _lorebookDelta = { createdUids, modifiedEntries };
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

    // Reverts are saved immediately but the ledger node still needs updating
    if (!lorebookChanged && _lorebookSuggestions.some(s => s._rejected)) {
        lorebookChanged = true;
    }

    // ── Step 3: RAG upload ───────────────────────────────────────────────────
    const hasManualChunks = _ragChunks.some(c => c.status === 'manual');
    if (hasManualChunks || _ragRawDetached) {
        try {
            const ragText = _ragRawDetached ? $('#cnz-rag-raw').val() : buildRagDocument(_ragChunks);
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

    // ── Step 4: Update head node file in place (no new ledger node) ──────────
    if (hooksChanged || lorebookChanged || ragChanged) {
        try {
            const headChainEntry = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
            if (headChainEntry) {
                const headNodeFile = await fetchLedgerNodeFile(char.avatar, headChainEntry.nodeId);
                if (headNodeFile) {
                    if ((headNodeFile.editToken ?? null) !== _sessionHeadEditToken) {
                        abortCommitWithError('Ledger node was modified by another session. Close and re-open to retry.');
                        return;
                    }
                    if (hooksChanged)    headNodeFile.state.hooks    = _priorSituation;
                    if (lorebookChanged) headNodeFile.state.lorebook = Object.assign({ name: _lorebookName }, structuredClone(_draftLorebook));
                    if (ragChanged)      headNodeFile.state.ragFiles  = [...(headNodeFile.state.ragFiles ?? []), newRagFileName];
                    headNodeFile.editToken = crypto.randomUUID();
                    const safeKey      = cnzAvatarKey(char.avatar);
                    const nodeFileName = cnzFileName(safeKey, 'node', headNodeFile.nodeId);
                    await cnzUploadFile(nodeFileName, headNodeFile);
                    upsertReceiptItem('cnz-receipt-ledger', receiptSuccess('Narrative Ledger updated'));
                }
            }
        } catch (err) {
            console.error('[CNZ] Ledger node update failed:', err);
            upsertReceiptItem('cnz-receipt-ledger', receiptFailure(`Ledger update failed: ${err.message} (content saved)`));
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
 * changed to disk and patches the head ledger node. Delegates all content
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
    $('body').append(buildLedgerInspectorHTML());
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

    const horizon    = getSettings().hookseekerHorizon ?? 70;
    const upToLatest = $('#cnz-lb-up-to-latest').is(':checked');
    const transcript = upToLatest ? buildModalTranscript(horizon) : buildSyncWindowTranscript(horizon);

    const targetedId = ++_targetedGenId;
    $('#cnz-targeted-spinner').removeClass('cnz-hidden');
    $('#cnz-targeted-generate').prop('disabled', true);

    runTargetedLbCall('new', keyword, '', '', transcript)
        .then(rawText => {
            if (_targetedGenId !== targetedId) return;

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
            if (_targetedGenId !== targetedId) return;
            $('#cnz-targeted-error').text(`Generate failed: ${err.message}`).removeClass('cnz-hidden');
        })
        .finally(() => {
            if (_targetedGenId !== targetedId) return;
            $('#cnz-targeted-spinner').addClass('cnz-hidden');
            $('#cnz-targeted-generate').prop('disabled', false);
        });
}

function closeModal() {
    $('#cnz-overlay').addClass('cnz-hidden');
    // Kill all in-flight AI callbacks
    _hooksGenId++;
    _lorebookGenId++;
    _ragGlobalGenId++;
    _targetedGenId++;
    // Reset modal UI state only (engine state must not be cleared here)
    _hooksLoading               = false;
    _lorebookLoading            = false;
    _lbActiveIngesterIndex      = 0;
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer            = null;
    _ragRawDetached             = false;
    _ragInFlightCount           = 0;
    _ragCallQueue               = [];
    _currentStep                = 1;
}

// ─── Ledger Inspector ─────────────────────────────────────────────────────────

function closeLedgerInspector() {
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
 * Opens the read-only Ledger Inspector modal for the current character.
 * Populates the header and renders a collapsed row per node (HEAD first).
 * Node bodies are loaded lazily on first expand.
 */
function openLedgerInspector() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];

    const $overlay = $('#cnz-li-overlay');
    const $title   = $('#cnz-li-title');
    const $body    = $('#cnz-li-body');

    $body.empty();

    if (!char || !_ledgerManifest?.nodes || !_ledgerManifest.headNodeId) {
        const charName = char?.name ?? 'Unknown';
        $title.text(`Ledger Inspector — ${charName}`);
        $body.append(`<div class="cnz-li-empty">No ledger found for this character.</div>`);
        $overlay.removeClass('cnz-hidden');
        return;
    }

    // Build chain: HEAD first
    const chain    = buildNodeChain(_ledgerManifest);  // root → head
    const reversed = chain.slice().reverse();           // head first
    const headId   = _ledgerManifest.headNodeId;
    const headNode = _ledgerManifest.nodes[headId];

    $title.text(
        `${escapeHtml(_ledgerManifest.charName || char.name)} \u2022 ${chain.length} node${chain.length !== 1 ? 's' : ''} \u2022 Head: Turn ${headNode?.sequenceNum ?? '?'}`
    );

    // Track which nodes have had their file fetched (nodeId → node file object)
    const _fetchedNodes = {};

    reversed.forEach((summaryNode, idx) => {
        const isHead     = summaryNode.nodeId === headId;
        const isOrphaned = summaryNode.status === 'orphaned';
        const nodeNum    = reversed.length - idx;  // descending from N to 1
        const orphanBadge = isOrphaned
            ? ' <span class="cnz-li-orphan-badge">orphaned</span>'
            : '';
        const headLabel  = isHead ? ' (HEAD)' : '';

        const $row = $(`
<div class="cnz-li-node-row${isOrphaned ? ' cnz-li-orphaned' : ''}" data-node-id="${escapeHtml(summaryNode.nodeId)}">
  <div class="cnz-li-node-header">
    <span class="cnz-li-chevron">\u25B6</span>
    <span class="cnz-li-node-label">Node ${nodeNum}${headLabel}  Turn ${summaryNode.sequenceNum}${orphanBadge}</span>
  </div>
  <div class="cnz-li-node-body"></div>
</div>`);

        $row.find('.cnz-li-node-header').on('click', async function () {
            const $nodeRow  = $(this).closest('.cnz-li-node-row');
            const $nodeBody = $nodeRow.find('.cnz-li-node-body');
            const $chevron  = $(this).find('.cnz-li-chevron');
            const isOpen    = $nodeBody.hasClass('cnz-li-expanded');

            if (isOpen) {
                $nodeBody.removeClass('cnz-li-expanded');
                $chevron.text('\u25B6');
                return;
            }

            // Expand — lazy-fetch if not yet loaded
            $nodeBody.addClass('cnz-li-expanded');
            $chevron.text('\u25BC');

            if (!_fetchedNodes[summaryNode.nodeId]) {
                $nodeBody.html('<span class="cnz-li-spinner">Loading\u2026</span>');
                const nodeFile = await fetchLedgerNodeFile(char.avatar, summaryNode.nodeId);
                _fetchedNodes[summaryNode.nodeId] = nodeFile ?? false;
            }

            const nodeFile = _fetchedNodes[summaryNode.nodeId];
            if (!nodeFile) {
                $nodeBody.html('<span class="cnz-li-spinner">Failed to load node file.</span>');
                return;
            }

            // Format committedAt
            const when = nodeFile.committedAt
                ? new Date(nodeFile.committedAt).toLocaleString(undefined, {
                      year: 'numeric', month: '2-digit', day: '2-digit',
                      hour: '2-digit', minute: '2-digit',
                  })
                : '—';

            // Hooks: first 100 chars collapsed, full on expand (already expanded here)
            const hooksText  = nodeFile.state?.hooks ?? '';
            const hooksHTML  = `<span class="cnz-li-hooks-preview">${escapeHtml(hooksText)}</span>`;

            // Lorebook entries
            const lbEntries = nodeFile.state?.lorebook?.entries ?? {};
            const lbNames   = Object.values(lbEntries)
                .map(e => e.comment || e.uid || '(unnamed)')
                .join(', ');
            const lbCount   = Object.keys(lbEntries).length;
            const lbHTML    = lbCount > 0
                ? `${escapeHtml(lbNames)} <em>(${lbCount} entries)</em>`
                : '<em>(none)</em>';

            // RAG files
            const ragFiles  = nodeFile.state?.ragFiles ?? [];
            const ragHTML   = ragFiles.length > 0
                ? ragFiles.map(f => `  ${escapeHtml(String(f))}`).join('\n')
                : '  (none)';

            $nodeBody.html(`
<div class="cnz-li-field"><span class="cnz-li-field-label">Committed:</span> ${escapeHtml(when)}</div>
<div class="cnz-li-field"><span class="cnz-li-field-label">Hooks:</span><br>${hooksHTML}</div>
<div class="cnz-li-field"><span class="cnz-li-field-label">Lorebook:</span> ${lbHTML}</div>
<div class="cnz-li-field"><span class="cnz-li-field-label">RAG files:</span> (${ragFiles.length} file${ragFiles.length !== 1 ? 's' : ''})<br><span class="cnz-li-hooks-preview">${escapeHtml(ragHTML)}</span></div>`);
        });

        $body.append($row);
    });

    // Wire close handlers (scoped so they don't accumulate across opens)
    $('#cnz-li-close').off('click.li').on('click.li', closeLedgerInspector);
    $overlay.off('click.li').on('click.li', closeLedgerInspector);
    $('#cnz-li-modal').off('click.li').on('click.li', e => e.stopPropagation());

    $overlay.removeClass('cnz-hidden');
}

// ─── Storage Report ───────────────────────────────────────────────────────────

function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

/**
 * Fetches all CNZ files for every character with a ledger path and reports
 * their approximate sizes (measured from JSON/text content length).
 * Covers: manifest, node files, RAG .txt files (from head node's state.ragFiles).
 */
async function cnzStorageReport() {
    const meta         = getMetaSettings();
    const ledgerPaths  = meta.ledgerPaths ?? {};
    const entries      = Object.entries(ledgerPaths);

    if (entries.length === 0) {
        await callPopup('<p>No CNZ ledger files found. Run at least one sync to create ledger data.</p>', 'text');
        return;
    }

    toastr.info(`CNZ: Measuring storage for ${entries.length} character(s)…`);

    const rows         = [];
    let grandTotal     = 0;

    for (const [avatarKey, manifestPath] of entries) {
        // ── Fetch manifest ────────────────────────────────────────────────────
        let manifest;
        if (avatarKey === SillyTavern.getContext()?.characters?.[SillyTavern.getContext()?.characterId]?.avatar && _ledgerManifest) {
            manifest = _ledgerManifest;
        } else {
            try {
                const res = await fetch(manifestPath);
                if (!res.ok) {
                    rows.push({ name: avatarKey, error: `manifest fetch failed (HTTP ${res.status})` });
                    continue;
                }
                manifest = await res.json();
            } catch (err) {
                rows.push({ name: avatarKey, error: err.message });
                continue;
            }
        }

        const manifestBytes = JSON.stringify(manifest).length;
        const nodeIds       = Object.keys(manifest.nodes ?? {});
        const baseDir       = manifestPath.includes('/')
            ? manifestPath.slice(0, manifestPath.lastIndexOf('/') + 1)
            : '';

        // ── Fetch node files ──────────────────────────────────────────────────
        let nodeBytes   = 0;
        let missingNodes = 0;
        let headNode    = null;

        for (const nodeId of nodeIds) {
            const nodeFile = await fetchLedgerNodeFile(avatarKey, nodeId);
            if (nodeFile) {
                nodeBytes += JSON.stringify(nodeFile).length;
                if (nodeId === manifest.headNodeId) headNode = nodeFile;
            } else {
                missingNodes++;
            }
        }

        // ── Fetch RAG files (from head node's cumulative list) ────────────────
        const ragFileNames = headNode?.state?.ragFiles ?? [];
        let ragBytes       = 0;
        let missingRag     = 0;

        for (const ragName of ragFileNames) {
            const ragPath = baseDir + ragName;
            try {
                const res = await fetch(ragPath);
                if (res.ok) {
                    const text = await res.text();
                    ragBytes += text.length;
                } else {
                    missingRag++;
                }
            } catch {
                missingRag++;
            }
        }

        const charName  = manifest.charName ?? avatarKey;
        const rowTotal  = manifestBytes + nodeBytes + ragBytes;
        grandTotal     += rowTotal;

        rows.push({
            name: charName,
            nodeCount:    nodeIds.length,
            ragCount:     ragFileNames.length,
            manifestBytes,
            nodeBytes,
            ragBytes,
            rowTotal,
            missingNodes,
            missingRag,
        });
    }

    // ── Render ────────────────────────────────────────────────────────────────
    const rowsHtml = rows.map(r => {
        if (r.error) {
            return `<tr>
  <td>${escapeHtml(r.name)}</td>
  <td colspan="6" style="color:#f66">${escapeHtml(r.error)}</td>
</tr>`;
        }
        const nodeSuffix = r.missingNodes > 0
            ? ` <span style="color:#fa0">(${r.missingNodes} missing)</span>` : '';
        const ragSuffix  = r.missingRag  > 0
            ? ` <span style="color:#fa0">(${r.missingRag} missing)</span>`  : '';
        return `<tr>
  <td style="padding:0.2em 0.5em">${escapeHtml(r.name)}</td>
  <td style="padding:0.2em 0.5em;text-align:right">${r.nodeCount}${nodeSuffix}</td>
  <td style="padding:0.2em 0.5em;text-align:right">${r.ragCount}${ragSuffix}</td>
  <td style="padding:0.2em 0.5em;text-align:right">${formatBytes(r.manifestBytes)}</td>
  <td style="padding:0.2em 0.5em;text-align:right">${formatBytes(r.nodeBytes)}</td>
  <td style="padding:0.2em 0.5em;text-align:right">${formatBytes(r.ragBytes)}</td>
  <td style="padding:0.2em 0.5em;text-align:right"><strong>${formatBytes(r.rowTotal)}</strong></td>
</tr>`;
    }).join('');

    // ── Fetch server memory report (requires cnz-diag plugin + enableServerPlugins: true) ──
    let memHtml = '';
    try {
        const memRes = await fetch('/api/plugins/cnz-diag/memory', {
            method:  'POST',
            headers: getRequestHeaders(),
        });
        if (memRes.ok) {
            const m = await memRes.json();
            const p = m.process;
            const o = m.os;
            memHtml = `
<h4 style="margin:1em 0 0.4em">Server Memory (logged to console)</h4>
<table style="width:100%;border-collapse:collapse;font-size:0.9em">
  <tr><td style="padding:0.15em 0.5em;color:#aaa">Process RSS</td>       <td style="text-align:right;padding:0.15em 0.5em">${formatBytes(p.rss)}</td></tr>
  <tr><td style="padding:0.15em 0.5em;color:#aaa">Heap used / total</td> <td style="text-align:right;padding:0.15em 0.5em">${formatBytes(p.heapUsed)} / ${formatBytes(p.heapTotal)}</td></tr>
  <tr><td style="padding:0.15em 0.5em;color:#aaa">External / Buffers</td><td style="text-align:right;padding:0.15em 0.5em">${formatBytes(p.external)} / ${formatBytes(p.arrayBuffers)}</td></tr>
  <tr><td style="padding:0.15em 0.5em;color:#aaa">OS free / total</td>   <td style="text-align:right;padding:0.15em 0.5em">${formatBytes(o.freeMem)} / ${formatBytes(o.totalMem)}</td></tr>
  <tr><td style="padding:0.15em 0.5em;color:#aaa">Load avg (1/5/15m)</td><td style="text-align:right;padding:0.15em 0.5em">${o.loadAvg1.toFixed(2)} / ${o.loadAvg5.toFixed(2)} / ${o.loadAvg15.toFixed(2)}</td></tr>
</table>`;
        } else if (memRes.status === 404) {
            memHtml = `<p style="color:#888;font-size:0.85em;margin-top:0.75em">Server memory unavailable — enable the cnz-diag plugin (see README).</p>`;
        }
    } catch {
        // Plugin not present or server plugins disabled — silent skip
    }

    const html = `
<h3>CNZ Storage Report</h3>
<p style="color:#aaa;font-size:0.85em">Sizes are measured from fetched content (UTF-8 character count, not compressed disk bytes).</p>
<table style="width:100%;border-collapse:collapse;font-size:0.9em">
  <thead>
    <tr style="border-bottom:1px solid #555">
      <th style="text-align:left;padding:0.3em 0.5em">Character</th>
      <th style="text-align:right;padding:0.3em 0.5em">Nodes</th>
      <th style="text-align:right;padding:0.3em 0.5em">RAG files</th>
      <th style="text-align:right;padding:0.3em 0.5em">Manifest</th>
      <th style="text-align:right;padding:0.3em 0.5em">Nodes</th>
      <th style="text-align:right;padding:0.3em 0.5em">RAG</th>
      <th style="text-align:right;padding:0.3em 0.5em">Total</th>
    </tr>
  </thead>
  <tbody>${rowsHtml}</tbody>
  <tfoot>
    <tr style="border-top:1px solid #555">
      <td colspan="6" style="padding:0.3em 0.5em"><strong>Grand Total</strong></td>
      <td style="padding:0.3em 0.5em;text-align:right"><strong>${formatBytes(grandTotal)}</strong></td>
    </tr>
  </tfoot>
</table>
<p style="color:#aaa;font-size:0.85em;margin-top:0.75em">Each sync appends a new node file (full snapshot). Use <em>Purge Ledger</em> to reclaim space.</p>
${memHtml}`;

    await callPopup(html, 'text');
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
 * ensures lorebook and ledger are bootstrapped, then shows Step 1.
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

    // Ensure ledger is bootstrapped
    if (!_ledgerManifest) {
        await fetchOrBootstrapLedger(char.avatar).catch(err =>
            console.error('[CNZ] openReviewModal: ledger bootstrap failed:', err),
        );
    }

    checkRagGaps();

    // Derive before/after states from ledger and current character.
    // Re-fetch character to pick up any scenario patch written during a
    // background sync that may not yet be reflected in the original char ref.
    const freshChar = SillyTavern.getContext().characters.find(c => c.avatar === char.avatar);
    _priorSituation = extractHookseekerBlock((freshChar ?? char).scenario ?? '') ?? '';

    // Derive before/after states from ledger nodes — stable across any number of modal opens.
    // head node  = post-sync state (what's on disk now)
    // parent node = pre-sync state (manual-edit-inclusive baseline the AI ran against)
    const headChainEntry = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
    _beforeSituation = '';
    let preSyncLorebookForDiff = null;   // parent node's lorebook — diff baseline

    if (headChainEntry) {
        try {
            const headNodeFile = await fetchLedgerNodeFile(char.avatar, headChainEntry.nodeId);
            const parentId     = headNodeFile?.parentId ?? null;

            // hooks: parent node's state.hooks is what existed before this sync
            if (parentId) {
                const parentNodeFile   = await fetchLedgerNodeFile(char.avatar, parentId);
                _beforeSituation       = parentNodeFile?.state?.hooks    ?? '';
                preSyncLorebookForDiff = parentNodeFile?.state?.lorebook ?? null;
                _parentNodeLorebook    = preSyncLorebookForDiff;
            }

            // head node lorebook = current committed state; use as _draftLorebook baseline
            if (headNodeFile?.state?.lorebook) {
                _lorebookData  = structuredClone(headNodeFile.state.lorebook);
                _draftLorebook = structuredClone(headNodeFile.state.lorebook);
                _lorebookName  = headNodeFile.state.lorebook.name || _lorebookName;
            }

            // Seed RAG summary from ledger head if not already set by current session
            if (!_lastSummaryUsedForRag && headNodeFile?.state?.hooks) {
                _lastSummaryUsedForRag = headNodeFile.state.hooks;
            }
        } catch (err) {
            console.warn('[CNZ] openReviewModal: could not fetch ledger nodes:', err);
        }
    }

    // Derive _lorebookSuggestions from the node diff — no ephemeral sync-cycle data needed.
    // This is stable: head lorebook vs parent lorebook, derived fresh on every modal open.
    // Only diff when a head node exists — without one, no sync has run and every pre-existing
    // lorebook entry would be incorrectly surfaced as a NEW suggestion.
    const ledgerSuggestions = headChainEntry
        ? deriveSuggestionsFromLedgerDiff(preSyncLorebookForDiff, _draftLorebook)
        : [];
    _lorebookSuggestions = ledgerSuggestions;

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
}

// ─── CNZ Logging ─────────────────────────────────────────────────────────────

function logTurnReport(count, liveContextBuffer, trailingBoundary, priorSequenceNum, every) {
    const gap = trailingBoundary - priorSequenceNum;
    const bufferStart = trailingBoundary + 1;
    console.log(
        `[CNZ] Turn ${count} | ` +
        `committed: 0–${priorSequenceNum} | ` +
        `buffer: ${bufferStart}–${count} (${liveContextBuffer} turns) | ` +
        `gap: ${gap}/${every}`
    );
}

function logSyncStart(hookPairs, ragPairs, lbPairs, coverAll, chunkEveryN) {
    const fmt = pairs => pairs.length > 0
        ? `turns ${pairs[0].validIdx + 1}–${pairs[pairs.length - 1].validIdx + 1} (${pairs.length} pairs)`
        : '(none)';
    const lbLabel = lbPairs
        ? `${fmt(lbPairs)} [lastSync mode]`
        : `${fmt(hookPairs)} [same as hookseeker]`;
    console.log(
        `[CNZ] ── SYNC START ── coverAll=${coverAll} window=${chunkEveryN}\n` +
        `  hookseeker: ${fmt(hookPairs)}\n` +
        `  lorebook:   ${lbLabel}\n` +
        `  rag:        ${fmt(ragPairs)}`
    );
}

function logSyncEnd(lbOk, hooksOk, ragOk, ledgerOk, ragFileName, ragChunks, lorebookDelta, nodeId, seqNum) {
    const lbDetail = lbOk
        ? `${(lorebookDelta?.createdUids?.length ?? 0)} created, ${Object.keys(lorebookDelta?.modifiedEntries ?? {}).length} updated`
        : 'FAILED';
    const ragDetail = ragOk
        ? `${ragChunks.length} chunks → ${ragFileName ?? '(disabled)'}`
        : 'FAILED';
    console.log(
        `[CNZ] ── SYNC DONE ──\n` +
        `  lorebook: ${lbDetail}\n` +
        `  hooks:    ${hooksOk ? 'updated' : 'FAILED'}\n` +
        `  rag:      ${ragDetail}\n` +
        `  ledger:   ${ledgerOk ? `node ${nodeId} committed (seqNum=${seqNum})` : 'FAILED'}`
    );
}

function checkRagGaps() {
    if (!_ledgerManifest?.headNodeId) return;
    const ctx      = SillyTavern.getContext();
    const messages = ctx?.chat ?? [];
    if (!messages.length) return;

    const headChainEntry = _ledgerManifest.nodes[_ledgerManifest.headNodeId];
    const parentEntry    = headChainEntry?.parentId
        ? _ledgerManifest.nodes[headChainEntry.parentId]
        : null;

    const windowStart = parentEntry?.sequenceNum ?? 0;
    const windowEnd   = headChainEntry?.sequenceNum ?? 0;
    if (windowEnd <= windowStart) return;

    const settings    = getSettings();
    const chunkSize   = Math.max(1, settings.ragChunkSize ?? 2);
    const allPairs    = buildProsePairs(messages);
    const windowPairs = allPairs.filter(p => p.validIdx >= windowStart && p.validIdx < windowEnd);

    if (!windowPairs.length) return;

    // Expected chunk boundaries: last pair of each chunk window
    const gaps = [];
    for (let i = chunkSize - 1; i < windowPairs.length; i += chunkSize) {
        const pair    = windowPairs[i];
        const lastMsg = pair.messages?.[pair.messages.length - 1];
        if (!lastMsg) continue;
        if (!lastMsg.extra?.cnz_chunk_header) {
            const turnNum = pair.validIdx + 1;
            gaps.push(turnNum);
        }
    }

    if (gaps.length === 0) {
        console.log(`[CNZ] RAG gap check: all ${Math.floor(windowPairs.length / chunkSize)} chunk(s) have stored headers`);
    } else {
        console.warn(`[CNZ] RAG gap check: ${gaps.length} chunk(s) missing stored headers at turns ${gaps.join(', ')}`);
        toastr.warning(`CNZ: ${gaps.length} RAG chunk(s) missing classification headers — open RAG workshop to reclassify`);
    }
}

// ─── CNZ Core ────────────────────────────────────────────────────────────────

/**
 * Fires every chunkEveryN turns (MESSAGE_RECEIVED handler).
 * Executes the full background sync pipeline:
 *   1. Derive the current turn window (last chunkEveryN pairs)
 *   2. Fire Fact-Finder + Hookseeker in parallel
 *   3. Apply lorebook updates silently
 *   4. Write Hookseeker output into the character scenario anchor block
 *   5. Build, classify, and upload RAG chunks as a chat attachment
 *   6. Commit a Ledger node recording this milestone
 *
 * Each step is guarded individually; a failure emits a warning toast but
 * does not abort subsequent steps or throw to the caller.
 *
 * @param {object} char     Character object from ST context at trigger time.
 * @param {Array}  messages Full chat message array at trigger time.
 */
async function runCnzSync(char, messages, { coverAll = false } = {}) {
    _syncInProgress = true;
    const transcript = buildSyncWindowTranscript(70);

    // --- LANE 1: LOREBOOK (Independent) ---
    const lbPromise = (async () => {
        try {
            const text = await runLorebookSyncCall(transcript, _lorebookData);
            await processLorebookUpdate(text); // Silently apply
            return true;
        } catch (e) { console.error("LB Sync Failed", e); return false; }
    })();

    // --- LANE 2: HOOKS (Independent) ---
    const hooksPromise = (async () => {
        try {
            const text = await runHookseekerCall(transcript, _priorSituation);
            await processHooksUpdate(text);
            _priorSituation = text; // Update memory for RAG
            return true;
        } catch (e) { 
            console.error("Hooks Sync Failed", e); 
            _priorSituation = "Current Action"; // Fallback so RAG doesn't stall
            return false; 
        }
    })();

    // --- LANE 3: RAG (Independent & Guard-Free) ---
    // We don't wait for Hooks anymore. We fire RAG immediately.
    const ragPromise = (async () => {
        if (!getSettings().enableRag) return true;
        try {
            // RAG uses whatever _priorSituation we have (old or fallback)
            await runRagPipeline(transcript); 
            return true;
        } catch (e) { console.error("RAG Sync Failed", e); return false; }
    })();

    // Run them all. If one fails, the others still commit.
    const [lbOk, hooksOk, ragOk] = await Promise.all([lbPromise, hooksPromise, ragPromise]);

    // Commit the Ledger Node regardless of AI success
    await commitLedgerNode(char, messages);
    
    _syncInProgress = false;
    toastr.success("Sync Processed (Best Effort)");
}

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the Ledger hash chain against the current chat history to detect branches.
 * If a branch is found, restores the lorebook and hooks block to the last valid
 * milestone, rolls the Ledger head back, and orphans the diverged nodes.
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
    // Ensure ledger is loaded for this character
    if (!_ledgerManifest) {
        await fetchOrBootstrapLedger(char.avatar);
    }
    if (!_ledgerManifest?.nodes || !_ledgerManifest.headNodeId) return;

    const context  = SillyTavern.getContext();
    const messages = context.chat ?? [];
    if (!messages.length) return;

    const chain = buildNodeChain(_ledgerManifest);
    if (!chain.length) return;

    // Walk root→head: find the deepest node whose hash still matches current messages.
    let lastValidNodeIdx = -1;
    for (let i = 0; i < chain.length; i++) {
        const node     = chain[i];
        const prevHash = i > 0 ? chain[i - 1].milestoneHash : null;
        const msgIdx   = findMessageIndexAtCount(messages, node.sequenceNum);

        if (msgIdx === -1) break;  // current chat shorter than this milestone

        // Nodes written before Phase 3 have no milestoneHash — treat as unverifiable.
        if (!node.milestoneHash) break;

        const computedHash = await hashMilestone(messages, msgIdx, prevHash);
        if (computedHash === node.milestoneHash) {
            lastValidNodeIdx = i;
        } else {
            break;  // first mismatch — all deeper nodes are also invalid
        }
    }

    // Head matches — same timeline, nothing to do.
    if (lastValidNodeIdx === chain.length - 1) return;

    // No node matched — chat predates CNZ or is unrelated.
    if (lastValidNodeIdx === -1) return;

    // ── Branch detected ───────────────────────────────────────────────────────
    const targetNode = chain[lastValidNodeIdx];
    const turnNum    = targetNode.sequenceNum;

    // ── Confirm before touching anything ─────────────────────────────────────
    const confirmed = await callPopup(
        `<h3>CNZ: Timeline Branch Detected</h3>
        <p>The current chat diverges from the last committed sync point at
        <strong>Turn ${turnNum}</strong>.</p>
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
        const targetNodeFile = await fetchLedgerNodeFile(char.avatar, targetNode.nodeId);
        if (!targetNodeFile) throw new Error(`Could not fetch node file for ${targetNode.nodeId}`);

        await restoreLorebookToNode(char, targetNode, targetNodeFile);
        await restoreHooksToNode(char, targetNode, targetNodeFile);

        try {
            await restoreRagToNode(char, targetNodeFile);
        } catch (err) {
            console.error('[CNZ] Healer: RAG reconciliation failed:', err);
            toastr.warning('CNZ: Branch healed but RAG reconciliation failed — vector index may be inconsistent.');
        }

        // Orphan all nodes that descended past the branch point
        for (let i = lastValidNodeIdx + 1; i < chain.length; i++) {
            chain[i].status = 'orphaned';
        }

        // Roll back the Ledger head
        _ledgerManifest.headNodeId = targetNode.nodeId;
        _sessionStartId            = targetNode.nodeId;

        await commitLedgerManifest(char.avatar);

        toastr.warning(`CNZ: Branch detected — restored to Turn ${turnNum}. Vector index rebuilt.`);
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
 * @param {string|null} trailingPromptKey  Optional settings key for a trailing prompt shown below the main textarea.
 */
function openPromptModal(settingsKey, title, defaultValue, vars = [], trailingPromptKey = null) {
    const $overlay         = $('#cnz-pm-overlay');
    const $textarea        = $('#cnz-pm-textarea');
    const $titleEl         = $('#cnz-pm-title');
    const $reset           = $('#cnz-pm-reset');
    const $close           = $('#cnz-pm-close');
    const $vars            = $('#cnz-pm-vars');
    const $trailingSection = $('#cnz-pm-trailing-section');
    const $trailingArea    = $('#cnz-pm-trailing-textarea');

    $titleEl.text(title);
    $textarea.val(getSettings()[settingsKey] ?? defaultValue);
    $vars.html(vars.map(v => `<code class="cnz-pm-var">{{${v}}}</code>`).join(' '));

    if (trailingPromptKey) {
        $trailingArea.val(getSettings()[trailingPromptKey] ?? '');
        $trailingSection.removeClass('cnz-hidden');
    } else {
        $trailingSection.addClass('cnz-hidden');
    }

    // Unbind any previous open's handlers before re-binding
    $textarea.off('input.pm');
    $trailingArea.off('input.pm');
    $reset.off('click.pm');
    $close.off('click.pm');
    $overlay.off('click.pm');
    $('#cnz-pm-modal').off('click.pm').on('click.pm', e => e.stopPropagation());

    $textarea.on('input.pm', function () {
        getSettings()[settingsKey] = $(this).val();
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    if (trailingPromptKey) {
        $trailingArea.on('input.pm', function () {
            getSettings()[trailingPromptKey] = $(this).val();
            saveSettingsDebounced(); updateDirtyIndicator();
        });
    }

    $reset.on('click.pm', function () {
        getSettings()[settingsKey] = defaultValue;
        $textarea.val(defaultValue);
        if (trailingPromptKey) {
            getSettings()[trailingPromptKey] = '';
            $trailingArea.val('');
        }
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
    $('#cnz-set-hookseeker-horizon').val(s.hookseekerHorizon ?? 70);
    $('#cnz-set-lorebook-sync-start').val(s.lorebookSyncStart ?? 'syncTurn');
    $('#cnz-set-auto-advance-mask').prop('checked', s.autoAdvanceMask ?? false);
    $('#cnz-set-ledger-max-nodes').val(s.ledgerMaxNodes ?? 0);
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
        const val = Math.max(1, parseInt($(this).val()) || 70);
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

    $('#cnz-set-ledger-max-nodes').on('input', function () {
        const val = Math.max(0, parseInt($(this).val()) || 0);
        getSettings().ledgerMaxNodes = val;
        saveSettingsDebounced(); updateDirtyIndicator();
    });

    $('#cnz-edit-summary-prompt').on('click', () =>
        openPromptModal('hookseekerPrompt', 'Edit Summary Prompt', DEFAULT_HOOKSEEKER_PROMPT,
            ['transcript', 'prev_summary'], 'hookseekerTrailingPrompt'));

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

    $('#cnz-inspect-ledger').on('click', function () {
        openLedgerInspector();
    });

    $('#cnz-storage-report').on('click', async function () {
        await cnzStorageReport();
    });

    $('#cnz-purge-ledger').on('click', async function () {
        // Guard conditions
        if (_syncInProgress) {
            toastr.warning('CNZ: Sync in progress — wait for it to complete before purging.');
            return;
        }
        const ctx  = SillyTavern.getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (!char) {
            toastr.error('CNZ: No character selected.');
            return;
        }

        // Confirmation modal — names the character and lists exactly what will be deleted.
        const confirmed = await callPopup(`
<h3>Purge CNZ Ledger</h3>
<p>You are about to purge the CNZ sync history for:</p>
<p><strong>${escapeHtml(char.name)}</strong></p>
<p>This will permanently delete:</p>
<ul>
  <li>The narrative ledger and all committed sync points</li>
  <li>The last sync position (next sync will start fresh)</li>
  <li>Stored chunk classification headers in this chat (optional — see checkbox below)</li>
</ul>
<p>This cannot be undone. The character's lorebook and hookseeker summary are <strong>NOT</strong> affected — only the sync tracking is cleared.</p>
<label style="display:flex;align-items:center;gap:0.5em;margin-top:0.75em;">
  <input type="checkbox" id="cnz-purge-clear-headers" checked>
  Also clear stored chunk headers from chat messages
</label>`,
            'confirm',
        );
        if (!confirmed) return;

        const clearHeaders = document.getElementById('cnz-purge-clear-headers')?.checked ?? true;

        // 1. Delete the ledger file from the Data Bank
        const meta       = getMetaSettings();
        const ledgerPath = meta.ledgerPaths?.[char.avatar];
        if (ledgerPath) {
            try {
                await fetch('/api/files/delete', {
                    method:  'POST',
                    headers: getRequestHeaders(),
                    body:    JSON.stringify({ path: ledgerPath }),
                });
            } catch (err) {
                console.warn('[CNZ] Purge: ledger file delete failed (continuing):', err);
            }
        }

        // 2. Clear the ledger path from settings
        delete meta.ledgerPaths[char.avatar];
        saveSettingsDebounced();

        // 3. Reset in-memory ledger state
        _ledgerManifest = null;
        _sessionStartId = null;

        // 4. Reset lastLorebookSyncAt
        meta.lastLorebookSyncAt = null;
        saveSettingsDebounced();

        // 5. Optionally clear chunk headers from chat messages
        if (clearHeaders) {
            const chat = ctx.chat ?? [];
            let modified = false;
            for (const msg of chat) {
                if (msg.extra?.cnz_chunk_header !== undefined || msg.extra?.cnz_turn_label !== undefined) {
                    delete msg.extra.cnz_chunk_header;
                    delete msg.extra.cnz_turn_label;
                    modified = true;
                }
            }
            if (modified) {
                ctx.saveChat().catch(err => console.error('[CNZ] Purge: saveChat failed:', err));
            }
        }

        // 6. Reset staged pairs and chunks
        _stagedProsePairs       = [];
        _splitPairIdx           = 0;
        _stagedPairOffset       = 0;
        _ragChunks              = [];
        _splitIndexWhenRagBuilt = null;
        clearChunkChatLabels();

        // 7. Report
        toastr.success('CNZ: Ledger purged — next sync will treat this character as new.');
    });
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
 * The pump trigger (onMessageReceived) fires after each AI message and decides
 * whether to run a sync cycle. onChatChanged resets session state and triggers
 * the Healer on character switch. Delegated click handlers dispatch wand menu
 * actions. `init` registers all event listeners and injects persistent UI.
 * @core-principles
 *   1. No business logic here — handlers delegate immediately to engine functions.
 *   2. checkOrphans runs once on init and on chat change; it never blocks the event loop.
 * @api-declaration
 *   onMessageReceived, onChatChanged, onWandButtonClick, injectWandButton,
 *   checkOrphans, init
 * @contract
 *   assertions:
 *     external_io: [eventSource, /api/chats/saveChat]
 */
// ─── Event Handlers ───────────────────────────────────────────────────────────

async function onMessageReceived() {
    const context = SillyTavern.getContext();
    if (!context || context.groupId || context.characterId == null) return;
    if (!getSettings().autoSync) return;

    const messages = context.chat ?? [];
    const count    = messages.filter(m => !m.is_system).length;
    const every    = getSettings().chunkEveryN ?? 20;
    if (every <= 0 || count <= 0) return;

    // ── Snooze check ──────────────────────────────────────────────────────────
    if (count <= _snoozeUntilCount) return;

    // ── Gap detection ─────────────────────────────────────────────────────────
    // Ledger not loaded yet — bootstrap it in the background and skip this
    // trigger. The next MESSAGE_RECEIVED will find the manifest ready.
    if (!_ledgerManifest) {
        const char = context.characters[context.characterId];
        fetchOrBootstrapLedger(char.avatar).catch(err =>
            console.error('[CNZ] onMessageReceived: ledger bootstrap failed:', err),
        );
        return;
    }

    // headNode.sequenceNum is the trailingBufferBoundary at the last commit.
    // Compute the current trailing boundary and compare against it to find
    // how many new turns are ready to be canonized.
    const headNode            = _ledgerManifest.nodes?.[_ledgerManifest.headNodeId];
    const priorSequenceNum    = headNode?.sequenceNum ?? 0;
    const liveContextBuffer   = getSettings().liveContextBuffer ?? 5;
    const trailingBoundary    = Math.max(0, count - liveContextBuffer);
    const gap                 = trailingBoundary - priorSequenceNum;

    logTurnReport(count, liveContextBuffer, trailingBoundary, priorSequenceNum, every);

    if (gap < every) return;  // not enough new turns yet

    const char = context.characters[context.characterId];

    if (gap < every * 2) {
        // Standard case — one window's worth of new turns, run silently.
        runCnzSync(char, messages).catch(err =>
            console.error('[CNZ] runCnzSync uncaught error:', err),
        );
        return;
    }

    // ── Large-gap path ────────────────────────────────────────────────────────
    // Auto-run the standard window sync first so the user gets fast feedback,
    // then offer to also canonize the remaining older turns.
    if (_syncInProgress) return;  // already running from a prior trigger

    try {
        await runCnzSync(char, messages);
    } catch (err) {
        console.error('[CNZ] runCnzSync uncaught error:', err);
        return;
    }

    // Re-read the head after the window sync — it may have covered the gap.
    const newHead      = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
    const newPrior     = newHead?.sequenceNum ?? 0;
    const remaining    = trailingBoundary - newPrior;  // use same trailingBoundary
    const snoozeTurns  = getSettings().gapSnoozeTurns ?? 5;

    if (remaining < every) return;  // window sync was enough

    // Show a persistent (non-blocking) toast — user clicks Sync all or Snooze
    toastr.warning(
        `CNZ: ${remaining} uncaptured turn(s). ` +
        `<a href="#" class="cnz-gap-sync-all">Sync all</a> &nbsp; ` +
        `<a href="#" class="cnz-gap-snooze">Snooze ${snoozeTurns} turns</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

/**
 * Checks whether any files tracked in knownFiles are no longer referenced by
 * any ledger manifest. Shows a persistent dismissible toast if orphans are found.
 * Uses only in-memory manifests + ledgerPaths; does not fetch additional files.
 */
function checkOrphans() {
    const meta      = getMetaSettings();
    const knownFiles = meta.knownFiles ?? [];
    if (!knownFiles.length) return;

    const ledgerPaths = meta.ledgerPaths ?? {};
    const expectedPaths = new Set(Object.values(ledgerPaths));

    // Add node file paths derivable from the currently-loaded manifest
    if (_ledgerManifest?.nodes) {
        const manifestPath = ledgerPaths[_ledgerManifest.avatarKey]
            ?? Object.entries(ledgerPaths).find(
                   ([k]) => cnzAvatarKey(k) === _ledgerManifest.avatarKey
               )?.[1]
            ?? null;

        if (manifestPath) {
            const lastSlash = manifestPath.lastIndexOf('/');
            const baseDir   = lastSlash >= 0 ? manifestPath.slice(0, lastSlash + 1) : '';
            for (const nodeId of Object.keys(_ledgerManifest.nodes)) {
                expectedPaths.add(baseDir + cnzFileName(_ledgerManifest.avatarKey, 'node', nodeId));
            }
        }
    }

    const orphans = knownFiles.filter(p => !expectedPaths.has(p));
    if (!orphans.length) return;

    _pendingOrphans = orphans;
    console.warn('[CNZ] Orphan check: found', orphans.length, 'unreferenced file(s):', orphans);
    toastr.warning(
        `CNZ: ${orphans.length} unreferenced file${orphans.length !== 1 ? 's' : ''} detected in Data Bank. <a href="#" class="cnz-orphan-review">Review</a> <a href="#" class="cnz-orphan-dismiss">Dismiss</a>`,
        '',
        { timeOut: 0, extendedTimeOut: 0, closeButton: true, escapeHtml: false },
    );
}

function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        _lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    // Character switched — reset cached ledger (it belongs to the old character),
    // then bootstrap the new character's ledger and run the Healer.
    if (!char || char.avatar !== _lastKnownAvatar) {
        _ledgerManifest      = null;
        _lastKnownAvatar     = char?.avatar ?? null;
        _stagedProsePairs    = [];
        _stagedPairOffset    = 0;
        _splitPairIdx        = 0;
        _ragChunks           = [];
        _splitIndexWhenRagBuilt  = null;
        _parentNodeLorebook  = null;
        _lorebookSuggestions = [];
        _lorebookData        = null;
        _draftLorebook       = null;
        clearChunkChatLabels();
        if (char) {
            fetchOrBootstrapLedger(char.avatar)
                .then(() => {
                    checkOrphans();
                    return runHealer(char, char.chat);
                })
                .catch(err => console.error('[CNZ] onChatChanged: bootstrap/healer failed:', err));
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
    if (_syncInProgress) {
        toastr.warning('CNZ: Sync already in progress — please wait.');
        return;
    }

    const char         = ctx.characters[ctx.characterId];
    const messages     = ctx.chat ?? [];
    const currentCount = messages.filter(m => !m.is_system).length;
    const settings     = getSettings();
    const lcb          = settings.liveContextBuffer ?? 5;
    const tbb          = Math.max(0, currentCount - lcb);
    const ledgerHead   = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
    const gap          = ledgerHead != null ? tbb - ledgerHead.sequenceNum : tbb;

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
    // Ask the user how much to cover.
    const extraWarning = `<p class="cnz-choice-warn">⚠ ${gap - (settings.chunkEveryN ?? 20)} turn(s) in the middle may never have been captured by auto-sync.</p>`;
    const choice = await showSyncChoicePopup(
        `<h3>How much should this sync cover?</h3>
        <p>${gap} turn(s) have accumulated since the last sync (window size: ${settings.chunkEveryN ?? 20}).</p>
        ${extraWarning}`,
        `Full gap (${gap} turns)`,
        `Standard window (last ${settings.chunkEveryN ?? 20} turns)`,
    );
    if (choice === 'cancel') return;
    const coverAll = choice === 'full';

    toastr.info(`CNZ: Running sync (${coverAll ? `full ${gap}-turn gap` : `last ${settings.chunkEveryN ?? 20} turns`})…`);
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
    injectModal();
    injectSettingsPanel();
    injectWandButton();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);
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
    // Delegated handlers for the large-gap toast (Step 15)
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
        const ctx      = SillyTavern.getContext();
        const messages = ctx?.chat ?? [];
        const count    = messages.filter(m => !m.is_system).length;
        const snoozeTurns = getSettings().gapSnoozeTurns ?? 5;
        _snoozeUntilCount = count + snoozeTurns;
        console.log(`[CNZ] Large-gap offer snoozed until turn ${_snoozeUntilCount}.`);
    });
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
        if (_cnzGenerating) return;  // skip mask for CNZ's own internal AI calls
        const ledgerHead = _ledgerManifest?.nodes?.[_ledgerManifest?.headNodeId];
        if (!ledgerHead) return;  // no ledger head — apply no mask
        const maskBoundary = ledgerHead.sequenceNum;
        if (maskBoundary <= 0) return;

        let nsCount = 0;
        const filtered = data.chat.filter((msg) => {
            if (msg.role === 'system') return true;
            nsCount++;
            return nsCount > maskBoundary;
        });
        const hidden = data.chat.length - filtered.length;
        if (hidden > 0) {
            data.chat.splice(0, data.chat.length, ...filtered);
        }
    });

}

await init();
