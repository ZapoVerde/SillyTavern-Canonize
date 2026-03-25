/**
 * @file data/default-user/extensions/canonize/recipes.js
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.0
 * @architectural-role Pure Functions / Constants
 * @description
 * Static recipe declarations for all CNZ AI calls. A Recipe is an immutable
 * object that declares everything needed to execute one LLM call: which inputs
 * it requires, how to build the prompt, which connection profile to use, what
 * output key it produces, and its staleness key.
 *
 * Recipes are never modified at runtime. `buildPrompt` is the only function
 * type permitted here — it must be pure (no module state reads, no side
 * effects). All values it needs are passed in as `inputs` or `settings`.
 *
 * @docs
 *   Principles: docs/cnz_principles.md — "Recipes and Contracts"
 *
 * @api-declaration
 * Recipes.hookseeker       — narrative summary from transcript.
 * Recipes.lorebook         — lorebook update suggestions from transcript.
 * Recipes.rag_classifier   — RAG chunk header from transcript + hooks.
 * Recipes.targeted_update  — targeted update for a single lorebook entry.
 * Recipes.targeted_new     — targeted new entry for a single lorebook concept.
 *
 * Triggers.auto_sync       — fires on MESSAGE_RECEIVED; condition checks gap / snooze.
 * Triggers.mask_advance    — fires on CHAT_COMPLETION_PROMPT_READY; computes mask payload.
 *
 * @contract
 *   assertions:
 *     purity: pure (conditions are pure functions; watchEvent refs require event_types import)
 *     state_ownership: []
 *     external_io: [event_types]
 */
// ─── CNZ Recipes ──────────────────────────────────────────────────────────────
// Static declarations. Never modified at runtime.
// buildPrompt is the only function allowed here — pure, no side effects.

import { interpolate,
         DEFAULT_HOOKSEEKER_PROMPT,
         DEFAULT_LOREBOOK_SYNC_PROMPT,
         DEFAULT_RAG_CLASSIFIER_PROMPT,
         DEFAULT_TARGETED_UPDATE_PROMPT,
         DEFAULT_TARGETED_NEW_PROMPT } from './defaults.js';
import { event_types } from '../../../../script.js';

export const Recipes = {

    hookseeker: {
        id:           'hookseeker',
        inputs:       ['transcript'],
        buildPrompt:  (inputs, settings) => {
            let prompt = interpolate(
                settings.hookseekerPrompt || DEFAULT_HOOKSEEKER_PROMPT,
                { transcript: inputs.transcript, prev_summary: inputs.prev_summary ?? '' }
            );
            const trailing = (settings.hookseekerTrailingPrompt ?? '').trim();
            if (trailing) prompt = prompt + '\n\n' + trailing;
            return prompt;
        },
        profileKey:   'profileId',
        maxTokens:    null,
        produces:     'scenario_hooks',
        stalenessKey: 'hookseeker',
    },

    lorebook: {
        id:           'lorebook',
        inputs:       ['transcript', 'lorebook_entries'],
        buildPrompt:  (inputs, settings) => interpolate(
                          settings.lorebookSyncPrompt || DEFAULT_LOREBOOK_SYNC_PROMPT,
                          {
                              lorebook_entries: inputs.lorebook_entries,
                              transcript:       inputs.transcript,
                          }
                      ),
        profileKey:   'profileId',
        maxTokens:    null,
        produces:     'lorebook_raw',
        stalenessKey: 'lorebook',
    },

    rag_classifier: {
        id:      'rag_classifier',
        // Fan-out inputs (passed as extraInputs by runRagPipeline/ragRegenCard):
        //   ragChunks, fullPairs, stagedPairs, stagedPairOffset, splitPairIdx, scenario_hooks
        // Per-chunk inputs (produced by fanOut and passed to buildPrompt):
        //   transcript, scenario_hooks, history, chunkIndex
        inputs:  ['scenario_hooks', 'ragChunks', 'fullPairs', 'stagedPairs', 'stagedPairOffset', 'splitPairIdx'],
        buildPrompt: (inputs, settings) => interpolate(
                         settings.ragClassifierPrompt || DEFAULT_RAG_CLASSIFIER_PROMPT,
                         {
                             summary:      inputs.scenario_hooks,
                             history:      inputs.history ?? '',
                             target_turns: inputs.transcript,
                         }
                     ),
        /**
         * Pure fan-out function. Receives the assembled inputs and settings; returns
         * one input-set object per chunk that needs classification. Each object is
         * passed directly to buildPrompt for that chunk's contract.
         *
         * Implements the same logic as buildRagChunks (transcript assembly) and
         * resolveClassifierHistory (history assembly), kept in index.js as pure
         * utility references. Inlined here to avoid a circular import.
         */
        fanOut: (inputs, settings) => {
            const { ragChunks, scenario_hooks, fullPairs, stagedPairs, stagedPairOffset, splitPairIdx } = inputs;
            if (!ragChunks?.length) return [];
            const historyN  = settings.ragClassifierHistory ?? 0;
            const inputSets = [];

            for (const chunk of ragChunks) {
                if (chunk.status === 'complete') continue;  // skip qvink-prebuilt chunks

                const pairStart   = chunk.pairStart ?? chunk.chunkIndex;
                const pairEnd     = chunk.pairEnd   ?? (pairStart + 1);
                const targetPairs = (stagedPairs ?? []).slice(pairStart, Math.min(pairEnd, splitPairIdx ?? Infinity));
                if (targetPairs.length === 0) continue;

                // Build transcript (mirrors buildRagChunks content assembly)
                const transcript = targetPairs
                    .map(p => {
                        const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                        for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                        return parts.join('\n\n');
                    })
                    .join('\n\n');

                // Build history (mirrors resolveClassifierHistory)
                let history = '';
                if (historyN > 0 && fullPairs?.length) {
                    const absStart = (stagedPairOffset ?? 0) + pairStart;
                    const fromIdx  = Math.max(0, absStart - historyN);
                    history = fullPairs.slice(fromIdx, absStart)
                        .map(p => {
                            const parts = [`[${p.user.name.toUpperCase()}]\n${p.user.mes}`];
                            for (const m of p.messages) parts.push(`[${m.name.toUpperCase()}]\n${m.mes}`);
                            return parts.join('\n\n');
                        })
                        .join('\n\n');
                }

                inputSets.push({ chunkIndex: chunk.chunkIndex, transcript, scenario_hooks, history });
            }
            return inputSets;
        },
        profileKey:    'ragProfileId',
        maxTokens:     'ragMaxTokens',      // settings key, resolved at dispatch time
        maxConcurrent: 'maxConcurrentCalls', // settings key for fan-out concurrency cap
        produces:      'rag_chunk_results',
        stalenessKey:  'rag_classifier_fanout',
    },

    targeted_update: {
        id:           'targeted_update',
        inputs:       ['entry_name', 'entry_keys', 'entry_content', 'transcript'],
        buildPrompt:  (inputs, settings) => interpolate(
                          settings.targetedUpdatePrompt || DEFAULT_TARGETED_UPDATE_PROMPT,
                          inputs
                      ),
        profileKey:   'profileId',
        maxTokens:    null,
        produces:     'targeted_result',
        stalenessKey: 'targeted',
    },

    targeted_new: {
        id:           'targeted_new',
        inputs:       ['entry_name', 'transcript'],
        buildPrompt:  (inputs, settings) => interpolate(
                          settings.targetedNewPrompt || DEFAULT_TARGETED_NEW_PROMPT,
                          inputs
                      ),
        profileKey:   'profileId',
        maxTokens:    null,
        produces:     'targeted_result',
        stalenessKey: 'targeted',
    },

};

// ─── CNZ Triggers ─────────────────────────────────────────────────────────────
// Static declarations for scheduler-driven event listeners.
// Each trigger: { id, source, watchEvent, condition, emits }
//   source    — 'st' for ST eventSource events, 'bus' for CNZ bus events.
//   condition — pure function: (state, settings) => payload | null.
//               Returns non-null to fire the declared bus event.
//   state     — { dnaChain, syncInProgress, snoozeUntilCount, context, messages, count, eventData }

export const Triggers = {

    /**
     * Fires SYNC_TRIGGERED after each AI message if auto-sync is enabled and
     * the uncommitted gap meets the threshold. The `largeGap` flag is set when
     * the gap exceeds two windows — the handler shows the top-up offer in that case.
     * gap_offer is merged into this payload; there is no separate trigger for it.
     */
    auto_sync: {
        id:         'auto_sync',
        source:     'st',
        watchEvent: event_types.MESSAGE_RECEIVED,
        condition:  (state, settings) => {
            const { context, messages, count, dnaChain, snoozeUntilCount } = state;
            if (!context || context.groupId || context.characterId == null) return null;
            if (!settings.autoSync) return null;
            const every = settings.chunkEveryN ?? 20;
            if (every <= 0 || count <= 0) return null;
            if (count <= snoozeUntilCount) return null;

            const lkgIdx = dnaChain?.lkgMsgIdx ?? -1;
            const priorSeq = lkgIdx >= 0
                ? messages.slice(0, lkgIdx + 1).filter(m => !m.is_system).length
                : 0;
            const lcb = settings.liveContextBuffer ?? 5;
            const trailingBoundary = Math.max(0, count - lcb);
            const gap = trailingBoundary - priorSeq;
            if (gap < every) return null;

            const char = context.characters[context.characterId];
            return { char, messages, gap, every, trailingBoundary, largeGap: gap >= every * 2 };
        },
        emits: 'SYNC_TRIGGERED',
    },

    /**
     * Fires MASK_ADVANCE_TRIGGERED on each prompt-ready event so the context
     * mask can be applied outside of `init()`. The payload carries the original
     * ST event data object (mutated in-place by the handler) and the computed
     * mask boundary. Returns null when no anchor exists yet.
     */
    mask_advance: {
        id:         'mask_advance',
        source:     'st',
        watchEvent: event_types.CHAT_COMPLETION_PROMPT_READY,
        condition:  (state) => {
            const { dnaChain, messages, eventData } = state;
            const lkgIdxMask = dnaChain?.lkgMsgIdx ?? -1;
            if (lkgIdxMask < 0) return null;
            const maskBoundary = messages.slice(0, lkgIdxMask + 1).filter(m => !m.is_system).length;
            if (maskBoundary <= 0) return null;
            return { data: eventData, maskBoundary };
        },
        emits: 'MASK_ADVANCE_TRIGGERED',
    },

};
