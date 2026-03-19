/**
 * @file data/default-user/extensions/stne/index.js
 * @stamp {"utc":"2026-03-19T00:00:00.000Z"}
 * @architectural-role Feature Entry Point
 * @description
 * SillyTavern Narrative Engine (STNE) — autonomous background engine that
 * silently fires AI calls every N turns to update the narrative lorebook and
 * build RAG chunks, then commits results without user intervention.
 * A lightweight review modal is optional (Phase 3). The Ledger engine tracks
 * narrative milestones via hash chaining and enables the Healer, which detects
 * chat branches and restores the correct lorebook/vector state for the active
 * timeline (Phase 4).
 *
 * Phase 1: Skeleton & Ledger Foundation
 * Phase 2: Fact-Finder (background sync) — runStneSync fully implemented
 *   - Fact-Finder: lorebook updates from last N turns
 *   - Hookseeker: narrative thread summary written to scenario anchor block
 *   - RAG chunks built, classified, uploaded as chat attachment
 *   - Ledger node committed after each successful sync
 */

import { generateRaw, saveSettingsDebounced, getRequestHeaders, eventSource, event_types, callPopup } from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { ConnectionManagerRequestService } from '../../shared.js';
import { buildModalHTML } from './ui.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EXT_NAME            = 'stne';
const DEFAULT_LOOKBACK    = 1;
const DEFAULT_CONCURRENCY = 5;
const HOOKS_START         = '<!-- STNE_HOOKS_START -->';
const HOOKS_END           = '<!-- STNE_HOOKS_END -->';

const DEFAULT_FACT_FINDER_PROMPT = `
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
- Ignore the GLOBAL CHAPTER SUMMARY except as loose context.

Focus priority:
- Most significant narrative moment only
- Present tense, concise (2–3 sentences max)

Example:
TARGET TURNS: [character finds hidden letter] [reads it] [gasps] "It was you all along."
Header: The protagonist discovers undeniable proof of betrayal in the hidden letter. Shock and realization hit as the truth becomes clear

GLOBAL CHAPTER SUMMARY (context only — do NOT classify):
{{summary}}
{{context_block}}

TARGET TURNS:
{{target_turns}}
`;

const SETTINGS_DEFAULTS = Object.freeze({
    chunkEveryN:          20,
    hookseekerHorizon:    70,
    autoSync:             true,
    profileId:            null,
    ragProfileId:         null,
    ragMaxTokens:         100,
    ragClassifierPrompt:  DEFAULT_RAG_CLASSIFIER_PROMPT,
    factFinderPrompt:     DEFAULT_FACT_FINDER_PROMPT,
    hookseekerPrompt:     DEFAULT_HOOKSEEKER_PROMPT,
});

// ─── Session State ─────────────────────────────────────────────────────────────
// Primary STNE state — persists across sync cycles.

let _lorebookData   = null;  // {entries:{}} — server copy of the active lorebook
let _draftLorebook  = null;  // working copy for staged changes
let _ledgerManifest = null;  // in-memory manifest fetched/bootstrapped on demand
let _sessionStartId = null;  // headNodeId captured at session start

// Concurrency guard — prevents overlapping syncs
let _syncInProgress = false;

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
let _lastSummaryUsedForRag = null;
let _splitPairIdx          = 0;

// Ledger node fields — set each sync cycle
let _chapterName   = '';
let _lastRagUrl    = '';
let _lorebookDelta = null;
let _baseScenario   = '';
let _priorSituation = '';

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
let _lorebookFreeformLastParsed = null;
let _lorebookRawText         = '';
let _ragRawDetached          = false;
let _splitIndexWhenRagBuilt  = null;  // _splitPairIdx at last chunk build; null = not built

// Finalize step flags — reset on initWizardSession, idempotent on retry
const _finalizeSteps = { lorebookSaved: false, ragSaved: false };

// ─── Settings ─────────────────────────────────────────────────────────────────

function getSettings() {
    return extension_settings[EXT_NAME];
}

function initSettings() {
    extension_settings[EXT_NAME] = Object.assign(
        {},
        SETTINGS_DEFAULTS,
        extension_settings[EXT_NAME],
    );
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Escapes a string for safe embedding in a RegExp pattern. */
function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '');
}

// ─── Scenario Anchor Management ───────────────────────────────────────────────

/**
 * Returns the text between the STNE hooks anchor comments, or null if absent.
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
 * Replaces the content between the STNE hooks anchor comments with `newContent`.
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
 * Skips system messages. Only complete user→AI pairs are included.
 * @param {object[]} messages
 * @returns {{user: object, ai: object, userId: *, aiId: *, validIdx: number}[]}
 */
function buildProsePairs(messages) {
    const valid = messages.filter(m => !m.is_system && m.mes !== undefined);
    const pairs = [];
    for (let i = 0; i < valid.length - 1; i++) {
        if (valid[i].is_user && !valid[i + 1].is_user) {
            pairs.push({
                user:     valid[i],
                ai:       valid[i + 1],
                userId:   valid[i].id ?? i,
                aiId:     valid[i + 1].id ?? (i + 1),
                validIdx: i,
            });
        }
    }
    return pairs;
}

// ─── Narrative Memory (RAG) ───────────────────────────────────────────────────

/**
 * Builds the final RAG document from the workshop chunk state.
 * When ragSummaryOnly is ON, writes only the header list (no dialogue body).
 * @param {Array} ragChunks
 * @returns {string}
 */
function buildRagDocument(ragChunks) {
    if (!ragChunks.length) return '';
    if (getSettings().ragSummaryOnly) {
        return ragChunks
            .map(c => `[Event ${c.chunkIndex + 1}]: ${c.header}`)
            .join('\n\n');
    }
    return ragChunks
        .map(c => `### ${c.header}\n\n${c.content}`)
        .join('\n\n***\n\n');
}

/**
 * Builds the _ragChunks state array from the staged prose pairs.
 * Qvink mode: 1:1 mapping. Standard mode: 2-pair sliding window.
 * @param {Array} pairs
 * @returns {Array}
 */
function buildRagChunks(pairs) {
    const chunks   = [];
    const useQvink = getSettings().useQvink;

    for (let i = 0; i < pairs.length; i++) {
        const window = useQvink ? pairs.slice(i, i + 1) : pairs.slice(i, i + 2);
        const turnA  = i + 1;
        const turnB  = Math.min(i + 2, pairs.length);
        const turnLabel = useQvink
            ? `Turn ${turnA}`
            : (turnA === turnB
                ? `Chunk ${i + 1} (Turn ${turnA})`
                : `Chunk ${i + 1} (Turns ${turnA}–${turnB})`);

        const content = window
            .map(p => `[${p.user.name.toUpperCase()}]\n${p.user.mes}\n\n[${p.ai.name.toUpperCase()}]\n${p.ai.mes}`)
            .join('\n\n');

        const qvinkText = useQvink ? (pairs[i].ai?.extra?.qvink_memory?.memory || null) : null;

        chunks.push({
            chunkIndex: i,
            pairStart:  i,
            turnLabel,
            content,
            header:  qvinkText || turnLabel,
            status:  (useQvink && qvinkText) ? 'complete' : 'pending',
            genId:   0,
        });
    }
    return chunks;
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
    const $card = $(`.stne-rag-card[data-chunk-index="${chunkIndex}"]`);
    if (!$card.length) return;

    const isInFlight = chunk.status === 'in-flight';
    const isPending  = chunk.status === 'pending';
    const queuePos   = _ragCallQueue.indexOf(chunkIndex);
    const queueText  = queuePos >= 0 ? `queued ${queuePos + 1}` : 'pending';
    const disabled   = isInFlight || _ragRawDetached;

    $card.attr('data-status', chunk.status);
    const $header = $card.find('.stne-rag-card-header').val(chunk.header).prop('disabled', disabled);
    autoResizeRagCardHeader($header[0]);
    $card.find('.stne-rag-card-spinner').toggleClass('stne-hidden', !isInFlight);
    $card.find('.stne-rag-queue-label').toggleClass('stne-hidden', !isPending).text(queueText);
    $card.find('.stne-rag-card-regen').prop('disabled', _ragRawDetached);
}

/**
 * Fires a single RAG classifier call for the chunk at chunkIndex.
 * Respects per-chunk genId and global ragGlobalGenId for staleness detection.
 * @param {number} chunkIndex
 */
async function ragFireChunk(chunkIndex) {
    const chunk = _ragChunks[chunkIndex];
    if (!chunk) return;
    const localGenId       = ++chunk.genId;
    const globalGenId      = _ragGlobalGenId;
    const summaryAtCall    = _lastSummaryUsedForRag;
    const lookback         = getSettings().classifierLookback ?? DEFAULT_LOOKBACK;

    chunk.status = 'in-flight';
    _ragInFlightCount++;
    console.log(`[STNE-DBG] ragFireChunk START chunk=${chunkIndex} localGenId=${localGenId} globalGenId=${globalGenId} inFlight=${_ragInFlightCount} queue=${_ragCallQueue.length}`);
    renderRagCard(chunkIndex);

    try {
        const contextPairs = _stagedProsePairs.slice(Math.max(0, chunkIndex - lookback), chunkIndex);
        const windowSize   = getSettings().useQvink ? 1 : 2;
        const targetPairs  = _stagedProsePairs.slice(chunkIndex, Math.min(chunkIndex + windowSize, _splitPairIdx));
        const header       = await runRagClassifierCall(summaryAtCall, contextPairs, targetPairs);

        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        console.log(`[STNE-DBG] ragFireChunk RESPONSE chunk=${chunkIndex} globalStale=${globalStale} localStale=${localStale} inFlight=${_ragInFlightCount}`);
        if (globalStale || localStale) return;

        if (_lastSummaryUsedForRag !== summaryAtCall) {
            chunk.status = 'stale';
        } else {
            chunk.header = header.trim() || chunk.turnLabel;
            chunk.status = 'complete';
        }
    } catch (err) {
        const globalStale = _ragGlobalGenId !== globalGenId;
        const localStale  = chunk.genId !== localGenId;
        console.error(`[STNE-DBG] ragFireChunk ERROR chunk=${chunkIndex} globalStale=${globalStale} localStale=${localStale} inFlight=${_ragInFlightCount}`, err);
        if (err.cause) console.error(`[STNE-DBG] ragFireChunk ERROR cause:`, err.cause);
        if (globalStale || localStale) return;
        chunk.status = 'pending';
    } finally {
        const globalStale = _ragGlobalGenId !== globalGenId;
        console.log(`[STNE-DBG] ragFireChunk FINALLY chunk=${chunkIndex} globalStale=${globalStale} inFlight(before)=${_ragInFlightCount} — will decrement: ${!globalStale}`);
        if (!globalStale) {
            _ragInFlightCount = Math.max(0, _ragInFlightCount - 1);
            ragDrainQueue();
        }
    }

    if (_ragGlobalGenId === globalGenId) {
        renderRagCard(chunkIndex);
    }
}

/**
 * Fires queued chunks up to the maxConcurrentCalls limit.
 */
function ragDrainQueue() {
    const max = getSettings().maxConcurrentCalls ?? DEFAULT_CONCURRENCY;
    console.log(`[STNE-DBG] ragDrainQueue inFlight=${_ragInFlightCount} max=${max} queue=${JSON.stringify(_ragCallQueue)}`);
    while (_ragInFlightCount < max && _ragCallQueue.length > 0) {
        const idx = _ragCallQueue.shift();
        ragFireChunk(idx);
    }
    if (_ragInFlightCount >= max && _ragCallQueue.length > 0) {
        console.warn(`[STNE-DBG] ragDrainQueue BLOCKED — inFlight=${_ragInFlightCount} >= max=${max}, ${_ragCallQueue.length} chunks still queued`);
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
    console.warn('[STNE] waitForRagChunks timed out — some chunks may be incomplete.');
}

/**
 * Builds and fires the prompt for a single RAG classification call.
 * @param {string} summaryText
 * @param {Array}  contextPairs
 * @param {Array}  targetPairs
 * @returns {Promise<string>}
 */
async function runRagClassifierCall(summaryText, contextPairs, targetPairs) {
    const formatPairs = pairs => pairs
        .map(p => `[${p.user.name.toUpperCase()}]\n${p.user.mes}\n\n[${p.ai.name.toUpperCase()}]\n${p.ai.mes}`)
        .join('\n\n');

    const contextBlock = contextPairs.length > 0
        ? `CONTEXT TURNS (for background only — do NOT classify these):\n${formatPairs(contextPairs)}\n\n`
        : '';

    const promptTemplate = getSettings().ragClassifierPrompt || DEFAULT_RAG_CLASSIFIER_PROMPT;
    const prompt = interpolate(promptTemplate, {
        summary:       summaryText,
        context_block: contextBlock,
        target_turns:  formatPairs(targetPairs),
    });

    return generateWithRagProfile(prompt);
}

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
 * Registers a Data Bank file as a character attachment.
 * In Phase 2 the `key` is the chat filename (char.chat), not the avatar key,
 * so RAG files are scoped to the specific chat that generated them.
 * @param {string} key      Attachment scope key (chat filename for STNE syncs).
 * @param {string} url      File URL returned by uploadRagFile.
 * @param {string} fileName Human-readable file name.
 * @param {number} byteSize Byte length of the uploaded text.
 */
function registerCharacterAttachment(key, url, fileName, byteSize) {
    if (!extension_settings.character_attachments) {
        extension_settings.character_attachments = {};
    }
    if (!Array.isArray(extension_settings.character_attachments[key])) {
        extension_settings.character_attachments[key] = [];
    }
    extension_settings.character_attachments[key].push({
        url,
        size:    byteSize,
        name:    fileName,
        created: Date.now(),
    });
    saveSettingsDebounced();
}

// ─── LLM Calls ────────────────────────────────────────────────────────────────

async function generateWithProfile(prompt, maxTokens = null) {
    const profileId = getSettings().profileId;
    if (profileId) {
        const result = await ConnectionManagerRequestService.sendRequest(profileId, prompt, maxTokens);
        return result.content;
    }
    return generateRaw({ prompt, trimNames: false, responseLength: maxTokens });
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
 * Fires the Fact-Finder AI call. Requires _lorebookData to be loaded.
 * @param {string} transcript
 * @returns {Promise<string>}
 */
async function runFactFinderCall(transcript) {
    const prompt = interpolate(getSettings().factFinderPrompt || DEFAULT_FACT_FINDER_PROMPT, {
        lorebook_entries: formatLorebookEntries(_lorebookData),
        transcript,
    });
    return generateWithProfile(prompt);
}

/**
 * Fires the Hookseeker AI call.
 * @param {string} transcript
 * @returns {Promise<string>}
 */
async function runHookseekerCall(transcript) {
    const prompt = interpolate(getSettings().hookseekerPrompt || DEFAULT_HOOKSEEKER_PROMPT, {
        transcript,
    });
    return generateWithProfile(prompt);
}

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
    }
    return lbGetLorebook(name);
}

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
 * Applies the reverse of a lorebookDelta to `lbData`, returning the reverted copy.
 * - Deletes entries that were created in that delta (createdUids).
 * - Restores the previous content/keys for entries that were modified.
 * Pure function — does not mutate the input.
 * @param {object} lbData  Live lorebook data ({ entries: {} }).
 * @param {object} delta   Delta stored in the Ledger node snapshot.
 * @returns {object}       Reverted lorebook data.
 */
function revertLorebookDelta(lbData, delta) {
    if (!delta) return structuredClone(lbData);
    const entries = { ...lbData.entries };

    for (const uid of (delta.createdUids ?? [])) {
        delete entries[String(uid)];
    }

    for (const [uid, prev] of Object.entries(delta.modifiedEntries ?? {})) {
        const existing = entries[String(uid)];
        if (existing) {
            entries[String(uid)] = { ...existing, content: prev.content, key: [...(prev.key ?? [])] };
        }
    }

    return { ...lbData, entries };
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
 * _lorebookSuggestions array, preserving UID anchors and applied/rejected flags.
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
                    _applied:    true,
                    _rejected:   false,
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
            console.warn(`[STNE] Two lorebook suggestions resolved to uid ${s.linkedUid}; treating second as NEW.`);
            s.linkedUid = null;
        } else {
            seenUids.add(s.linkedUid);
        }
    }

    return enriched;
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
    formData.append('tags',                      JSON.stringify(char.tags              ?? []));
    formData.append('creator',                   char.data?.creator                    ?? '');
    formData.append('character_version',         char.data?.character_version          ?? '');
    formData.append('alternate_greetings',       JSON.stringify(char.data?.alternate_greetings ?? []));
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

// ─── Narrative Ledger Engine ──────────────────────────────────────────────────

/**
 * Returns the sanitized Data Bank filename for a given character avatar key.
 * @param {string} avatarKey  e.g. "seraphina.png"
 * @returns {string}          e.g. "stne_ledger_seraphina.png.json"
 */
function ledgerFileName(avatarKey) {
    const safe = avatarKey.replace(/[^A-Za-z0-9_\-.]/g, '_');
    return `stne_ledger_${safe}.json`;
}

/**
 * Fetches the ledger for `avatarKey` or bootstraps a fresh empty manifest.
 * Sets `_ledgerManifest` and `_sessionStartId`.
 * @param {string} avatarKey
 */
async function fetchOrBootstrapLedger(avatarKey) {
    const storedPath = (getSettings().ledgerPaths ?? {})[avatarKey];
    if (storedPath) {
        try {
            const res = await fetch(storedPath);
            if (res.ok) {
                const manifest   = await res.json();
                _ledgerManifest  = manifest;
                _sessionStartId  = manifest.headNodeId;
                return;
            }
        } catch (_) { /* fall through to bootstrap */ }
    }
    _ledgerManifest = { storyId: crypto.randomUUID(), headNodeId: null, nodes: {} };
    _sessionStartId = null;
}

/**
 * Re-fetches the ledger and compares its `headNodeId` against `_sessionStartId`.
 * Returns true only if nothing committed between session-open and now.
 * @param {string} avatarKey
 * @returns {Promise<boolean>}
 */
async function verifyFreshnessLock(avatarKey) {
    const storedPath = (getSettings().ledgerPaths ?? {})[avatarKey];
    if (!storedPath) {
        return _sessionStartId === null;
    }
    try {
        const res = await fetch(storedPath);
        if (!res.ok) return false;
        const freshManifest = await res.json();
        if (freshManifest.headNodeId !== _sessionStartId) return false;
        _ledgerManifest = freshManifest;
        return true;
    } catch (_) {
        return false;
    }
}

/**
 * Constructs a new LedgerNode from current session state.
 * TODO Phase 4: pass bio/situation programmatically rather than via module state.
 * @param {string|null} parentNodeId
 * @param {number}      sequenceNum
 * @param {object}      chatMetadata
 * @returns {object}
 */
function buildLedgerNode(parentNodeId, sequenceNum, chatMetadata, milestoneHash = null) {
    const ctx  = SillyTavern.getContext();
    const char = ctx.characters[ctx.characterId];
    return {
        nodeId:        crypto.randomUUID(),
        parentId:      parentNodeId,
        sequenceNum,
        status:        'active',
        milestoneHash: milestoneHash,
        filePointers: {
            chatFile:       _chapterName,
            ragFile:        _lastRagUrl ?? '',
            lorebookName:   _lorebookName,
            targetAvatar:   char.avatar,
            sourceChatId:   char.chat ?? '',
            sourceAvatar:   char.avatar,
            sourceCharName: char.name,
        },
        snapshot: {
            baseScenario:  _baseScenario,
            priorSituation: _priorSituation,
            chatMetadata,
            lorebookDelta:  _lorebookDelta ?? { createdUids: [], modifiedEntries: {} },
        },
    };
}

/**
 * Deletes the old ledger file, uploads the current `_ledgerManifest` as JSON,
 * and stores the new path in settings.
 * @param {string} avatarKey
 */
async function commitLedgerManifest(avatarKey) {
    const storedPaths = getSettings().ledgerPaths ?? {};
    const oldPath     = storedPaths[avatarKey];
    if (oldPath) {
        try {
            await fetch('/api/files/delete', {
                method:  'POST',
                headers: getRequestHeaders(),
                body:    JSON.stringify({ path: oldPath }),
            });
        } catch (_) { /* already gone */ }
    }
    const fileName = ledgerFileName(avatarKey);
    const jsonStr  = JSON.stringify(_ledgerManifest);
    const res = await fetch('/api/files/upload', {
        method:  'POST',
        headers: getRequestHeaders(),
        body:    JSON.stringify({ name: fileName, data: utf8ToBase64(jsonStr) }),
    });
    if (!res.ok) throw new Error(`Ledger save failed (HTTP ${res.status})`);
    const { path } = await res.json();
    if (!getSettings().ledgerPaths) getSettings().ledgerPaths = {};
    getSettings().ledgerPaths[avatarKey] = path;
    saveSettingsDebounced();
}

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
 * Reverts the lorebook to the state recorded in `node` by inverting its delta.
 * Updates `_lorebookName`, `_lorebookData`, and `_draftLorebook` in place.
 * @param {object} node  Ledger node whose snapshot contains the delta to revert.
 */
async function restoreLorebookToNode(node) {
    const lbName = node.filePointers?.lorebookName || _lorebookName;
    const lbData = await lbGetLorebook(lbName);
    const reverted = revertLorebookDelta(lbData, node.snapshot?.lorebookDelta);
    await lbSaveLorebook(lbName, reverted);
    _lorebookName  = lbName;
    _lorebookData  = structuredClone(reverted);
    _draftLorebook = structuredClone(reverted);
}

/**
 * Restores the character's scenario hooks block to the state stored in `node`.
 * Reads `node.snapshot.priorSituation` and writes it back via patchCharacterScenario.
 * @param {object} char  Character object from ST context.
 * @param {object} node  Ledger node whose snapshot contains the prior situation.
 */
async function restoreHooksToNode(char, node) {
    const freshCtx  = SillyTavern.getContext();
    const freshChar = freshCtx.characters.find(c => c.avatar === char.avatar);
    if (!freshChar) throw new Error('Character not found in context for hooks restoration.');
    const priorSituation = node.snapshot?.priorSituation ?? '';
    const newScenario    = writeHookseekerBlock(freshChar.scenario ?? '', priorSituation);
    await patchCharacterScenario(freshChar, newScenario);
}

// ─── Modal: RAG Workshop Helpers ──────────────────────────────────────────────

/** Returns the compiled RAG document from current _ragChunks state. */
function compileRagFromChunks() { return buildRagDocument(_ragChunks); }

function autoResizeRagRaw() {
    const el = document.getElementById('stne-rag-raw');
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
<div class="stne-rag-card" data-chunk-index="${i}" data-status="${chunk.status}">
  <div class="stne-rag-card-header-row">
    <textarea class="stne-input stne-rag-card-header"
              data-chunk-index="${i}"
              ${isInFlight || _ragRawDetached ? 'disabled' : ''}>${escapeHtml(chunk.header)}</textarea>
    <span class="stne-rag-card-spinner fa-solid fa-spinner fa-spin${isInFlight ? '' : ' stne-hidden'}"></span>
    <span class="stne-rag-queue-label${isPending ? '' : ' stne-hidden'}">${queueText}</span>
    <button class="stne-btn stne-btn-secondary stne-btn-sm stne-rag-card-regen"
            data-chunk-index="${i}"
            title="Regenerate this chunk's semantic header"
            ${_ragRawDetached ? 'disabled' : ''}>&#x21bb;</button>
  </div>
  <div class="stne-rag-card-body">${escapeHtml(chunk.content)}</div>
</div>`;
}

function renderRagWorkshop() {
    const $cards = $('#stne-rag-cards').empty();
    for (const chunk of _ragChunks) {
        $cards.append(buildRagCardHTML(chunk));
    }
    $cards.find('.stne-rag-card-header').each(function () { autoResizeRagCardHeader(this); });
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
    ragFireChunk(chunkIndex);
}

function onRagTabSwitch(tabName) {
    $('#stne-rag-tab-bar .stne-tab-btn').each(function () {
        $(this).toggleClass('stne-tab-active', $(this).data('tab') === tabName);
    });
    $('#stne-rag-tab-sectioned').toggleClass('stne-hidden', tabName !== 'sectioned');
    $('#stne-rag-tab-raw').toggleClass('stne-hidden',      tabName !== 'raw');
    if (tabName === 'raw' && !_ragRawDetached) {
        $('#stne-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }
}

function onRagRawInput() {
    autoResizeRagRaw();
    if (!_ragRawDetached) {
        _ragRawDetached = true;
        $('#stne-rag-raw').addClass('stne-rag-detached');
        $('#stne-rag-raw-detached-label').removeClass('stne-hidden');
        $('#stne-rag-detached-warn').removeClass('stne-hidden');
        $('#stne-rag-detached-revert').removeClass('stne-hidden');
        $('.stne-rag-card-header, .stne-rag-card-regen').prop('disabled', true);
    }
}

function onRagRevertRaw() {
    _ragRawDetached = false;
    $('#stne-rag-raw').val(compileRagFromChunks()).removeClass('stne-rag-detached');
    autoResizeRagRaw();
    $('#stne-rag-raw-detached-label, #stne-rag-detached-warn, #stne-rag-detached-revert').addClass('stne-hidden');
    renderRagWorkshop();
}

function showRagNoSummaryMessage() {
    $('#stne-rag-no-summary').removeClass('stne-hidden');
    $('#stne-rag-tab-bar, #stne-rag-tab-sectioned, #stne-rag-tab-raw').addClass('stne-hidden');
    $('#stne-rag-detached-warn, #stne-rag-detached-revert').addClass('stne-hidden');
}

function hideRagNoSummaryMessage() {
    $('#stne-rag-no-summary').addClass('stne-hidden');
    $('#stne-rag-tab-bar').removeClass('stne-hidden');
    const activeTab = $('#stne-rag-tab-bar .stne-tab-active').data('tab') ?? 'sectioned';
    $('#stne-rag-tab-sectioned').toggleClass('stne-hidden', activeTab !== 'sectioned');
    $('#stne-rag-tab-raw').toggleClass('stne-hidden', activeTab !== 'raw');
}

function getRagModeLabel() {
    return 'Output: AI-classified summary + full text';
}

function onEnterRagWorkshop() {
    $('#stne-rag-disabled').addClass('stne-hidden');
    $('#stne-rag-mode-note').text(getRagModeLabel()).removeClass('stne-hidden');

    const summaryText = $('#stne-situation-text').val().trim();
    const hasError    = !$('#stne-error-1').hasClass('stne-hidden');

    // Build or refresh chunks from staged pairs (already set by runStneSync)
    if (_ragChunks.length === 0 && _stagedProsePairs.length > 0) {
        const archivePairs = _stagedProsePairs.slice(0, _splitPairIdx);
        if (archivePairs.length > 0) {
            _ragChunks = buildRagChunks(archivePairs);
            _splitIndexWhenRagBuilt = _splitPairIdx;
        }
        renderRagWorkshop();
    } else if (_ragChunks.length > 0) {
        if (_splitIndexWhenRagBuilt !== null && _splitPairIdx !== _splitIndexWhenRagBuilt) {
            toastr.warning('Sync window has changed — Narrative Memory chunks will be rebuilt.');
            const archivePairs = _stagedProsePairs.slice(0, _splitPairIdx);
            _ragChunks = buildRagChunks(archivePairs);
            _splitIndexWhenRagBuilt = _splitPairIdx;
        }
        renderRagWorkshop();
    }

    if (!summaryText || hasError)  { showRagNoSummaryMessage(); return; }
    hideRagNoSummaryMessage();

    const activeTab = $('#stne-rag-tab-bar .stne-tab-active').data('tab') ?? 'sectioned';
    if (activeTab === 'raw' && !_ragRawDetached) {
        $('#stne-rag-raw').val(compileRagFromChunks());
        requestAnimationFrame(() => autoResizeRagRaw());
    }

    const summaryChanged = _lastSummaryUsedForRag !== null && _lastSummaryUsedForRag !== summaryText;
    if (summaryChanged) {
        toastr.warning('Hooks text has changed — stale headers will be refreshed.');
        for (const chunk of _ragChunks) {
            if (chunk.status === 'complete') chunk.status = 'stale';
        }
    }
    _lastSummaryUsedForRag = summaryText;

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

// ─── Modal: Hooks Workshop ────────────────────────────────────────────────────

function setHooksLoading(isLoading) {
    _hooksLoading = isLoading;
    $('#stne-spin-hooks').toggleClass('stne-hidden', !isLoading);
    $('#stne-regen-hooks').prop('disabled', isLoading);
    $('#stne-situation-text').prop('disabled', isLoading);
}

/**
 * Builds a rolling window transcript for modal AI calls.
 * @param {number} horizonTurns  Number of trailing turns to include.
 * @returns {string}
 */
function buildModalTranscript(horizonTurns) {
    const context      = SillyTavern.getContext();
    const messages     = context.chat ?? [];
    const allPairs     = buildProsePairs(messages);
    const windowPairs  = allPairs.slice(-horizonTurns);
    const windowMsgs   = windowPairs.flatMap(p => [p.user, p.ai]);
    return buildTranscript(windowMsgs);
}

function onRegenHooksClick() {
    setHooksLoading(true);
    $('#stne-error-1').addClass('stne-hidden').text('');
    const hooksId  = ++_hooksGenId;
    const horizon  = getSettings().hookseekerHorizon ?? 70;
    const transcript = buildModalTranscript(horizon);
    runHookseekerCall(transcript)
        .then(text => {
            if (_hooksGenId !== hooksId) return;
            $('#stne-situation-text').val(text.trim());
            setHooksLoading(false);
        })
        .catch(err => {
            if (_hooksGenId !== hooksId) return;
            $('#stne-error-1').text(`Hooks generation failed: ${err.message}`).removeClass('stne-hidden');
            setHooksLoading(false);
        });
}

// ─── Modal: Lorebook Workshop ─────────────────────────────────────────────────

function setLbLoading(isLoading) {
    _lorebookLoading = isLoading;
    $('#stne-lb-spinner').toggleClass('stne-hidden', !isLoading);
    $('#stne-lb-regen').prop('disabled', isLoading);
    $('#stne-lb-freeform').prop('disabled', isLoading);
    if (isLoading) $('#stne-lb-freeform').val('');
}

function populateLbFreeform(text) {
    setLbLoading(false);
    $('#stne-lb-freeform').val(text);
    _lorebookFreeformLastParsed = null;
    if (!$('#stne-lb-tab-ingester').hasClass('stne-hidden')) {
        const freshParsed = parseLbSuggestions(text);
        _lorebookSuggestions = enrichLbSuggestions(freshParsed);
        _lorebookFreeformLastParsed = text;
        _lbActiveIngesterIndex = Math.max(0, Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1));
        populateLbIngesterDropdown();
        if (_lorebookSuggestions[_lbActiveIngesterIndex]) renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
    }
}

function showLbError(message) {
    setLbLoading(false);
    $('#stne-lb-error').text(message).removeClass('stne-hidden');
}

function onLbRegenClick() {
    setLbLoading(true);
    $('#stne-lb-error').addClass('stne-hidden').text('');
    const lbId       = ++_lorebookGenId;
    const horizon    = getSettings().chunkEveryN ?? 20;
    const transcript = buildModalTranscript(horizon);
    runFactFinderCall(transcript)
        .then(text => { if (_lorebookGenId !== lbId) return; populateLbFreeform(text); })
        .catch(err => {
            if (_lorebookGenId !== lbId) return;
            showLbError(`Regeneration failed: ${err.message}`);
        });
}

function onLbTabSwitch(tabName) {
    $('#stne-lb-tab-bar .stne-tab-btn').each(function () {
        $(this).toggleClass('stne-tab-active', $(this).data('tab') === tabName);
    });
    $('#stne-lb-tab-freeform').toggleClass('stne-hidden',  tabName !== 'freeform');
    $('#stne-lb-tab-ingester').toggleClass('stne-hidden',  tabName !== 'ingester');

    if (tabName === 'ingester' && !_lorebookLoading) {
        const currentText = $('#stne-lb-freeform').val();
        if (currentText !== _lorebookFreeformLastParsed) {
            const freshParsed = parseLbSuggestions(currentText);
            _lorebookSuggestions = enrichLbSuggestions(freshParsed);
            _lorebookFreeformLastParsed = currentText;
            if (_lbActiveIngesterIndex >= _lorebookSuggestions.length) _lbActiveIngesterIndex = 0;
        }
        _lbActiveIngesterIndex = Math.max(0, Math.min(_lbActiveIngesterIndex, _lorebookSuggestions.length - 1));
        populateLbIngesterDropdown();
        if (_lorebookSuggestions[_lbActiveIngesterIndex]) renderLbIngesterDetail(_lorebookSuggestions[_lbActiveIngesterIndex]);
    }
}

function populateLbIngesterDropdown() {
    const $sel = $('#stne-lb-suggestion-select').empty();
    if (!_lorebookSuggestions.length) {
        $sel.append('<option disabled selected>(no suggestions — check Freeform tab or regen)</option>');
        $('#stne-lb-apply-one, #stne-lb-apply-all-unresolved').prop('disabled', true);
        $('#stne-lb-editor-name, #stne-lb-editor-keys, #stne-lb-editor-content').val('');
        $('#stne-lb-ingester-diff').empty();
        return;
    }
    _lorebookSuggestions.forEach((s, i) => {
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $sel.append(`<option value="${i}">${escapeHtml(`${prefix}${s.type}: ${s.name}`)}</option>`);
    });
    $sel.val(_lbActiveIngesterIndex);
    $('#stne-lb-apply-one, #stne-lb-apply-all-unresolved').prop('disabled', false);
}

function renderLbIngesterDetail(suggestion) {
    if (!suggestion) return;
    $('#stne-lb-editor-name').val(suggestion.name);
    $('#stne-lb-editor-keys').val(suggestion.keys.join(', '));
    $('#stne-lb-editor-content').val(suggestion.content);
    $('#stne-lb-error-ingester').addClass('stne-hidden').text('');
    $('#stne-lb-revert-draft').prop('disabled', suggestion.linkedUid === null);
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
        if (del.length) { out.push(`<span class="stne-diff-del">${escapeHtml(del.join(''))}</span>`); del = []; }
        if (ins.length) { out.push(`<span class="stne-diff-ins">${escapeHtml(ins.join(''))}</span>`); ins = []; }
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
    if (!s) return;
    const name    = $('#stne-lb-editor-name').val();
    const keys    = $('#stne-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#stne-lb-editor-content').val();
    const proposed = toVirtualDoc(name, keys, content);
    let base = '';
    if (s.linkedUid !== null) {
        const entry = _draftLorebook?.entries?.[String(s.linkedUid)];
        if (entry) base = toVirtualDoc(entry.comment || '', Array.isArray(entry.key) ? entry.key : [], entry.content || '');
    }
    $('#stne-lb-ingester-diff').html(wordDiff(base, proposed));
}

function onLbSuggestionSelectChange() {
    const idx = parseInt($('#stne-lb-suggestion-select').val(), 10);
    if (!isNaN(idx) && _lorebookSuggestions[idx]) {
        _lbActiveIngesterIndex = idx;
        renderLbIngesterDetail(_lorebookSuggestions[idx]);
    }
}

function onLbIngesterEditorInput() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (s) {
        const newName = $('#stne-lb-editor-name').val();
        s.name    = newName;
        s.keys    = $('#stne-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
        s.content = $('#stne-lb-editor-content').val();
        const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
        $('#stne-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${newName}`));
    }
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer = setTimeout(updateLbDiff, 100);
}

function onLbIngesterRevertAi() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    s.name = s._aiSnapshot.name; s.keys = [...s._aiSnapshot.keys]; s.content = s._aiSnapshot.content;
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#stne-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
}

function onLbIngesterRevertDraft() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s || s.linkedUid === null) return;
    const entry = _draftLorebook?.entries?.[String(s.linkedUid)];
    if (!entry) return;
    s.name = entry.comment || ''; s.keys = Array.isArray(entry.key) ? [...entry.key] : []; s.content = entry.content || '';
    renderLbIngesterDetail(s);
    const prefix = s._applied ? '\u2713 ' : (s._rejected ? '\u2717 ' : '');
    $('#stne-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`${prefix}${s.type}: ${s.name}`));
}

function onLbIngesterNext() {
    const total = _lorebookSuggestions.length;
    if (!total) return;
    for (let offset = 1; offset < total; offset++) {
        const i = (_lbActiveIngesterIndex + offset) % total;
        if (!_lorebookSuggestions[i]._applied && !_lorebookSuggestions[i]._rejected) {
            _lbActiveIngesterIndex = i;
            $('#stne-lb-suggestion-select').val(i);
            renderLbIngesterDetail(_lorebookSuggestions[i]);
            return;
        }
    }
    toastr.info('All lorebook suggestions have been reviewed.');
}

function onLbIngesterApply() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    const name    = $('#stne-lb-editor-name').val().trim();
    const keys    = $('#stne-lb-editor-keys').val().split(',').map(k => k.trim()).filter(Boolean);
    const content = $('#stne-lb-editor-content').val().trim();
    if (!name || !content) return;
    s.name = name; s.keys = keys; s.content = content;
    if (s.linkedUid !== null) {
        const entry = _draftLorebook.entries[String(s.linkedUid)];
        if (entry) { entry.comment = name; entry.key = keys; entry.content = content; }
    } else {
        const newUid = nextLorebookUid();
        _draftLorebook.entries[String(newUid)] = makeLbDraftEntry(newUid, name, keys, content);
        s.linkedUid = newUid;
        $('#stne-lb-revert-draft').prop('disabled', false);
    }
    s._applied = true; s._rejected = false;
    $('#stne-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`\u2713 ${s.type}: ${s.name}`));
    updateLbDiff();
}

function onLbIngesterReject() {
    const s = _lorebookSuggestions[_lbActiveIngesterIndex];
    if (!s) return;
    s._rejected = true; s._applied = false;
    $('#stne-lb-suggestion-select option').eq(_lbActiveIngesterIndex).text(escapeHtml(`\u2717 ${s.type}: ${s.name}`));
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
    toastr.success(`Applied ${count} lorebook suggestion${count !== 1 ? 's' : ''} — will be saved on Finalize.`);
}

// ─── Modal: Commit Receipts Panel ─────────────────────────────────────────────

function showReceiptsPanel() { $('#stne-receipts').removeClass('stne-hidden'); }

function showRecoveryGuide() {
    $('#stne-recovery-guide').removeClass('stne-hidden');
    $('#stne-cancel').text('Close');
}

function upsertReceiptItem(id, html) {
    if (!$(`#${id}`).length) {
        $('#stne-receipts-content').append(`<div id="${id}" class="stne-receipt-row"></div>`);
    }
    $(`#${id}`).html(html);
}

function receiptSuccess(text, hint = null) {
    return `<span class="stne-receipt-item success">&#x2713; ${escapeHtml(text)}</span>` +
           (hint ? `<div class="stne-receipt-hint">${escapeHtml(hint)}</div>` : '');
}

function receiptFailure(text) {
    return `<span class="stne-receipt-item failure">&#x2717; ${escapeHtml(text)}</span>`;
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
    if (!char || !getSettings().enableRag) { $('#stne-step4-rag').addClass('stne-hidden'); return; }
    const allAttachments = extension_settings.character_attachments?.[char.chat] ?? [];
    if (!allAttachments.length) { $('#stne-step4-rag').addClass('stne-hidden'); return; }
    const rows = allAttachments.map(a =>
        `<div class="stne-rag-item stne-rag-item--existing">&#x2713; ${escapeHtml(a.name.replace(/\.txt$/i, ''))}</div>`,
    );
    $('#stne-rag-timeline').html(rows.join(''));
    $('#stne-rag-warning').addClass('stne-hidden');
    $('#stne-step4-rag').removeClass('stne-hidden');
}

function populateStep4Summary() {
    const loreCount   = countDraftChanges();
    const loreLabel   = loreCount === 1 ? '1 entry' : `${loreCount} entries`;
    const pendingLb   = _lorebookSuggestions.filter(s => !s._applied && !s._rejected).length;
    const pendingText = pendingLb > 0
        ? ` \u26a0 ${pendingLb} suggestion${pendingLb !== 1 ? 's' : ''} pending review`
        : '';
    const hooksText    = $('#stne-situation-text').val().trim();
    const hooksPreview = hooksText.length > 100 ? hooksText.slice(0, 100) + '\u2026' : (hooksText || '(empty)');
    $('#stne-step4-hooks').text(`Hooks: ${hooksPreview}`);
    $('#stne-step4-lore').text(`Lore: ${loreLabel} staged for update/creation${pendingText}`);
    populateRagPanel();
}

function abortCommitWithError(message) {
    $('#stne-error-4').text(message).removeClass('stne-hidden');
    $('#stne-confirm, #stne-cancel, #stne-move-back').prop('disabled', false);
    showRecoveryGuide();
}

async function onConfirmClick() {
    const hooksText = $('#stne-situation-text').val().trim();

    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char) { toastr.error('STNE: No character in context.'); return; }

    $('#stne-confirm, #stne-cancel, #stne-move-back').prop('disabled', true);
    $('#stne-error-4').addClass('stne-hidden').text('');
    showReceiptsPanel();

    // Freshness lock — abort if another sync committed since modal opened
    if (!await verifyFreshnessLock(char.avatar)) {
        abortCommitWithError('Another sync committed since you opened this modal. Close and re-open to retry.');
        return;
    }

    // ── Step 1: Lorebook save ────────────────────────────────────────────────
    if (!_finalizeSteps.lorebookSaved) {
        if (_draftLorebook && _lorebookName) {
            try {
                const preLorebook = structuredClone(_lorebookData ?? { entries: {} });
                await lbSaveLorebook(_lorebookName, _draftLorebook);
                _lorebookData = structuredClone(_draftLorebook);

                const createdUids = [], modifiedEntries = {};
                for (const [uid, entry] of Object.entries(_draftLorebook.entries)) {
                    const orig = preLorebook.entries[uid];
                    if (!orig) {
                        createdUids.push(uid);
                    } else if (orig.content !== entry.content || JSON.stringify(orig.key) !== JSON.stringify(entry.key)) {
                        modifiedEntries[uid] = { content: orig.content, key: [...(orig.key ?? [])] };
                    }
                }
                _lorebookDelta = { createdUids, modifiedEntries };

                _finalizeSteps.lorebookSaved = true;
                const changedNames = Object.values(_draftLorebook.entries ?? {})
                    .filter(e => { const o = preLorebook.entries[String(e.uid)]; return !o || o.content !== e.content || JSON.stringify(o.key) !== JSON.stringify(e.key); })
                    .map(e => e.comment || String(e.uid));
                upsertReceiptItem('stne-receipt-lorebook', receiptSuccess(
                    `Lorebook committed: ${changedNames.length ? changedNames.map(n => `"${n}"`).join(', ') : '(no changes staged)'}`,
                ));
                $('#stne-cancel').text('Close');
            } catch (err) {
                upsertReceiptItem('stne-receipt-lorebook', receiptFailure(`Lorebook save failed: ${err.message}`));
                abortCommitWithError(err.message);
                return;
            }
        } else {
            _finalizeSteps.lorebookSaved = true;
            upsertReceiptItem('stne-receipt-lorebook', receiptSuccess('Lorebook: no changes staged'));
        }
    }

    // ── Step 2: RAG upload ───────────────────────────────────────────────────
    if (!_finalizeSteps.ragSaved) {
        try {
            const ragText = _ragRawDetached ? $('#stne-rag-raw').val() : buildRagDocument(_ragChunks);
            if (ragText.trim()) {
                const nonSystemCount = (context.chat ?? []).filter(m => !m.is_system).length;
                const ragFileName = `${char.name}_stne_t${nonSystemCount}.txt`
                    .replace(/\s+/g, '_').replace(/[^A-Za-z0-9_\-.]/g, '');
                const ragUrl  = await uploadRagFile(ragText, ragFileName);
                _lastRagUrl   = ragUrl;
                const byteSize = new TextEncoder().encode(ragText).length;
                registerCharacterAttachment(char.chat, ragUrl, ragFileName, byteSize);
                _finalizeSteps.ragSaved = true;
                upsertReceiptItem('stne-receipt-rag', receiptSuccess(`Narrative Memory saved: "${ragFileName}" (${_ragChunks.length} chunks)`));
            } else {
                _finalizeSteps.ragSaved = true;
                upsertReceiptItem('stne-receipt-rag', receiptSuccess('Narrative Memory: no chunks to upload'));
            }
        } catch (err) {
            upsertReceiptItem('stne-receipt-rag', receiptFailure(`RAG save failed: ${err.message}`));
            abortCommitWithError(`Lorebook saved — RAG upload failed: ${err.message}`);
            return;
        }
    }

    // ── Step 3: Hooks save ───────────────────────────────────────────────────
    try {
        const freshCtx  = SillyTavern.getContext();
        const freshChar = freshCtx.characters.find(c => c.avatar === char.avatar);
        if (freshChar && hooksText) {
            const newScenario = writeHookseekerBlock(freshChar.scenario ?? '', hooksText);
            await patchCharacterScenario(freshChar, newScenario);
            _priorSituation = hooksText;
            upsertReceiptItem('stne-receipt-hooks', receiptSuccess('Narrative Hooks updated in character scenario'));
        }
    } catch (err) {
        console.error('[STNE] Hooks save failed:', err);
        // Non-fatal — log and continue
        upsertReceiptItem('stne-receipt-hooks', receiptFailure(`Hooks save failed: ${err.message}`));
    }

    // ── Step 4: Ledger commit ────────────────────────────────────────────────
    try {
        const messages = context.chat ?? [];
        _chapterName = char.chat ?? '';

        const lastMsgIndex      = messages.length - 1;
        const headNode          = _ledgerManifest?.nodes?.[_ledgerManifest.headNodeId];
        const prevMilestoneHash = headNode?.milestoneHash ?? null;
        const milestoneHash     = lastMsgIndex >= 0
            ? await hashMilestone(messages, lastMsgIndex, prevMilestoneHash)
            : null;

        const nonSystemCount = messages.filter(m => !m.is_system).length;
        const node = buildLedgerNode(_sessionStartId, nonSystemCount, {}, milestoneHash);
        _ledgerManifest.nodes[node.nodeId] = node;
        _ledgerManifest.headNodeId         = node.nodeId;
        _sessionStartId                    = node.nodeId;

        await commitLedgerManifest(char.avatar);
        upsertReceiptItem('stne-receipt-ledger', receiptSuccess('Narrative Ledger updated'));
    } catch (err) {
        console.error('[STNE] Ledger commit failed:', err);
        upsertReceiptItem('stne-receipt-ledger', receiptFailure(`Ledger save failed: ${err.message} (content saved)`));
        // Non-fatal
    }

    $('#stne-confirm').addClass('stne-hidden');
    $('#stne-cancel').text('Close').prop('disabled', false);
}

// ─── Modal: Orchestration ─────────────────────────────────────────────────────

function injectModal() {
    if ($('#stne-overlay').length) return;
    $('body').append(buildModalHTML());

    // Step 1 — Hooks Workshop
    $('#stne-regen-hooks').on('click', onRegenHooksClick);

    // Step 2 — Lorebook Workshop
    $('#stne-lb-regen').on('click',                onLbRegenClick);
    $('#stne-lb-suggestion-select').on('change',   onLbSuggestionSelectChange);
    $('#stne-lb-editor-name').on('input',          onLbIngesterEditorInput);
    $('#stne-lb-editor-keys').on('input',          onLbIngesterEditorInput);
    $('#stne-lb-editor-content').on('input',       onLbIngesterEditorInput);
    $('#stne-lb-ingester-next').on('click',        onLbIngesterNext);
    $('#stne-lb-revert-ai').on('click',            onLbIngesterRevertAi);
    $('#stne-lb-revert-draft').on('click',         onLbIngesterRevertDraft);
    $('#stne-lb-reject-one').on('click',           onLbIngesterReject);
    $('#stne-lb-apply-one').on('click',            onLbIngesterApply);
    $('#stne-lb-apply-all-unresolved').on('click', onLbApplyAllUnresolved);
    $('#stne-modal').on('click', '#stne-lb-tab-bar .stne-tab-btn', function () {
        onLbTabSwitch($(this).data('tab'));
    });

    // Step 3 — Narrative Memory Workshop
    $('#stne-modal').on('click', '#stne-rag-tab-bar .stne-tab-btn', function () {
        onRagTabSwitch($(this).data('tab'));
    });
    $('#stne-modal').on('input', '.stne-rag-card-header', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        autoResizeRagCardHeader(this);
        if (!isNaN(idx) && _ragChunks[idx]) {
            _ragChunks[idx].header = $(this).val();
            _ragChunks[idx].status = 'manual';
            $(`.stne-rag-card[data-chunk-index="${idx}"]`).attr('data-status', 'manual');
        }
    });
    $('#stne-modal').on('click', '.stne-rag-card-regen', function () {
        const idx = parseInt($(this).data('chunk-index'), 10);
        if (!isNaN(idx)) ragRegenCard(idx);
    });
    $('#stne-rag-raw').on('input', onRagRawInput);
    $('#stne-rag-revert-raw-btn').on('click', onRagRevertRaw);

    // Shared wizard footer
    $('#stne-cancel').on('click',    closeModal);
    $('#stne-move-back').on('click', () => updateWizard(_currentStep - 1));
    $('#stne-move-next').on('click', () => updateWizard(_currentStep + 1));
    $('#stne-confirm').on('click',   onConfirmClick);
}

function showModal() {
    $('#stne-overlay').removeClass('stne-hidden');
}

function closeModal() {
    $('#stne-overlay').addClass('stne-hidden');
    // Kill all in-flight AI callbacks
    _hooksGenId++;
    _lorebookGenId++;
    _ragGlobalGenId++;
    // Reset modal session state
    _hooksLoading               = false;
    _lorebookLoading            = false;
    _lorebookSuggestions        = [];
    _lbActiveIngesterIndex      = 0;
    clearTimeout(_lbDebounceTimer);
    _lbDebounceTimer            = null;
    _lorebookFreeformLastParsed = null;
    _lorebookRawText            = '';
    _ragRawDetached             = false;
    _ragInFlightCount           = 0;
    _ragCallQueue               = [];
    _splitIndexWhenRagBuilt     = null;
    _currentStep                = 1;
    _finalizeSteps.lorebookSaved = false;
    _finalizeSteps.ragSaved      = false;
}

function initWizardSession() {
    $('#stne-lb-title').text(`Lorebook: ${_lorebookName}`);
    $('#stne-lb-freeform').val('');
    $('#stne-lb-error').addClass('stne-hidden').text('');
    $('#stne-lb-error-ingester').addClass('stne-hidden').text('');
    $('#stne-error-1').addClass('stne-hidden').text('');
    $('#stne-error-4').addClass('stne-hidden').text('');
    $('#stne-receipts').addClass('stne-hidden');
    $('#stne-receipts-content').empty();
    $('#stne-recovery-guide').addClass('stne-hidden');
    $('#stne-cancel').text('Cancel').prop('disabled', false);
    // RAG Workshop reset
    $('#stne-rag-cards').empty();
    $('#stne-rag-no-summary, #stne-rag-disabled').addClass('stne-hidden');
    $('#stne-rag-detached-warn, #stne-rag-detached-revert').addClass('stne-hidden');
    $('#stne-rag-raw').val('').removeClass('stne-rag-detached');
    $('#stne-rag-raw-detached-label').addClass('stne-hidden');
    $('#stne-rag-tab-bar .stne-tab-btn').each(function () {
        $(this).toggleClass('stne-tab-active', $(this).data('tab') === 'sectioned');
    });
    $('#stne-rag-tab-sectioned').removeClass('stne-hidden');
    $('#stne-rag-tab-raw').addClass('stne-hidden');
    // Lorebook ingester reset
    _lorebookSuggestions        = [];
    _lbActiveIngesterIndex      = 0;
    _lorebookFreeformLastParsed = null;
    _lorebookRawText            = '';
    // Finalize step flags
    _finalizeSteps.lorebookSaved = false;
    _finalizeSteps.ragSaved      = false;

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
        $(`#stne-step-${i}`).toggleClass('stne-hidden', i !== n);
    }
    $('#stne-move-back').toggleClass('stne-hidden', n === 1);
    $('#stne-move-next').toggleClass('stne-hidden', n === 4);
    $('#stne-confirm').toggleClass('stne-hidden',   n !== 4);
    if (n === 3) onEnterRagWorkshop();
    if (n === 4) populateStep4Summary();
}

/**
 * Opens the STNE review modal. Loads committed hooks from character scenario,
 * ensures lorebook and ledger are bootstrapped, then shows Step 1.
 * Called from the sync toast "Review" link.
 */
async function openReviewModal() {
    const ctx  = SillyTavern.getContext();
    const char = ctx?.characters?.[ctx?.characterId];
    if (!char) { toastr.error('STNE: No character selected.'); return; }

    // Ensure lorebook is loaded
    const lbName = getSettings().lorebookName || char.name;
    if (_lorebookName !== lbName || !_lorebookData) {
        try {
            _lorebookName  = lbName;
            _lorebookData  = await lbEnsureLorebook(_lorebookName);
            _draftLorebook = structuredClone(_lorebookData);
        } catch (err) {
            console.error('[STNE] openReviewModal: lorebook load failed:', err);
            _lorebookData  = { entries: {} };
            _draftLorebook = { entries: {} };
        }
    }

    // Ensure ledger is bootstrapped
    if (!_ledgerManifest) {
        await fetchOrBootstrapLedger(char.avatar).catch(err =>
            console.error('[STNE] openReviewModal: ledger bootstrap failed:', err),
        );
    }

    // Populate hooks from committed state (scenario anchor block)
    const hooksText = extractHookseekerBlock(char.scenario ?? '');
    $('#stne-situation-text').val(hooksText ?? '');

    initWizardSession();
    showModal();
    updateWizard(1);
}

// ─── STNE Core ────────────────────────────────────────────────────────────────

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
async function runStneSync(char, messages) {
    if (_syncInProgress) {
        console.warn('[STNE] Sync already in progress — skipping this trigger.');
        return;
    }
    _syncInProgress = true;

    const nonSystemCount = messages.filter(m => !m.is_system).length;
    console.log(`[STNE] runStneSync start — char=${char.name} turns=${nonSystemCount}`);

    // Step flags for toast reporting
    let lbOk     = false;
    let hooksOk  = false;
    let ragUrl   = null;
    let ledgerOk = false;

    try {
        // ── 1. Build turn window ──────────────────────────────────────────────
        const allPairs    = buildProsePairs(messages);
        const windowSize  = getSettings().chunkEveryN ?? 20;
        const windowPairs = allPairs.slice(-windowSize);

        if (!windowPairs.length) {
            console.log('[STNE] No complete pairs in window — skipping sync.');
            return;
        }

        // Build a transcript from only the window messages for AI calls
        const windowMessages = windowPairs.flatMap(p => [p.user, p.ai]);
        const transcript     = buildTranscript(windowMessages);

        // ── 2. Ensure lorebook is loaded ──────────────────────────────────────
        const lbName = getSettings().lorebookName || char.name;
        if (_lorebookName !== lbName || !_lorebookData) {
            _lorebookName  = lbName;
            _lorebookData  = await lbEnsureLorebook(_lorebookName);
            _draftLorebook = structuredClone(_lorebookData);
        }

        // ── 3. Bootstrap ledger if needed ─────────────────────────────────────
        if (!_ledgerManifest) {
            await fetchOrBootstrapLedger(char.avatar);
        }

        // ── 4. Fire Fact-Finder + Hookseeker in parallel ──────────────────────
        let factFinderText, hookseekerText;
        try {
            [factFinderText, hookseekerText] = await Promise.all([
                runFactFinderCall(transcript),
                runHookseekerCall(transcript),
            ]);
        } catch (err) {
            console.error('[STNE] AI calls failed:', err);
            toastr.warning(`STNE: AI calls failed — ${err.message}`);
            return; // cannot proceed without AI output
        }

        // ── 5. Apply Fact-Finder: parse → enrich → auto-apply → save ─────────
        try {
            const preLorebook = structuredClone(_lorebookData);
            const suggestions = parseLbSuggestions(factFinderText);

            // Reset suggestion list for this sync cycle (no carry-forward)
            _lorebookSuggestions = [];
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
                s._applied = true;
            }

            await lbSaveLorebook(_lorebookName, _draftLorebook);
            _lorebookData = structuredClone(_draftLorebook);

            // Record what changed for the Ledger snapshot
            const createdUids      = [];
            const modifiedEntries  = {};
            for (const [uid, entry] of Object.entries(_draftLorebook.entries)) {
                const orig = preLorebook.entries[uid];
                if (!orig) {
                    createdUids.push(uid);
                } else if (
                    orig.content !== entry.content ||
                    JSON.stringify(orig.key) !== JSON.stringify(entry.key)
                ) {
                    modifiedEntries[uid] = { content: orig.content, key: [...(orig.key ?? [])] };
                }
            }
            _lorebookDelta = { createdUids, modifiedEntries };
            lbOk = true;
            console.log(`[STNE] Lorebook updated: ${createdUids.length} created, ${Object.keys(modifiedEntries).length} modified.`);
        } catch (err) {
            console.error('[STNE] Lorebook update failed:', err);
            toastr.warning(`STNE: Lorebook update failed — ${err.message}`);
        }

        // ── 6. Write Hookseeker output into character scenario ────────────────
        try {
            const freshCtx  = SillyTavern.getContext();
            const freshChar = freshCtx.characters.find(c => c.avatar === char.avatar);
            if (!freshChar) throw new Error('Character not found in context after AI calls.');
            const newScenario = writeHookseekerBlock(freshChar.scenario ?? '', hookseekerText.trim());
            await patchCharacterScenario(freshChar, newScenario);
            hooksOk = true;
            console.log('[STNE] Scenario hooks block updated.');
        } catch (err) {
            console.error('[STNE] Scenario update failed:', err);
            toastr.warning(`STNE: Scenario update failed — ${err.message}`);
        }

        // ── 7. Build, classify, and upload RAG chunks ─────────────────────────
        try {
            // Set module state for ragFireChunk/ragDrainQueue machinery
            _stagedProsePairs      = windowPairs;
            _splitPairIdx          = windowPairs.length;   // all window pairs are archive
            _ragGlobalGenId++;                             // invalidate any stale callbacks
            _ragInFlightCount      = 0;
            _ragCallQueue          = [];
            _ragChunks             = buildRagChunks(windowPairs);
            _lastSummaryUsedForRag = hookseekerText.trim();

            // Enqueue all pending chunks and drain
            _ragCallQueue = _ragChunks
                .filter(c => c.status === 'pending')
                .map(c => c.chunkIndex);
            ragDrainQueue();

            await waitForRagChunks();

            const ragText     = buildRagDocument(_ragChunks);
            const ragFileName = `${char.name}_stne_t${nonSystemCount}.txt`
                .replace(/\s+/g, '_')
                .replace(/[^A-Za-z0-9_\-.]/g, '');
            ragUrl = await uploadRagFile(ragText, ragFileName);
            _lastRagUrl = ragUrl;

            const byteSize = new TextEncoder().encode(ragText).length;
            registerCharacterAttachment(char.chat, ragUrl, ragFileName, byteSize);
            console.log(`[STNE] RAG uploaded: ${ragFileName} (${_ragChunks.length} chunks, ${byteSize} bytes).`);
        } catch (err) {
            console.error('[STNE] RAG upload failed:', err);
            toastr.warning(`STNE: RAG upload failed — ${err.message}`);
        }

        // ── 8. Commit Ledger node ─────────────────────────────────────────────
        try {
            // Set node-level fields before calling buildLedgerNode
            _chapterName    = char.chat ?? '';
            _priorSituation = hookseekerText?.trim() ?? '';

            const lastMsgIndex      = messages.length - 1;
            const headNode          = _ledgerManifest?.nodes?.[_ledgerManifest.headNodeId];
            const prevMilestoneHash = headNode?.milestoneHash ?? null;
            const milestoneHash     = await hashMilestone(messages, lastMsgIndex, prevMilestoneHash);

            const node = buildLedgerNode(_sessionStartId, nonSystemCount, {}, milestoneHash);
            _ledgerManifest.nodes[node.nodeId] = node;
            _ledgerManifest.headNodeId         = node.nodeId;
            _sessionStartId                    = node.nodeId;

            await commitLedgerManifest(char.avatar);
            ledgerOk = true;
            console.log(`[STNE] Ledger committed: nodeId=${node.nodeId}`);
        } catch (err) {
            console.error('[STNE] Ledger commit failed:', err);
            toastr.warning(`STNE: Ledger commit failed — ${err.message}`);
        }

        // ── 9. Report outcome ─────────────────────────────────────────────────
        if (lbOk && hooksOk && ragUrl) {
            toastr.success(
                `STNE: Chunk ${nonSystemCount} synced. <a href="#" id="stne-review-link">Review</a>`,
                '',
                { timeOut: 8000, escapeHtml: false },
            );
            $(document).one('click', '#stne-review-link', (e) => {
                e.preventDefault();
                openReviewModal();
            });
        } else {
            // Partial success — individual steps already warned
            console.log(`[STNE] Sync partial: lb=${lbOk} hooks=${hooksOk} rag=${!!ragUrl} ledger=${ledgerOk}`);
        }

    } finally {
        _syncInProgress = false;
    }
}

/**
 * Fires on CHAT_CHANGED for same-character chat switches (and once at startup).
 * Walks the Ledger hash chain against the current chat history to detect branches.
 * If a branch is found, restores the lorebook and hooks block to the last valid
 * milestone, rolls the Ledger head back, and orphans the diverged nodes.
 *
 * Outcomes:
 *   - Same timeline (head hash matches) → silent return.
 *   - No matching node (pre-STNE or unrelated chat) → silent return.
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

    // No node matched — chat predates STNE or is unrelated.
    if (lastValidNodeIdx === -1) return;

    // ── Branch detected ───────────────────────────────────────────────────────
    const targetNode = chain[lastValidNodeIdx];
    const turnNum    = targetNode.sequenceNum;
    console.log(`[STNE] Healer: branch detected — restoring to Turn ${turnNum} (nodeId=${targetNode.nodeId})`);

    try {
        await restoreLorebookToNode(targetNode);
        await restoreHooksToNode(char, targetNode);

        // Orphan all nodes that descended past the branch point
        for (let i = lastValidNodeIdx + 1; i < chain.length; i++) {
            chain[i].status = 'orphaned';
        }

        // Roll back the Ledger head
        _ledgerManifest.headNodeId = targetNode.nodeId;
        _sessionStartId            = targetNode.nodeId;

        await commitLedgerManifest(char.avatar);

        toastr.warning(`STNE: Branch detected — restored to Turn ${turnNum}.`);
        console.log(`[STNE] Healer: restoration complete. Head → ${targetNode.nodeId}`);
    } catch (err) {
        console.error('[STNE] Healer: restoration failed:', err);
        toastr.error('STNE: Branch detected but restoration failed — lorebook may be inconsistent.');
    }
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function bindSettingsHandlers() {
    $('#stne-set-auto-sync').on('change', function () {
        getSettings().autoSync = $(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#stne-set-chunk-every-n').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 20);
        getSettings().chunkEveryN = val;
        saveSettingsDebounced();
    });

    $('#stne-set-hookseeker-horizon').on('input', function () {
        const val = Math.max(1, parseInt($(this).val()) || 70);
        getSettings().hookseekerHorizon = val;
        saveSettingsDebounced();
    });

    $('#stne-set-rag-max-tokens').on('input', function () {
        const val = parseInt($(this).val(), 10);
        if (!isNaN(val) && val >= 1) {
            getSettings().ragMaxTokens = val;
            saveSettingsDebounced();
        }
    });

    $('#stne-set-fact-finder-prompt').on('input', function () {
        getSettings().factFinderPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#stne-reset-fact-finder-prompt').on('click', function () {
        getSettings().factFinderPrompt = DEFAULT_FACT_FINDER_PROMPT;
        $('#stne-set-fact-finder-prompt').val(DEFAULT_FACT_FINDER_PROMPT);
        saveSettingsDebounced();
    });

    $('#stne-set-hookseeker-prompt').on('input', function () {
        getSettings().hookseekerPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#stne-reset-hookseeker-prompt').on('click', function () {
        getSettings().hookseekerPrompt = DEFAULT_HOOKSEEKER_PROMPT;
        $('#stne-set-hookseeker-prompt').val(DEFAULT_HOOKSEEKER_PROMPT);
        saveSettingsDebounced();
    });

    $('#stne-set-rag-classifier-prompt').on('input', function () {
        getSettings().ragClassifierPrompt = $(this).val();
        saveSettingsDebounced();
    });
    $('#stne-reset-rag-classifier-prompt').on('click', function () {
        getSettings().ragClassifierPrompt = DEFAULT_RAG_CLASSIFIER_PROMPT;
        $('#stne-set-rag-classifier-prompt').val(DEFAULT_RAG_CLASSIFIER_PROMPT);
        saveSettingsDebounced();
    });

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#stne-set-profile',
            getSettings().profileId ?? '',
            (profile) => {
                getSettings().profileId = profile?.id ?? null;
                saveSettingsDebounced();
            },
        );
    } catch (e) {
        console.warn('[STNE] Could not initialize profile dropdown:', e);
    }

    try {
        ConnectionManagerRequestService.handleDropdown(
            '#stne-set-rag-profile',
            getSettings().ragProfileId ?? '',
            (profile) => {
                getSettings().ragProfileId = profile?.id ?? null;
                saveSettingsDebounced();
            },
        );
    } catch (e) {
        console.warn('[STNE] Could not initialize RAG profile dropdown:', e);
    }
}

function injectSettingsPanel() {
    if ($('#stne-settings').length) return;
    const s = getSettings();
    const html = `
<div id="stne-settings" class="extension_settings">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
      <b>STNE — Narrative Engine</b>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
    </div>
    <div class="inline-drawer-content">

      <label>Connection Profile</label>
      <select id="stne-set-profile"></select>

      <label>RAG Profile</label>
      <select id="stne-set-rag-profile"></select>

      <label>RAG Max Tokens</label>
      <input id="stne-set-rag-max-tokens" type="number" min="1"
             value="${escapeHtml(String(s.ragMaxTokens ?? 100))}" />

      <label>Sync every N turns</label>
      <input id="stne-set-chunk-every-n" type="number" min="1"
             value="${escapeHtml(String(s.chunkEveryN ?? 20))}" />

      <label>Hookseeker horizon (turns)</label>
      <input id="stne-set-hookseeker-horizon" type="number" min="1"
             value="${escapeHtml(String(s.hookseekerHorizon ?? 70))}" />

      <label class="checkbox_label">
        <input id="stne-set-auto-sync" type="checkbox" ${s.autoSync ? 'checked' : ''} />
        <span>Auto-sync on every Nth turn</span>
      </label>

      <div class="stne-prompt-editor">
        <label>Fact Finder Prompt</label>
        <textarea id="stne-set-fact-finder-prompt" rows="6">${escapeHtml(s.factFinderPrompt ?? DEFAULT_FACT_FINDER_PROMPT)}</textarea>
        <button id="stne-reset-fact-finder-prompt" class="stne-btn stne-btn-sm">Reset to Default</button>
      </div>

      <div class="stne-prompt-editor">
        <label>Hookseeker Prompt</label>
        <textarea id="stne-set-hookseeker-prompt" rows="6">${escapeHtml(s.hookseekerPrompt ?? DEFAULT_HOOKSEEKER_PROMPT)}</textarea>
        <button id="stne-reset-hookseeker-prompt" class="stne-btn stne-btn-sm">Reset to Default</button>
      </div>

      <div class="stne-prompt-editor">
        <label>RAG Classifier Prompt</label>
        <textarea id="stne-set-rag-classifier-prompt" rows="6">${escapeHtml(s.ragClassifierPrompt ?? DEFAULT_RAG_CLASSIFIER_PROMPT)}</textarea>
        <button id="stne-reset-rag-classifier-prompt" class="stne-btn stne-btn-sm">Reset to Default</button>
      </div>

    </div>
  </div>
</div>`;
    $('#extensions_settings').append(html);
    bindSettingsHandlers();
}

// ─── Event Handlers ───────────────────────────────────────────────────────────

function onMessageReceived() {
    const context = SillyTavern.getContext();
    if (!context || context.groupId || context.characterId == null) return;
    if (!getSettings().autoSync) return;

    const messages = context.chat ?? [];
    const count    = messages.filter(m => !m.is_system).length;
    const every    = getSettings().chunkEveryN ?? 20;

    if (every > 0 && count > 0 && count % every === 0) {
        const char = context.characters[context.characterId];
        runStneSync(char, messages).catch(err =>
            console.error('[STNE] runStneSync uncaught error:', err),
        );
    }
}

function onChatChanged() {
    const context = SillyTavern.getContext();
    if (!context || context.characterId == null) {
        _lastKnownAvatar = null;
        return;
    }

    const char         = context.characters[context.characterId];
    const chatFileName = char?.chat ?? null;

    // Character switched — reset cached ledger (it belongs to the old character) and stay silent
    if (!char || char.avatar !== _lastKnownAvatar) {
        _ledgerManifest  = null;
        _lastKnownAvatar = char?.avatar ?? null;
        return;
    }

    // Same character, different chat — Healer territory
    if (chatFileName) {
        runHealer(char, chatFileName).catch(err =>
            console.error('[STNE] runHealer uncaught error:', err),
        );
    }
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
    initSettings();
    injectModal();
    injectSettingsPanel();
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED,     onChatChanged);

    // Deferred startup Healer: catches branches when ST loads directly into a
    // chat without firing CHAT_CHANGED (e.g., on page reload mid-branch).
    setTimeout(() => {
        const ctx  = SillyTavern.getContext();
        const char = ctx?.characters?.[ctx?.characterId];
        if (char) runHealer(char, char.chat).catch(err =>
            console.error('[STNE] Startup Healer uncaught error:', err),
        );
    }, 1000);
}

await init();
