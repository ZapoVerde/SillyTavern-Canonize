# Canonize Refactor Plan
<!-- Crash-safe. Tick boxes as each file is finished. -->
<!-- Status: BATCH 1 = state + pure utils | BATCH 2 = core modules | BATCH 3 = rag | BATCH 4 = modal | BATCH 5 = slim index -->

## Target structure

```
canonize/
├── index.js              (entry point — sync orchestration, init, bus subscribers, settings panel, wand)
├── state.js              (NEW — all _ variables + typedefs)
│
├── core/
│   ├── settings.js       (NEW — PROFILE_DEFAULTS, EXT_NAME, getSettings, getMetaSettings, initSettings)
│   ├── transcript.js     (NEW — buildTranscript, buildProsePairs, buildModalTranscript, buildSyncWindowTranscript)
│   ├── llm-calls.js      (NEW — _waitForRecipe, runLorebookSyncCall, runHookseekerCall, runTargetedLbCall)
│   ├── dna-chain.js      (NEW — findLastAiMessageInPair, readDnaChain, getLkgAnchor, buildAnchorPayload, writeDnaAnchor, writeDnaLinks, buildNodeFileFromAnchor, findLkgAnchorByPosition)
│   ├── summary-prompt.js (NEW — getCnzPromptManager, ensureCnzSummaryPrompt, writeCnzSummaryPrompt, syncCnzSummaryOnCharacterSwitch)
│   └── healer.js         (NEW — restoreLorebookToNode, restoreHooksToNode, restoreRagToNode, runHealer)
│
├── lorebook/
│   ├── api.js            (NEW — lbListLorebooks, lbGetLorebook, lbSaveLorebook, lbEnsureLorebook)
│   └── utils.js          (NEW — formatLorebookEntries, parseLbSuggestions, serialiseSuggestionsToFreeform, matchEntryByComment, nextLorebookUid, makeLbDraftEntry, toVirtualDoc, enrichLbSuggestions, deriveSuggestionsFromAnchorDiff, isDraftDirty, wordDiff)
│
├── rag/
│   ├── api.js            (NEW — utf8ToBase64, uploadRagFile, registerCharacterAttachment, cnzAvatarKey, cnzFileName, cnzDeleteFile)
│   └── pipeline.js       (NEW — buildRagDocument, buildRagChunks, renderChunkChatLabel, renderAllChunkChatLabels, clearChunkChatLabels, renderSeparator, writeChunkHeaderToChat, hydrateChunkHeadersFromChat, resolveClassifierHistory, waitForRagChunks, runRagPipeline, renderRagCard)
│
├── modal/
│   ├── hooks-workshop.js (NEW — setHooksLoading, onHooksTabSwitch, updateHooksDiff, onRegenHooksClick)
│   ├── rag-workshop.js   (NEW — compileRagFromChunks, autoResizeRagRaw, autoResizeRagCardHeader, buildRagCardHTML, renderRagWorkshop, ragRegenCard, onRagTabSwitch, onRagRawInput, onRagRevertRaw, getRagModeLabel, onEnterRagWorkshop, onLeaveRagWorkshop)
│   ├── lb-workshop.js    (NEW — syncFreeformFromSuggestions, setLbLoading, showLbError, onLbRegenClick, onLbTabSwitch, populateTargetedEntrySelect, populateLbIngesterDropdown, renderLbIngesterDetail, updateLbDiff, onLbSuggestionSelectChange, onLbIngesterEditorInput, onLbIngesterLoadLatest, onLbIngesterLoadPrev, onLbIngesterRegenerate, onLbIngesterNext, onLbIngesterApply, revertLbSuggestion, onLbIngesterReject, deleteLbEntry, onLbApplyAllUnresolved, onTargetedGenerateClick)
│   ├── commit.js         (NEW — showReceiptsPanel, showRecoveryGuide, upsertReceiptItem, receiptSuccess, receiptFailure, countDraftChanges, populateRagPanel, populateStep4Summary, abortCommitWithError, onConfirmClick)
│   └── orchestrator.js  (NEW — injectModal, showModal, closeModal, closeDnaChainInspector, closeOrphanModal, openOrphanModal, openDnaChainInspector, initWizardSession, updateWizard, openReviewModal)
│
├── ui.js        UNCHANGED
├── recipes.js   UNCHANGED
├── defaults.js  UNCHANGED
├── cycleStore.js UNCHANGED
├── scheduler.js UNCHANGED
├── bus.js       UNCHANGED
├── executor.js  UNCHANGED
└── logger.js    UNCHANGED
```

---

## Preamble template (copy and adapt for each file)

```js
/**
 * @file data/default-user/extensions/canonize/<path/filename.js>
 * @stamp {"utc":"2026-03-25T00:00:00.000Z"}
 * @version 1.0.16
 * @architectural-role <Pure Functions | Stateful Owner | IO Wrapper | UI Builder | Feature Entry Point>
 * @description
 * <1–3 sentences>
 *
 * @api-declaration
 * <exported names, one per line>
 *
 * @contract
 *   assertions:
 *     purity: <pure | mutates>
 *     state_ownership: [<list or "none">]
 *     external_io: [<list or "none">]
 */
```

---

## State module pattern

All `let _foo` variables in index.js move to `state.js` as properties of a single exported object.
Every module that needs them imports `{ state }` from the correct relative path and accesses `state._foo`.

```js
// state.js
export const state = {
    _lorebookData:         null,
    _draftLorebook:        null,
    _lastKnownAvatar:      null,
    _lorebookName:         '',
    _lorebookSuggestions:  [],
    _ragChunks:            [],
    _stagedProsePairs:     [],
    _stagedPairOffset:     0,
    _splitPairIdx:         0,
    _lastRagUrl:           '',
    _priorSituation:       '',
    _beforeSituation:      '',
    _parentNodeLorebook:   null,
    _pendingOrphans:       [],
    _dnaChain:             null,
    _currentStep:          1,
    _lorebookLoading:      false,
    _hooksLoading:         false,
    _lbActiveIngesterIndex: 0,
    _lbDebounceTimer:      null,
    _ragRawDetached:       false,
    _modalOpenHeadUuid:    null,
};
```

---

## Exact line map — index.js → destination

### state.js
| Lines | Content |
|-------|---------|
| 175–224 | All `let _foo` variable declarations |
| 226–266 | @typedef blocks (CnzAnchor, CnzLink, RagHeaderEntry, AnchorRef, DnaChain) |

### core/settings.js
| Lines | Content |
|-------|---------|
| 138–173 | EXT_NAME, DEFAULT_CONCURRENCY, CNZ_SUMMARY_ID, PROFILE_DEFAULTS |
| 271–273 | getSettings() |
| 276–278 | getMetaSettings() |
| 280–338 | initSettings() |

### core/transcript.js
| Lines | Content |
|-------|---------|
| 635–640 | buildTranscript() |
| 649–671 | buildProsePairs() |
| 1985–1992 | buildModalTranscript() |
| 2006–2022 | buildSyncWindowTranscript() |

### core/llm-calls.js
| Lines | Content |
|-------|---------|
| 1122–1149 | _waitForRecipe() |
| 1157–1162 | runLorebookSyncCall() |
| 1170–1175 | runHookseekerCall() |
| 1186–1194 | runTargetedLbCall() |

### core/dna-chain.js
| Lines | Content |
|-------|---------|
| 457–463 | findLastAiMessageInPair() |
| 470–493 | readDnaChain() |
| 500–503 | getLkgAnchor() |
| 518–529 | buildAnchorPayload() |
| 541–554 | writeDnaAnchor() |
| 567–587 | writeDnaLinks() |
| 597–611 | buildNodeFileFromAnchor() |
| 623–631 | findLkgAnchorByPosition() |

### core/summary-prompt.js
| Lines | Content |
|-------|---------|
| 366–368 | getCnzPromptManager() |
| 376–397 | ensureCnzSummaryPrompt() |
| 407–417 | writeCnzSummaryPrompt() |
| 427–448 | syncCnzSummaryOnCharacterSwitch() |

### core/healer.js
| Lines | Content |
|-------|---------|
| 1724–1733 | restoreLorebookToNode() |
| 1742–1746 | restoreHooksToNode() |
| 1756–1780 | restoreRagToNode() |
| 3957–4024 | runHealer() |

### lorebook/api.js
| Lines | Content |
|-------|---------|
| 1217–1225 | lbListLorebooks() |
| 1227–1235 | lbGetLorebook() |
| 1237–1245 | lbSaveLorebook() |
| 1250–1263 | lbEnsureLorebook() |

### lorebook/utils.js
| Lines | Content |
|-------|---------|
| 1286–1295 | formatLorebookEntries() |
| 1301–1331 | parseLbSuggestions() |
| 1341–1353 | serialiseSuggestionsToFreeform() |
| 1367–1373 | matchEntryByComment() |
| 1378–1381 | nextLorebookUid() |
| 1386–1430 | makeLbDraftEntry() |
| 1436–1440 | toVirtualDoc() |
| 1448–1521 | enrichLbSuggestions() |
| 1540–1586 | deriveSuggestionsFromAnchorDiff() |
| 2286–2310 | wordDiff() |
| 2740–2752 | isDraftDirty() |

### rag/api.js
| Lines | Content |
|-------|---------|
| 1054–1058 | utf8ToBase64() |
| 1066–1081 | uploadRagFile() |
| 1091–1105 | registerCharacterAttachment() |
| 1641–1643 | cnzAvatarKey() |
| 1654–1667 | cnzFileName() |
| 1675–1698 | cnzDeleteFile() |

### rag/pipeline.js
| Lines | Content |
|-------|---------|
| 706–726 | buildRagDocument() |
| 738–810 | buildRagChunks() |
| 819–850 | renderChunkChatLabel() |
| 856–860 | renderAllChunkChatLabels() |
| 866–868 | clearChunkChatLabels() |
| 877–888 | renderSeparator() |
| 896–911 | writeChunkHeaderToChat() |
| 920–931 | hydrateChunkHeadersFromChat() |
| 939–955 | renderRagCard() |
| 981–1000 | resolveClassifierHistory() |
| 1008–1027 | waitForRagChunks() |
| 3634–3677 | runRagPipeline() |

### modal/hooks-workshop.js
| Lines | Content |
|-------|---------|
| 1972–1977 | setHooksLoading() |
| 2028–2035 | onHooksTabSwitch() |
| 2038–2041 | updateHooksDiff() |
| 2047–2068 | onRegenHooksClick() |

### modal/rag-workshop.js
| Lines | Content |
|-------|---------|
| 1803–1807 | compileRagFromChunks() |
| 1809–1814 | autoResizeRagRaw() |
| 1816–1820 | autoResizeRagCardHeader() |
| 1822–1841 | buildRagCardHTML() |
| 1843–1849 | renderRagWorkshop() |
| 1851–1870 | ragRegenCard() |
| 1872–1882 | onRagTabSwitch() |
| 1884–1894 | onRagRawInput() |
| 1896–1902 | onRagRevertRaw() |
| 1905–1907 | getRagModeLabel() |
| 1914–1946 | onEnterRagWorkshop() |
| 1948–1950 | onLeaveRagWorkshop() |

### modal/lb-workshop.js
| Lines | Content |
|-------|---------|
| 1359–1361 | syncFreeformFromSuggestions() |
| 2095–2100 | setLbLoading() |
| 2103–2106 | showLbError() |
| 2113–2186 | onLbRegenClick() |
| 2192–2205 | onLbTabSwitch() |
| 2211–2226 | populateTargetedEntrySelect() |
| 2228–2249 | populateLbIngesterDropdown() |
| 2257–2278 | renderLbIngesterDetail() |
| 2312–2338 | updateLbDiff() |
| 2340–2346 | onLbSuggestionSelectChange() |
| 2348–2369 | onLbIngesterEditorInput() |
| 2372–2380 | onLbIngesterLoadLatest() |
| 2383–2422 | onLbIngesterLoadPrev() |
| 2428–2476 | onLbIngesterRegenerate() |
| 2478–2491 | onLbIngesterNext() |
| 2493–2516 | onLbIngesterApply() |
| 2526–2574 | revertLbSuggestion() |
| 2576–2579 | onLbIngesterReject() |
| 2588–2618 | deleteLbEntry() |
| 2620–2653 | onLbApplyAllUnresolved() |
| 3039–3100 | onTargetedGenerateClick() |

### modal/commit.js
| Lines | Content |
|-------|---------|
| 2657–2678 | showReceiptsPanel, showRecoveryGuide, upsertReceiptItem, receiptSuccess, receiptFailure |
| 2682–2690 | countDraftChanges() |
| 2692–2712 | populateRagPanel() |
| 2714–2726 | populateStep4Summary() |
| 2728–2732 | abortCommitWithError() |
| 2761–2896 | onConfirmClick() |

### modal/orchestrator.js
| Lines | Content |
|-------|---------|
| 2919–3025 | injectModal() |
| 3027–3029 | showModal() |
| 3102–3114 | closeModal() |
| 3118–3120 | closeDnaChainInspector() |
| 3122–3126 | closeOrphanModal() |
| 3134–3216 | openOrphanModal() |
| 3223–3383 | openDnaChainInspector() |
| 3392–3442 | initWizardSession() |
| 3448–3459 | updateWizard() |
| 3466–3564 | openReviewModal() |

### Stays in index.js (after refactor)
| Lines | Content |
|-------|---------|
| 1–105 | Preamble + imports (will be updated) |
| 106–134 | MDP debug panel |
| 342–348 | escapeHtml() — exported, wide use |
| 1596–1629 | patchCharacterWorld() |
| 3567–3578 | logSyncStart() |
| 3589–3610 | processLorebookUpdate() |
| 3617–3622 | processHooksUpdate() |
| 3686–3718 | commitDnaAnchor() |
| 3739–3759 | computeSyncWindow() |
| 3772–3788 | deriveLastCommittedPairs() |
| 3807–3940 | runCnzSync() |
| 4026–4078 | openPromptModal() |
| 4100–4613 | Settings panel (injectSettingsPanel, bindSettingsHandlers, refreshSettingsUI, refreshProfileDropdown, updateDirtyIndicator, isStateDirty, updateRagAiControlsVisibility, purgeAndRebuild) |
| 4634–4685 | checkOrphans() |
| 4697–4703 | resetStagedState() |
| 4705–4719 | resetSessionState() |
| 4721–4756 | onChatChanged() |
| 4758–4880 | showSyncChoicePopup, onWandButtonClick, injectWandButton |
| 4882–5024 | init() + await init() |

---

## Cross-dependency notes

- `escapeHtml` — export from index.js; import in modal files that need it
- `wordDiff` — export from lorebook/utils.js; import in hooks-workshop.js and lb-workshop.js
- `buildModalTranscript`, `buildSyncWindowTranscript` — in core/transcript.js; import in hooks-workshop.js AND lb-workshop.js
- `_waitForRecipe` etc — in core/llm-calls.js; import in hooks-workshop.js, lb-workshop.js, rag/pipeline.js
- `renderRagCard`, `renderAllChunkChatLabels` — in rag/pipeline.js; import in index.js bus subscribers and modal/rag-workshop.js
- `buildProsePairs`, `buildTranscript` — in core/transcript.js; import in rag/pipeline.js, core/healer.js, index.js
- modal files import `state` from `../../state.js` (two levels up from modal/)
- core/ files import `state` from `../state.js`
- lorebook/ and rag/ files import `state` from `../state.js`

---

## Batches & progress

### BATCH 1 — Foundation (state + pure/IO modules, no DOM)
- [x] `state.js`
- [x] `core/settings.js`
- [x] `core/transcript.js`
- [x] `core/llm-calls.js` — created 2026-03-27; uses `state._lorebookData` fallback
- [x] `core/dna-chain.js`
- [x] `core/summary-prompt.js`
- [x] `lorebook/api.js`
- [x] `lorebook/utils.js`
- [x] `rag/api.js`

### BATCH 2 — Core logic (healer + rag pipeline)
- [x] `core/healer.js`
- [x] `rag/pipeline.js`

### BATCH 3 — Modal workshops
- [x] `modal/hooks-workshop.js`
- [x] `modal/rag-workshop.js`
- [x] `modal/lb-workshop.js`
- [x] `modal/commit.js`
- [x] `modal/orchestrator.js`

### BATCH 4 — Slim index.js (subtasks)
- [ ] 4a: Update imports block (remove promptManager/updateWorldInfoList; add state.js, core/*, lorebook/*, rag/*, modal/orchestrator)
- [ ] 4b: Delete state/constants block — lines 136–348 (EXT_NAME, PROFILE_DEFAULTS, let _foo vars, typedefs, getSettings, escapeHtml)
- [ ] 4c: Delete extracted core fns — lines 349–1563 (buildTranscript, buildProsePairs, utf8ToBase64, LLM calls, DNA chain, summary-prompt, lorebook API/utils)
- [ ] 4d: Delete extracted rag+modal fns — lines 1564–3565 (rag/api, rag/pipeline, healer, patchCharacterWorld, all modal fns, openReviewModal)
- [ ] 4e: Delete runHealer body — lines 3957–4024 (now in core/healer.js; replace with import call)
- [ ] 4f: Delete runRagPipeline body — lines 3634–3677 (now in rag/pipeline.js; replace call in runCnzSync)
- [ ] 4g: Delete purgeAndRebuild body — lines 4193–4330 (now in core/healer.js; remove, already imported)
- [ ] 4h: Replace all bare `_foo` → `state._foo` in remaining functions (runCnzSync, processLorebookUpdate, commitDnaAnchor, resetStagedState, resetSessionState, onChatChanged, onWandButtonClick, bus subscribers, refreshSettingsUI, bindSettingsHandlers)
- [ ] 4i: Update modal dynamic imports in hooks-workshop.js + lb-workshop.js from `../index.js` → `../core/llm-calls.js`
- [ ] 4j: Update preamble

### Notes
- `modal/hooks-workshop.js`, `modal/lb-workshop.js` still call `runHookseekerCall` / `runLorebookSyncCall` / `runTargetedLbCall` via `import('../index.js')` — in Batch 4 update these to `import('../core/llm-calls.js')`
- `purgeAndRebuild` moved from index.js settings panel section into `core/healer.js`
- `buildModalTranscript` and `buildSyncWindowTranscript` live in `modal/hooks-workshop.js` (not `core/transcript.js`)

### Done
Batches 1–3 verified 2026-03-27.
