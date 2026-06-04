# RAG Retrieval Strategy v2: Distributional Cutoff

*Supersedes `RAG_strategy.md` (2026-06-04)*

---

## The Core Insight

Vectra already scores every vector in the collection on every query — cosine similarity against all stored embeddings is computed regardless of how many results are returned. The old design discarded those scores (replacing them with a hardcoded `1` in `toRow`) and used rank position alone for RRF. This threw away the primary signal.

The new design preserves and uses those scores. Because Vectra has done the work, the only cost of getting the full result set is returning more rows over the local HTTP call — negligible compared to the embedding API call that precedes it.

---

## What Changes and Why

### No more topK as a user concept

`topK` was always the wrong knob. It assumes you know how many results you want before you look at the data. The whole point of this design is that you let the score distribution tell you. `topK` becomes an internal constant — large enough to return the full collection — not a user-facing setting.

### No more overfetch

Overfetch (`pool = topK * 2`) was a workaround for the same problem: we were guessing a number slightly bigger than the fixed topK so we had room to manoeuvre. Once we query for the full collection, the concept has no meaning. The full set is the pool.

### Actual cosine scores, not rank positions

`toRow` currently replaces every Vectra similarity score with `1`. The new design passes the real score through so the distributional analysis has something to work with.

---

## Algorithm

Three steps. No linearity detection, no gap analysis, no path diversity signal.

### Step 1 — Query for everything

Query both Vectra collections (content lane, header lane) with `topK` set to a constant large enough to cover the maximum expected collection size. Run FTS in parallel as before. Fuse via RRF as before, but carry the real Vectra scores through rather than replacing them.

### Step 2 — Signal strength test

Compute the normalised range of the fused score list:

```
signal_strength = (max_score - min_score) / max_score
```

This is scale-invariant (a ratio, not an absolute) and model-agnostic. It answers: is there meaningful discrimination in this result set, or is everything clustered together?

If `signal_strength < threshold`: **return `min` results and stop.** There is no useful distribution to analyse. Returning more would be noise.

### Step 3 — Mean cutoff, clamped

Compute `μ` (mean) of the fused score list. Return every result where `score > μ`, then clamp to `[min, max]`.

- `min` guarantees the LLM always has some context to operate on
- `max` prevents runaway context consumption on broad queries
- The mean cutoff adapts to the query — a tight, high-relevance result set has a high mean; a diffuse result set has a lower one

---

## Why No Linearity Detection

The earlier design proposed treating linear and non-linear score distributions differently. This turns out to be unnecessary:

- The signal strength test already handles the "flat distribution, no signal" case — if the range is too small, we return `min` without looking at shape
- Once the range test passes, "everything above mean" works the same regardless of distribution shape: for a non-linear distribution it captures the clearly-relevant cluster; for a linear distribution with real signal it captures the top half, which `max` bounds if needed
- Detecting linearity (via R² fit) adds complexity without changing the operation

---

## Configuration Surface

Three knobs, all user-facing:

| Setting | Role |
|---|---|
| `min` | Floor — minimum results to always return |
| `max` | Ceiling — maximum results to ever return |
| `signalStrengthThreshold` | Sensitivity of the no-signal test. Lower = accept weaker signal and proceed to mean cutoff; higher = require strong discrimination before trusting the distribution |

Everything else is a hardcoded internal constant. The query `topK` constant (e.g. 1000) is not exposed.

---

## Logging

Every fetch should log enough to audit the decision:

```
Scores (fused, 47 results): max=0.84 min=0.31 μ=0.58
Signal strength: 0.631 (threshold 0.20) — PASS
Above mean: 23 results → clamped to max(12) → 12 injected
```

On no-signal:

```
Scores (fused, 31 results): max=0.62 min=0.58 μ=0.60
Signal strength: 0.065 (threshold 0.20) — FAIL
Returning min(3)
```

---

## Scope and Limits

Retrieval is responsible for two things: identifying whether a meaningful signal exists in the result set, and shaping the candidate set when it does. It is not responsible for determining whether a retrieved chunk is actually correct or relevant to the current narrative moment — only that it scored well against the query.

This distinction matters in multi-cluster distributions. If the score list has two groups — say, a cluster around 0.8 and another around 0.5 — the mean cutoff may land cleanly between them or may split the lower cluster. Both outcomes are acceptable. The system passes a reasonable candidate set downstream and trusts the LLM to use what it needs and ignore what it doesn't. Introducing additional logic to detect and handle clusters would be retrieval attempting to do the LLM's job.

The same applies to the no-signal case. Returning `min` results when signal strength fails is not a recovery mechanism — it is a deliberate handoff. The LLM receives minimal context and proceeds. Whether that context is useful is the LLM's determination to make.

This is the boundary: retrieval shapes signal where signal exists, and fails gracefully where it does not. Final disambiguation belongs downstream.

---

## What This Replaces

The old two-signal design (gap-based inflection + path diversity) was abandoned because:

- Gap detection and slope detection are correlated — they operate on the same score array and tend to agree, violating the independence assumption the design depended on
- Path diversity (counting how many RRF lanes voted for each result) is a secondary confirmation, not an independent signal; a single-lane result with a high score is still a good result
- The inflection-point framing assumes a clear elbow in the distribution; many real distributions don't have one, requiring extensive edge-case handling
- The fixed `noiseFloor` (0.15) was model-dependent and decayed in usefulness as the collection grew

The distributional cutoff is simpler, has fewer failure modes, and produces the same result in the clear cases while degrading more gracefully in the ambiguous ones.
