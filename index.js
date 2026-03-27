/**
 * @file data/default-user/extensions/canonize/index.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
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
import { extension_settings } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { buildSettingsHTML } from './ui.js';
import { emit, on, off, enableDevMode, BUS_EVENTS } from './bus.js';
import { dispatchContract, setCurrentSettings, invalidateAllJobs } from './cycleStore.js';
import { initScheduler, setSyncInProgress, isSyncInProgress,
         snooze, resetScheduler, setDnaChain, getGap } from './scheduler.js';
import { Triggers } from './recipes.js';
import './executor.js';   // self-registers its CONTRACT_DISPATCHED handler on import
import './logger.js';    // console observer for LLM call lifecycle
import { DEFAULT_LOREBOOK_SYNC_PROMPT, DEFAULT_HOOKSEEKER_PROMPT,
         DEFAULT_RAG_CLASSIFIER_PROMPT,
         DEFAULT_TARGETED_UPDATE_PROMPT, DEFAULT_TARGETED_NEW_PROMPT } from './defaults.js';
import { state, EXT_NAME, escapeHtml } from './state.js';
import { getSettings, getMetaSettings, initSettings } from './core/settings.js';
import { buildTranscript, buildProsePairs } from './core/transcript.js';
import { runLorebookSyncCall, runHookseekerCall } from './core/llm-calls.js';
import { readDnaChain, getLkgAnchor, buildAnchorPayload,
         writeDnaAnchor, writeDnaLinks } from './core/dna-chain.js';
import { writeCnzSummaryPrompt, syncCnzSummaryOnCharacterSwitch } from './core/summary-prompt.js';
import { runHealer, purgeAndRebuild } from './core/healer.js';
import { lbEnsureLorebook, lbSaveLorebook } from './lorebook/api.js';
import { parseLbSuggestions, enrichLbSuggestions,
         nextLorebookUid, makeLbDraftEntry, formatLorebookEntries } from './lorebook/utils.js';
import { uploadRagFile, registerCharacterAttachment,
         cnzAvatarKey, cnzFileName, cnzDeleteFile } from './rag/api.js';
import { buildRagChunks, buildRagDocument, runRagPipeline,
         waitForRagChunks, hydrateChunkHeadersFromChat,
         writeChunkHeaderToChat, renderRagCard,
         renderChunkChatLabel, clearChunkChatLabels } from './rag/pipeline.js';
import { patchCharacterWorld } from './modal/commit.js';
import { injectModal, openReviewModal,
         openDnaChainInspector, openOrphanModal } from './modal/orchestrator.js';

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

// ─── Local Constants ──────────────────────────────────────────────────────────

const DEFAULT_CONCURRENCY = 3;   // default for maxConcurrentCalls setting
const DEFAULT_SEPARATOR   = 'Chunk {{chunk_number}} ({{turn_range}})'; // RAG separator default








































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
