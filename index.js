/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-03-27T00:00:00.000Z"}
 * @version 1.1.6
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern Narrative Engine (CNZ) — extension entry point and session
 * orchestrator. Owns the sync pipeline (runCnzSync), session state reset
 * (resetSessionState/resetStagedState), ST event bindings, and the wand button.
 * All major subsystems are now in separate modules:
 *   core/     — llm-calls, healer, settings, transcript, dna-chain, summary-prompt
 *   settings/ — panel (UI), data (settings state)
 *   lorebook/ — api, utils
 *   rag/      — api, pipeline
 *   modal/    — orchestrator, commit, hooks-workshop, lb-workshop, rag-workshop
 *
 * Background sync fires every chunkEveryN turns (via scheduler → SYNC_TRIGGERED).
 * Manual sync runs via the wand button (onWandButtonClick). Both converge on
 * runCnzSync → three parallel lanes (lorebook, hooks, RAG) → commitDnaAnchor.
 *
 * Modal steps (owned by modal/ modules):
 * (1) Hooks Workshop — edit/regen the hookseeker summary, diff vs previous sync
 * (2) Lorebook Workshop — review AI suggestions, targeted generate, stage corrections
 * (3) RAG Workshop — review chunk cards, edit headers, regen individual chunks
 * (4) Finalize — confirm corrections, write only what changed, update head anchor
 *
 * @core-principles
 * 1. SYNC OWNS ITS COMMIT: runCnzSync writes lorebook, hooks, RAG, and a DNA
 *    anchor to the chat as its own atomic operation. The modal corrects, it
 *    does not re-commit the sync.
 * 2. MODAL STAGES ONLY: All edits in the modal mutate state._draftLorebook in memory.
 *    Nothing writes to disk until the user clicks Finalize.
 *    Suggestion objects carry a single verdict status ('pending' | 'applied' |
 *    'rejected' | 'deleted'); all suggestions open as 'pending' for user review. Deleted entries are absent from
 *    state._draftLorebook.entries and are therefore not written by Finalize.
 * 3. ANCHOR IS SOURCE OF TRUTH: Before-states for all modal diffs come from
 *    the DNA chain's head anchor, never from ephemeral sync-cycle variables.
 * 4. HEAD ANCHOR UPDATED IN PLACE: Finalize patches the existing head anchor
 *    in the chat. No new anchor is written for modal corrections.
 * 5. ENGINE STATE SURVIVES MODAL: closeModal resets UI state only. All engine
 *    state (state._ragChunks, state._draftLorebook, state._lorebookSuggestions, etc.)
 *    persists until character switch.
 * 6. CONTEXT MASK: The main AI prompt sees only turns above the DNA chain head.
 *    Older turns are replaced by the hookseeker summary and RAG chunks.
 * 
 * @docs
 *   cnz_principles.md
 *
 * @api-declaration
 * Entry points: onWandButtonClick() (manual), SYNC_TRIGGERED bus event (auto-sync).
 * Sync pipeline (here): runCnzSync(), processLorebookUpdate(), processHooksUpdate(),
 *   commitDnaAnchor(), computeSyncWindow(), deriveLastCommittedPairs(), logSyncStart().
 * Session state (here): resetSessionState(), resetStagedState(), onChatChanged().
 * Wand (here): onWandButtonClick(), injectWandButton(), showSyncChoicePopup().
 * Init (here): init().
 * Delegated to modules — see their @api-declaration for details:
 *   settings/panel.js: injectSettingsPanel(), bindSettingsHandlers(), refreshSettingsUI(),
 *     refreshProfileDropdown(), updateDirtyIndicator(), updateRagAiControlsVisibility(),
 *     openPromptModal()
 *   core/healer.js: runHealer(), purgeAndRebuild()
 *   core/llm-calls.js: runLorebookSyncCall(), runHookseekerCall(), runTargetedLbCall()
 *   modal/orchestrator.js: openReviewModal(), injectModal(), closeModal()
 *   rag/pipeline.js: runRagPipeline(), buildRagChunks(), buildRagDocument()
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: [
 *       state._lorebookData, state._draftLorebook, state._parentNodeLorebook,
 *       state._priorSituation, state._beforeSituation,
 *       state._lorebookName, state._lorebookSuggestions,
 *       state._stagedProsePairs, state._stagedPairOffset, state._splitPairIdx,
 *       state._ragChunks,
 *       state._lastRagUrl,
 *       state._lastKnownAvatar,
 *       state._currentStep, state._modalOpenHeadUuid,
 *       state._lorebookLoading, state._lbActiveIngesterIndex,
 *       state._lbPendingWrite,
 *       state._ragRawDetached, state._pendingOrphans, state._dnaChain,
 *       extension_settings.cnz]
 *     external_io: [
 *       generateRaw (via executor.js), ConnectionManagerRequestService (via executor.js),
 *       /api/worldinfo/*, /api/characters/edit,
 *       /api/files/upload, /api/files/delete,
 *       /api/chats/saveChat]
 */

import { saveSettingsDebounced, getRequestHeaders, eventSource, event_types } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { emit, on, off, enableDevMode, BUS_EVENTS } from './bus.js';
import { invalidateAllJobs } from './cycleStore.js';
import { initScheduler, setSyncInProgress, isSyncInProgress,
         snooze, resetScheduler, setDnaChain, getGap } from './scheduler.js';
import { Triggers } from './recipes.js';
import './executor.js';   // self-registers its CONTRACT_DISPATCHED handler on import
import './logger.js';    // console observer for LLM call lifecycle
import { state } from './state.js';
import { getSettings, initSettings } from './core/settings.js';
import { buildTranscript, buildProsePairs } from './core/transcript.js';
import { runLorebookSyncCall, runHookseekerCall } from './core/llm-calls.js';
import { readDnaChain, getLkgAnchor, buildAnchorPayload,
         writeDnaAnchor, writeDnaLinks } from './core/dna-chain.js';
import { writeCnzSummaryPrompt, syncCnzSummaryOnCharacterSwitch } from './core/summary-prompt.js';
import { runHealer } from './core/healer.js';
import { lbEnsureLorebook, lbSaveLorebook } from './lorebook/api.js';
import { parseLbSuggestions, enrichLbSuggestions,
         nextLorebookUid, makeLbDraftEntry } from './lorebook/utils.js';
import { runRagPipeline, writeChunkHeaderToChat,
         renderChunkChatLabel, clearChunkChatLabels } from './rag/pipeline.js';
import { patchCharacterWorld } from './modal/commit.js';
import { injectModal, openReviewModal, openOrphanModal } from './modal/orchestrator.js';
import { renderRagCard } from './modal/rag-workshop.js';
import { injectSettingsPanel } from './settings/panel.js';

console.log('[CNZ] index.js: Module loaded (all imports resolved).');

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

// ─── CNZ Core Helper ──────────────────────────────────────────────────────────

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
    state._lorebookSuggestions = enrichLbSuggestions(suggestions);
    for (const s of state._lorebookSuggestions) {
        if (s.linkedUid !== null) {
            const entry = state._draftLorebook?.entries?.[String(s.linkedUid)];
            if (entry) {
                entry.comment = s.name;
                entry.key     = s._aiSnapshot.keys;
                entry.content = s._aiSnapshot.content;
            }
        } else {
            const uid = nextLorebookUid();
            state._draftLorebook.entries[String(uid)] = makeLbDraftEntry(
                uid, s.name, s._aiSnapshot.keys, s._aiSnapshot.content,
            );
            s.linkedUid = uid;
        }
        s.status = 'pending';
    }
    await lbSaveLorebook(state._lorebookName, state._draftLorebook);
    state._lorebookData = structuredClone(state._draftLorebook);
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
 * Commits the current sync cycle to the DNA chain by writing a CnzAnchor
 * onto the last pair of the sync window.
 * @param {object}   char      Character object from ST context.
 * @param {object[]} messages  Full chat message array.
 * @returns {Promise<void>}
 */
async function commitDnaAnchor(messages) {
    if (state._stagedProsePairs.length === 0) {
        console.warn('[CNZ] commitDnaAnchor: no staged pairs — skipping anchor write');
        return;
    }

    const anchorPairIdx = state._stagedProsePairs.length - 1;
    const anchorPair   = state._stagedProsePairs[anchorPairIdx];

    const lkg        = getLkgAnchor(messages);
    const parentUuid = lkg?.anchor?.uuid ?? null;

    const ragHeaders = state._ragChunks
        .filter(c => c.status === 'complete' || c.status === 'manual')
        .map(c => ({ chunkIndex: c.chunkIndex, header: c.header, turnRange: c.turnRange, pairStart: state._stagedPairOffset + c.pairStart, pairEnd: state._stagedPairOffset + c.pairEnd }));

    const anchor = buildAnchorPayload({
        uuid:        crypto.randomUUID(),
        committedAt: new Date().toISOString(),
        hooks:       state._priorSituation,
        lorebook:    Object.assign({ name: state._lorebookName }, structuredClone(state._draftLorebook ?? { entries: {} })),
        ragUrl:      state._lastRagUrl || null,
        ragHeaders,
        parentUuid,
    });

    await writeDnaAnchor(anchorPair, anchor);
    await writeDnaLinks(state._stagedProsePairs, anchorPairIdx, anchor.uuid, state._stagedPairOffset);

    state._dnaChain = readDnaChain(SillyTavern.getContext().chat ?? []);
    setDnaChain(state._dnaChain);
    console.log('[CNZ] commitDnaAnchor: anchor written uuid=' + anchor.uuid + ' pairs=' + state._stagedProsePairs.length);
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
    const { syncPairs, syncPairOffset } = computeSyncWindow(allPairs, messages, settings, coverAll, state._dnaChain);

    if (syncPairs.length === 0) {
        console.warn('[CNZ] runCnzSync: no uncommitted pairs in window — aborting');
        setSyncInProgress(false);
        return;
    }

    // Stage pairs so commitDnaAnchor and runRagPipeline both land on the right range.
    state._stagedProsePairs = syncPairs;
    state._stagedPairOffset = syncPairOffset;

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
    if (!state._draftLorebook) {
        const lbName        = settings.lorebookName || char.name;
        state._lorebookName = lbName;
        state._lorebookData = await lbEnsureLorebook(state._lorebookName);
        state._draftLorebook = structuredClone(state._lorebookData);
        console.log(`[CNZ] Lorebook lazy-loaded: "${state._lorebookName}" (${Object.keys(state._lorebookData.entries ?? {}).length} entries)`);
    }
    // Link lorebook to character if not already set.
    if (char?.data?.extensions?.world !== state._lorebookName) {
        try {
            await patchCharacterWorld(char, state._lorebookName);
            console.log(`[CNZ] Lorebook linked to character: "${char.name}" → "${state._lorebookName}"`);
        } catch (e) {
            console.error('[CNZ] Lorebook link failed:', e.message ?? e);
        }
    }

    // --- LANE 1: LOREBOOK (Independent) ---
    const lbPromise = (async () => {
        console.log('[CNZ] Lane 1 (lorebook): starting');
        try {
            const text = await runLorebookSyncCall(lbTranscript, state._lorebookData);
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
            const text = await runHookseekerCall(hookTranscript, state._priorSituation);
            await processHooksUpdate(text);
            state._priorSituation = text;
            console.log('[CNZ] Lane 2 (hooks): ✓ ok');
            return true;
        } catch (e) {
            console.error('[CNZ] Lane 2 (hooks): ✗ failed —', e.message ?? e, e);
            state._priorSituation = 'Current Action';
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
        const newUuid = state._dnaChain.lkg?.uuid ?? null;
        if (newUuid) writeCnzSummaryPrompt(char.avatar, state._priorSituation, newUuid);
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

    state._pendingOrphans = existing;
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
    state._stagedProsePairs       = [];
    state._stagedPairOffset       = 0;
    state._splitPairIdx           = 0;
    state._ragChunks              = [];
    clearChunkChatLabels();
}

function resetSessionState() {
    invalidateAllJobs();
    resetScheduler();
    state._dnaChain               = null;
    setDnaChain(null);
    state._lorebookData           = null;
    state._draftLorebook          = null;
    state._lorebookName           = '';
    state._lorebookSuggestions    = [];
    state._parentNodeLorebook     = null;
    state._priorSituation         = '';
    state._beforeSituation        = '';
    state._lastRagUrl             = '';
    resetStagedState();
}

function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        state._lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    // Character switched — reset all session state, then heal.
    if (!char || char.avatar !== state._lastKnownAvatar) {
        state._lastKnownAvatar = char?.avatar ?? null;
        resetSessionState();
        const chatMessages = SillyTavern.getContext().chat ?? [];
        state._dnaChain = readDnaChain(chatMessages);
        setDnaChain(state._dnaChain);
        syncCnzSummaryOnCharacterSwitch(char, state._dnaChain);
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
    const lkgIdx        = state._dnaChain?.lkgMsgIdx ?? -1;
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
    console.log('[CNZ] injectWandButton: Checking for #extensionsMenu...');
    if ($('#cnz-wand-btn').length) return;
    const $menu = $('#extensionsMenu');
    if ($menu.length === 0) {
        console.warn('[CNZ] injectWandButton: #extensionsMenu not found in DOM!');
        return;
    }
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
    $menu.append(btn);
    console.log('[CNZ] injectWandButton: Success.');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    console.log('[CNZ] init: Starting sequence...');
    try {
    initSettings();
    console.log('[CNZ] init: Settings initialized.');
    initScheduler(Triggers, getSettings);
    console.log('[CNZ] init: Scheduler initialized.');
    injectModal();
    console.log('[CNZ] init: Modal injected.');
    injectSettingsPanel();
    console.log('[CNZ] init: Settings panel injected.');
    injectWandButton();
    console.log('[CNZ] init: Wand button injected.');
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
        openOrphanModal(state._pendingOrphans);
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
        const chunk = state._ragChunks[inputs?.chunkIndex];
        if (!chunk) return;
        chunk.status = 'in-flight';
        renderRagCard(inputs.chunkIndex);
    });

    // RAG fan-out: apply chunk results when all jobs settle
    on(BUS_EVENTS.CYCLE_STORE_UPDATED, ({ key, value }) => {
        if (key !== 'rag_chunk_results' || !value) return;
        for (const { chunkIndex, header } of value) {
            const chunk = state._ragChunks[chunkIndex];
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

    console.log('[CNZ] init: Full sequence complete.');
    } catch (err) {
        console.error('[CNZ] CRITICAL FAILURE during init:', err);
    }
}

await init().catch(err => console.error('[CNZ] init() top-level rejection:', err));
