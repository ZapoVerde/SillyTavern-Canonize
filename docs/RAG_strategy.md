# Implementation Specification: Adaptive Thresholding for RAG Result Filtering (Conceptual)

## Overview

This specification describes how to implement **two-signal adaptive thresholding** to replace the current static `noiseFloor` mechanism in the Canonize RAG retrieval pipeline. The goal is to intelligently identify the natural quality boundary in retrieved results using genuinely independent signals, automatically adapting to database growth and query characteristics.

## Problem Statement

The current system filters RAG results using a hard-coded threshold (default 0.1). This approach fails as conversations grow because:

- **Score compression**: As the database expands, embedding scores cluster toward the middle of the distribution, making static thresholds ineffective
- **Query-dependent noise**: Vague queries produce mediocre results across the board; specific queries produce clear winners and losers. A single threshold can't adapt to both cases
- **Diminishing returns**: Token budgets are finite. Past a certain point, adding more memories dilutes attention rather than improving context

The solution must detect where genuine relevant memories end and noise begins, adapt to changing database characteristics, and respect operational constraints (maximum result count, minimum quality floor).

## Design Goals

1. **Adapt automatically**: No manual tuning as the conversation grows
2. **Use independent signals**: Require consensus between uncorrelated detections
3. **Respect constraints**: Absolute minimum quality and maximum result count
4. **Be auditable**: Log exactly why results were included or excluded
5. **Degrade gracefully**: When signals conflict, apply safety defaults
6. **Minimize surface area**: Only expose settings that users actually need to tune

---

## Core Algorithm: Two-Signal Majority Inflection Detection

### Architecture Overview

The filtering process executes in four stages:

1. **Retrieve excess candidates** from the database (over-fetch)
2. **Calculate two independent signals** for each result
3. **Detect inflection point** using simple majority (either signal says YES)
4. **Apply safety bounds** (floor, ceiling, recency decay)

### Why Two Signals Instead of Three

The original concept proposed three signals: gap-based detection, slope-based detection, and path diversity. However, gap-based and slope-based signals are mathematically correlated—they both operate on the same underlying array of consecutive score differences. While their detection thresholds differ, they'll typically agree on boundaries, violating the independence assumption necessary for meaningful consensus.

**Solution**: Use gap-based detection and path diversity instead. These are **genuinely orthogonal**:

- Gap-based signal operates on score distributions (mathematical property)
- Path diversity signal operates on metadata (which retrieval methods voted for each result)

A result can have a high score but come from only one retrieval path. Conversely, a result can have a modest score but come from three agreeing paths. These signals are independent and can meaningfully disagree.

---

## Signal Definitions

### Signal A: Gap-Based Detection (Score Discontinuities)

**Concept**: Identify where scores drop significantly compared to the average drop rate, indicating a transition from relevant to noise.

**Mathematical foundation**:

Results are ranked by score in descending order. Between each consecutive pair of results, there's a gap (the difference in their scores). These gaps form a distribution of their own—some gaps are large, some small.

The key insight: **Where quality changes most rapidly, there's typically a boundary.** Most gaps within the "quality zone" are consistent and relatively small. When you encounter a gap substantially larger than the norm, you've hit the inflection point.

**Detection process**:

1. Calculate all consecutive score gaps. For a list of results, this creates an array of N-1 gaps (if you have 20 results, you get 19 gaps).

2. Find the average gap size. This represents the typical score decrement between adjacent results.

3. Set a threshold: any gap that exceeds **2 times the average** is considered significant. This ratio is hardcoded (not user-tunable) because it's based on statistical reasoning—outliers in a distribution are typically 2-3× the mean.

4. Walk through the gaps in order and identify the **first gap that exceeds this threshold**. This is where the signal triggers.

5. Edge cases to handle:
   - If you have fewer than 3 results, you can't establish a meaningful pattern, so this signal doesn't trigger
   - If all gaps are tiny (average < 0.015), the distribution has no meaningful variation, so this signal doesn't trigger
   - If multiple gaps exceed the threshold, use only the first one (most conservative approach)

**What this detects**:
- **Clear quality cliff**: Scores drop from 0.8 → 0.75 → 0.45 consistently. The gap between 0.75 and 0.45 is huge compared to the earlier gaps, triggering the signal at that point.
- **Mediocre compression**: All scores hover between 0.35 and 0.50 with gaps around 0.02. No gap reaches twice the average, so the signal never triggers (good—don't force a boundary where none exists).
- **Gradual degradation**: Scores decay consistently (0.80 → 0.75 → 0.70 → 0.65). All gaps are uniform; no outlier emerges, so the signal doesn't trigger (correct behavior).

---

### Signal C: Path Diversity Detection (Multi-Signal Agreement)

**Concept**: Results appearing in multiple retrieval paths (content embedding, header embedding, keyword search) are more likely genuinely relevant; results from single paths are more suspect.

**Foundational reasoning**:

The RAG system uses three independent retrieval methods:
- Content-based vector search (finding semantically similar stored memories)
- Header-based vector search (finding memories with semantically similar summaries)
- Keyword search (finding memories with matching terms)

When a result appears in the top-ranked results across multiple methods, it's a form of consensus—different approaches all think this memory is relevant. When a result only appears in one method's top results, it's lower-confidence; it solved one relevance criterion but not others.

**Detection process**:

1. For each result, count how many distinct retrieval paths voted for it (can be 1, 2, or 3).

2. Define a diversity threshold: results with 2 or more paths are "high confidence"; results with only 1 path are "low confidence." This threshold is hardcoded.

3. Walk through results from best to worst and find the **first result that has fewer than 2 paths**. This is where the signal triggers.

4. Edge cases to handle:
   - If you have fewer than 2 results, you can't establish a meaningful pattern
   - If all results have only 1 path, you can't distinguish between them (no signal)
   - If all results have 2+ paths throughout, there's no diversity boundary (no signal)

**What this detects**:
- **Broad consensus**: Top results are matched by all three retrieval methods. As you go deeper, results still match 2+ methods. Then suddenly, position 5 only matches the keyword search. The signal triggers at position 5 (diversity dropped from 2+ to 1).
- **Single-method results**: If mediocre results all come from keyword search alone (because content and header methods found nothing), the signal will trigger early and be conservative.
- **Balanced matching**: If results consistently come from 2 different combinations (sometimes content+header, sometimes content+keyword), the signal doesn't trigger until you hit single-path results, or not at all if they never drop below 2.

---

## Consensus Logic and Inflection Identification

**Decision principle**: Walk through results in rank order. At each position, check both signals independently. **Stop at the first position where either signal (or both) declares a boundary.**

This is "simple majority" in a two-signal system—each signal gets one vote, and the first signal to vote triggers the boundary.

**Why this works**:

Because the signals are orthogonal, they can meaningfully disagree. Sometimes the gap signal will trigger first (clear score cliff). Other times the diversity signal will trigger first (high scores but all single-path). Either way, at least one independent criterion has flagged that something changed. That's sufficient evidence to stop.

**Failure modes this handles**:

- **Both signals agree early**: You get a conservative boundary (good—avoid borderline noise)
- **Gap signal triggers, diversity doesn't**: You found a score cliff but results still have path agreement; stop at the score cliff anyway (good—score is the primary signal)
- **Diversity signal triggers, gap signal doesn't**: You found where path agreement dropped but scores are gradually decreasing; stop at the diversity boundary (good—it's a confidence marker independent of scores)
- **Neither signal triggers**: Keep results up to the absolute ceiling (conservative, rely on hard constraints)

---

## Safety Bounds: Hard Constraints After Inflection Detection

After the inflection point is identified via the two-signal system, enforce absolute constraints that are independent of distribution analysis:

### Absolute Floor: Minimum Quality Score

**Concept**: Even if both signals say to keep 10 results, discard any result with an absolute score below this floor.

**Mathematical reasoning**: After RRF merging and temporal decay, the score distribution should concentrate around certain values. Empirically, scores below 0.15 on the [0, 1] scale tend to correlate with noisy, low-confidence results. This floor is not derived from the current query's distribution but from system-wide statistics.

**Default value**: 0.15  
**Rationale**: Allows user tuning (more permissive or stricter) but has a sensible default

**Use case**: If the inflection detection identifies boundary at position 12, but positions 8-11 all score below 0.15, apply the floor: discard 8-11 and keep only results above the floor up to position 12.

### Absolute Ceiling: Maximum Result Count

**Concept**: Never return more than N results, even if inflection detection says to keep more.

**Reasoning**: Token budgets are finite. Research on attention and context windows shows that beyond approximately 7 key memories, each additional memory provides diminishing returns and can actually degrade model performance by diluting focus. This is an operational constraint, not a statistical one.

**Default value**: 7  
**Rationale**: Allows user tuning (more coverage vs. more focus) but has a principled default

**Use case**: If the inflection point is at position 12, keep only the top 7 results before that boundary.

### Recency Decay (Already Implemented)

The system already downweights older memories exponentially. This combines with the new thresholding naturally—older results have their scores reduced, which makes them less likely to cross the inflection boundary in the first place.

---

## Complete Filtering Pipeline

The final processing order is:

1. **Retrieve candidates**: Request 4× the normal topK limit (or configurable multiple). This gives enough results to analyze for patterns without being wasteful.

2. **Apply existing processing**: RRF merge and temporal decay (unchanged from current system).

3. **Calculate two signals**: The gap signal is computed once across the full ranked list (a distribution-level analysis producing a single boundary position). The diversity signal is computed per-result (scanning each result in rank order until the first single-path entry is found).

4. **Find inflection point**: Walk through results and stop at the first position where either signal triggers. This position becomes the inflection boundary.

5. **Apply absolute floor**: Filter results; discard anything below the minimum score threshold.

6. **Apply absolute ceiling**: Slice the results to keep at most N items.

7. **Apply minimum result guarantee**: Always return at least 3 results, even if signals and floor filtering reduced the count below that. If the floor discarded results needed to reach 3, re-admit the highest-scoring floor-failures until the minimum is met. If the database returned fewer than 3 candidates in total, return everything retrieved. The rationale: the LLM requires a minimum amount of retrieved context to operate effectively; returning fewer than 3 memories leaves it without adequate anchoring, which is worse than injecting borderline results.

8. **Return filtered results**: Inject the final set into the prompt.

---

## Configuration Surface

Only expose settings that users actually need to tune:

- **Master toggle**: Enable or disable the adaptive system. When disabled, fall back to the legacy fixed threshold.

- **Minimum score floor**: The absolute lowest score to accept. This is the only distribution-based parameter users should adjust. Lowering it makes the system more permissive; raising it makes it stricter.

- **Maximum result count**: The hard ceiling on how many memories to inject. Users with smaller context windows might lower this; users with large budgets might raise it.

- **Overfetch multiplier** (advanced): For power users who want to tune how many candidates are retrieved for analysis. Higher values analyze more thoroughly but slower.

- **Verbose logging** (debug): Enable detailed signal calculations in logs.

All other thresholds (gap threshold multiplier of 2.0, diversity threshold of 2 paths, etc.) are internally hardcoded constants. If future testing shows these need tuning, they can be promoted to user settings later.

---

## Logging and Observability

Every RAG fetch produces a summary log like:

```
Retrieved 20 candidates (topK=5, overfetch multiplier=4)
Scores: [0.89, 0.84, 0.77, 0.68, 0.58, 0.45, 0.42, 0.40, 0.39, 0.38, ...]
Path diversity: [3, 3, 2, 2, 1, 1, 1, 1, 1, 1, ...]
Gap analysis: mean gap = 0.074, threshold = 0.148
Gap signal: NO (no gap exceeds threshold)
Diversity signal: YES at position 4 (first single-path result)
Consensus boundary: position 4 (diversity signal triggered)
After inflection: 4 results
After floor (min 0.15): 4 results
After ceiling (max 7): 4 results
Final injection: 4 memories
```

In verbose mode, also log per-position evaluation showing why each result was kept or rejected.

---

## Testing and Validation

### Scenario 1: Small, High-Quality Database
- Conversation of 50 turns with ~10 memories
- Expected: Both signals detect inflection early and agree
- Success indicator: Log shows ~5 results selected, both signals triggering around the same position

### Scenario 2: Large, Compressed Database
- Conversation of 1000+ turns with 200+ memories
- Expected: Scores cluster tightly together; gap signal may not trigger, diversity signal carries the detection
- Success indicator: Log shows gap signal = NO, diversity signal = YES, boundary detected via diversity alone

### Scenario 3: Vague Query
- Query like "something important happened"
- Expected: No clear winners; inflection detected late
- Success indicator: Result count is higher than normal (but respects ceiling)

### Scenario 4: Specific Query
- Query like "what did Alice say about the sword?"
- Expected: Clear winners and losers; inflection detected early
- Success indicator: Result count is low, average scores are high

### Scenario 5: Disabled Feature
- Adaptive thresholding turned off
- Expected: System falls back to legacy fixed threshold
- Success indicator: Logs indicate "inflection disabled, using legacy threshold"

### Scenario 6: Pathological Case
- All candidates score identically
- Expected: Gap signal = NO (all gaps are zero), diversity signal handles the boundary
- Success indicator: Logs explain why; relies on diversity and ceiling constraints

---

## Edge Cases and Graceful Degradation

### Fewer Than 3 Results Retrieved
Signal analysis requires minimum data. If retrieval returns fewer than 3 candidates, skip inflection detection and return all retrieved results (the minimum result guarantee applies; the floor constraint does not override it).

### All Results Identically Scored
Gap signal cannot trigger (all gaps are zero). Diversity signal may or may not trigger depending on path distribution. If neither triggers, rely on ceiling constraint.

### No Signal Triggers Anywhere
This indicates results are uniformly distributed with multiple-path consensus throughout. Use the ceiling constraint to limit the final count.

### Diversity Boundary Appears at Position 0
This is unexpected and indicates possible misconfiguration in the RRF merge. Log a warning, then apply the minimum result guarantee: return the top 3 results by score regardless of the boundary position.

### Legacy Threshold Migration
When upgrading from the old system, automatically set the new minimum score floor to be at least as conservative as the legacy threshold users had configured.

---

## Implementation Approach

### Phase 1: Core Algorithm
Implement the gap-based and diversity-based signal detection independently, then combine them with OR logic.

### Phase 2: Integration
Integrate into the existing RAG fetch pipeline, replacing the current static threshold filtering.

### Phase 3: Safety Bounds
Add the absolute floor and ceiling constraints, then reorder the pipeline to apply them in the correct sequence.

### Phase 4: Observability
Add comprehensive logging so every query decision is auditable and users can understand why results were included or excluded.

### Phase 5: Configuration
Expose the minimal set of tunable settings; hardcode the rest as constants in the implementation.

### Phase 6: Testing
Run through all scenarios manually with verbose logging enabled, verify edge cases are handled gracefully.

---

## Success Criteria

Implementation is complete when:

- Both signals calculate and trigger independently based on their respective criteria
- Signals operate on genuinely different data (scores vs. paths), not the same underlying numbers with different thresholds
- Consensus logic is simple: either signal triggers the boundary
- No result exceeds the maximum result count
- At least 3 results are always returned (or all available results if fewer than 3 exist in the database); the minimum count guarantee overrides the floor constraint if necessary
- No result falls below the minimum score floor unless the minimum count guarantee forces re-admission of floor-failing results
- Logs are detailed enough to explain every boundary decision
- Disabling the feature reverts to legacy behavior without side effects
- Settings count is minimal: master toggle, min score, max results, optional overfetch multiplier, optional verbose logging
- All manual test scenarios pass
- No regression in existing retrieval functionality

---

## Performance Impact

The inflection detection adds minimal overhead:

- Calculating gaps is a single pass through the score array
- Counting paths for diversity is already available from the RRF merge
- Signal detection is a second pass through results
- Total computation: O(N) where N is the number of candidates (typically 20)

This is negligible compared to the cost of embedding API calls. The system will not be slower; if anything, by retrieving and analyzing more candidates upfront, you might retrieve fewer low-quality results downstream, reducing overall token costs.

---

## Deployment Strategy

**Initial state**: Enable the feature but log both legacy and new thresholds. This lets operators validate that the new system is working correctly before relying on it.

**Beta period**: Collect logs from users. If results differ significantly from the legacy system, adjust the hardcoded constants (gap threshold multiplier, diversity threshold).

**General availability**: Transition to the new system as the default after validation. Users can still disable it and return to legacy mode.

---

## Future Extensions (Out of Scope)

These ideas can be added later if testing shows they're needed:

- **Learning from feedback**: Track which injected memories were actually useful and adjust signal weights accordingly
- **Per-query thresholds**: Different inflection boundaries for chat chunks vs. lorebook entries vs. plot arcs
- **Semantic coherence signal**: A third truly independent signal measuring how well each result aligns with the query intent (currently the gap and diversity signals would be enough)