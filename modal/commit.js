/**
 * @file data/default-user/extensions/canonize/modal/commit.js
 * @stamp {"utc":"2026-05-24T00:00:00.000Z"}
 * @version 1.1.0
 * @architectural-role Orchestrator
 * @description
 * Owns Step 4 of the review modal (Finalize / Commit). Handles character world
 * patching and the Confirm button handler that conditionally writes hooks,
 * lorebook, RAG, and updates the DNA anchor in place. DOM rendering and draft
 * counting live in commit-ui.js.
 *
 * @api-declaration
 * patchCharacterWorld, onConfirmClick
 *
 * @contract
 *   assertions:
 *     purity: mutates
 *     state_ownership: []
 *     external_io: [/api/characters/edit, /api/chats/saveChat, vec-store.js]
 */

import { getRequestHeaders } from '../../../../../script.js';
import { getStringHash }     from '../../../../utils.js';
import { state }             from '../state.js';
import { readDnaChain }      from '../core/dna-chain.js';
import { writeCnzSummaryPrompt } from '../core/summary-prompt.js';
import { isDraftDirty, stripProtectedBlock, stitchProtectedBlock } from '../lorebook/utils.js';
import { lbSaveLorebook }    from '../lorebook/api.js';
import { insertLorebookEntries } from '../rag/vec-store.js';
import { cnzAvatarKey }      from '../rag/api.js';
import { warn, error }       from '../log.js';
import { showReceiptsPanel, abortCommitWithError, renderReceipts } from './commit-ui.js';

// ─── Character World Patch ────────────────────────────────────────────────────

export async function patchCharacterWorld(char, lorebookName) {
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

// ─── Commit: IO Executor ──────────────────────────────────────────────────────

/**
 * Runs all four commit steps unconditionally and collects results.
 * No DOM access. Returns a results array for renderReceipts to consume.
 * status values: 'success' | 'failed' | 'skipped' | 'partial' (anchor-only, non-fatal)
 */
async function commitChanges(char, hooksText) {
    const results = [];

    let hooksChanged    = false;
    let lorebookChanged = false;

    // ── Step 1: Hooks save ───────────────────────────────────────────────────
    if (hooksText !== state._priorSituation) {
        try {
            writeCnzSummaryPrompt(char.avatar, hooksText, state._dnaChain.lkg?.uuid ?? null);
            state._priorSituation = hooksText;
            hooksChanged = true;
            results.push({ task: 'hooks', status: 'success', detail: 'Narrative Hooks updated in CNZ Summary prompt' });
        } catch (err) {
            error('Commit', 'Hooks save failed:', err);
            results.push({ task: 'hooks', status: 'failed', error: `Hooks save failed: ${err.message}` });
        }
    } else {
        results.push({ task: 'hooks', status: 'skipped' });
    }

    // ── Step 2: Lorebook save ────────────────────────────────────────────────
    if (isDraftDirty(state._draftLorebook, state._lorebookData) && state._draftLorebook && state._lorebookName) {
        try {
            const preLorebook = structuredClone(state._lorebookData ?? { entries: {} });

            const stitchedLorebook = structuredClone(state._draftLorebook);
            for (const entry of Object.values(stitchedLorebook.entries ?? {})) {
                const origEntry = preLorebook.entries?.[String(entry.uid)];
                entry.content = stitchProtectedBlock(
                    stripProtectedBlock(entry.content),
                    origEntry?.content ?? '',
                );
            }

            stitchedLorebook.extensions = { ...(stitchedLorebook.extensions ?? {}), cnz_anchor_uuid: state._dnaChain?.lkg?.uuid ?? null };
            await lbSaveLorebook(state._lorebookName, stitchedLorebook, { silent: true });
            state._lorebookData = structuredClone(state._draftLorebook);
            lorebookChanged = true;

            const changedEntries = Object.values(state._draftLorebook.entries ?? {})
                .filter(e => { const o = preLorebook.entries[String(e.uid)]; return !o || stripProtectedBlock(o.content) !== stripProtectedBlock(e.content) || JSON.stringify(o.key) !== JSON.stringify(e.key) || (o.comment ?? '') !== (e.comment ?? ''); })
                .map(e => ({ uid: e.uid, content: e.content, keys: e.key ?? [], comment: e.comment ?? '' }));

            const changedNames = changedEntries.map(e => e.comment || String(e.uid));
            results.push({ task: 'lorebook', status: 'success', detail: `Lorebook committed: ${changedNames.length ? changedNames.map(n => `"${n}"`).join(', ') : '(no changes staged)'}` });

            // Write-through vectoring
            const lkgUuid = state._dnaChain?.lkg?.uuid;
            if (changedEntries.length && lkgUuid) {
                try {
                    await insertLorebookEntries(cnzAvatarKey(char.avatar), lkgUuid, state._lorebookName, changedEntries);
                    const hashStr = Object.values(state._draftLorebook.entries ?? {})
                        .sort((a, b) => a.uid - b.uid)
                        .map(e => `${e.uid}|${e.comment ?? ''}|${(e.key ?? []).join(',')}|${stripProtectedBlock(e.content ?? '')}`)
                        .join('\n');
                    state._lastIndexedLorebookHash = String(getStringHash(hashStr));
                } catch (vecErr) {
                    warn('Commit', 'write-through vectoring failed:', vecErr);
                }
            }
        } catch (err) {
            results.push({ task: 'lorebook', status: 'failed', error: `Lorebook save failed: ${err.message}` });
        }
    } else {
        results.push({ task: 'lorebook', status: 'skipped' });
    }

    if (!lorebookChanged && state._lorebookSuggestions.some(s => s.status === 'rejected')) {
        lorebookChanged = true;
    }

    // ── Step 3: RAG status ───────────────────────────────────────────────────
    const settledChunks = state._ragChunks.filter(c => c.status === 'complete' || c.status === 'manual');
    if (settledChunks.length > 0) {
        results.push({ task: 'rag', status: 'success', detail: `Narrative Memory: ${settledChunks.length} chunk${settledChunks.length !== 1 ? 's' : ''} indexed in vector DB` });
    } else {
        results.push({ task: 'rag', status: 'skipped' });
    }

    // ── Step 4: Patch DNA anchor in chat ─────────────────────────────────────
    const hasRagHeaders = settledChunks.length > 0;
    if (hooksChanged || lorebookChanged || hasRagHeaders) {
        try {
            const liveChain = readDnaChain(SillyTavern.getContext().chat ?? []);
            const lkgRef    = liveChain.lkg ? { anchor: liveChain.lkg, msgIdx: liveChain.lkgMsgIdx } : null;
            if (!lkgRef) {
                warn('Commit', 'commitChanges: no lkg anchor to patch — skipping DNA update');
                results.push({ task: 'anchor', status: 'skipped' });
            } else {
                const chatMsgs  = SillyTavern.getContext().chat ?? [];
                const anchorMsg = chatMsgs[lkgRef.msgIdx];
                if (!anchorMsg) {
                    warn('Commit', 'commitChanges: anchor message not found at index', lkgRef.msgIdx);
                    results.push({ task: 'anchor', status: 'skipped' });
                } else {
                    const existing      = lkgRef.anchor;
                    const ragHeadersNew = settledChunks
                        .map(c => ({ chunkIndex: c.chunkIndex, header: c.header, turnRange: c.turnRange, pairStart: state._stagedPairOffset + c.pairStart, pairEnd: state._stagedPairOffset + c.pairEnd }));
                    anchorMsg.extra.cnz = Object.assign({}, existing, {
                        hooks:      hooksChanged    ? state._priorSituation                                                               : existing.hooks,
                        lorebook:   lorebookChanged ? Object.assign({ name: state._lorebookName }, structuredClone(state._draftLorebook)) : existing.lorebook,
                        ragHeaders: hasRagHeaders   ? ragHeadersNew : existing.ragHeaders,
                    });
                    try {
                        await SillyTavern.getContext().saveChat();
                        results.push({ task: 'anchor', status: 'success', detail: 'DNA anchor updated' });
                    } catch (saveErr) {
                        error('Commit', 'commitChanges: saveChat failed:', saveErr);
                        results.push({ task: 'anchor', status: 'partial', error: `DNA anchor save failed: ${saveErr.message} (content saved)` });
                    }
                }
            }
        } catch (err) {
            error('Commit', 'DNA anchor update failed:', err);
            results.push({ task: 'anchor', status: 'partial', error: `DNA anchor update failed: ${err.message} (content saved)` });
        }
    } else {
        results.push({ task: 'anchor', status: 'skipped' });
    }

    return results;
}

// ─── Commit: Orchestrator ─────────────────────────────────────────────────────

export async function onConfirmClick() {
    const hooksText = $('#cnz-situation-text').val().trim();

    const context = SillyTavern.getContext();
    const char    = context.characters[context.characterId];
    if (!char) { toastr.error('CNZ: No character in context.'); return; }

    $('#cnz-confirm, #cnz-cancel, #cnz-move-back').prop('disabled', true);
    $('#cnz-error-4').addClass('cnz-hidden').text('');
    showReceiptsPanel();

    const liveChainNow = readDnaChain(SillyTavern.getContext().chat ?? []);
    if ((liveChainNow.lkg?.uuid ?? null) !== state._modalOpenHeadUuid) {
        abortCommitWithError('A sync committed while this modal was open. Close and re-open to retry.');
        return;
    }

    const results = await commitChanges(char, hooksText);
    renderReceipts(results);

    const firstFailure = results.find(r => r.status === 'failed');
    if (firstFailure) {
        abortCommitWithError(firstFailure.error);
        return;
    }

    state._modalOpenHeadUuid = null;
    import('./orchestrator.js').then(({ closeModal }) => closeModal());
}
