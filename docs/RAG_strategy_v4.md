# Technical Specification: v4 — Local Pool Mean Threshold

This specification describes the RAG retrieval strategy implemented in `rag/cutoff.js` as of the `rag-v3-dynamic-threshold` branch. It supersedes v3 [docs/RAG_strategy_v3.md], which proposed a more complex skewness-driven exponential scaling factor and cliff detection. Those were abandoned in favour of a simpler, more interpretable approach that achieves the same practical goal with fewer failure modes.

---

## 1. Design Philosophy

### Why v3 was rejected

v3 computed a scaling factor $R = e^{-k \cdot Sk}$ to adjust the result window. Two problems emerged during testing:

1. **Cliff detection fires too easily.** The mean drop-off $\mu_D$ is computed over the entire pool, including a flat noise plateau. One genuine gap in a sea of flat scores trivially exceeds $1.5 \times \mu_D$, making the cliff trigger at almost every turn.
2. **$k$ is hard to reason about.** The exponential maps non-intuitively: small changes in $k$ at high skewness values swing the window dramatically, making tuning opaque.

### What v4 does instead

v4 applies v2-style thinking (a statistical threshold) to a v3-style micro-pool (a local window, not the global database). The threshold is the pool mean — or mean plus one or two standard deviations — applied directly to candidate scores. No scaling factor, no cliff detection.

The key insight: we are characterising the *decision surface* of the top candidates, not estimating a population parameter. A pool of 16 items drawn from the top of a 400-item database is not too small for statistics — it is exactly the right shape to describe the question "where does relevance fall off in this query?"

---

## 2. Variables

| Symbol | Meaning |
|---|---|
| $M$ | Max results ceiling (user setting) |
| $\text{Min}$ | Min results floor (user setting) |
| $P$ | Pool multiple (user setting, default 2) |
| $V_{\text{total}}$ | Total items in raw result set |
| $N_C$ | Candidate pool size: $\max(\lfloor P \times M \rceil, 6)$ |
| $C$ | Sorted descending slice of length $N_C$ from raw results |
| $\mu_C$ | Arithmetic mean of scores in $C$ |
| $\tilde{x}_C$ | Median score of $C$ |
| $\sigma_C$ | Population standard deviation of $C$ (floor 0.01) |
| $Sk$ | Pearson Median Skewness of $C$ — telemetry only |
| $\theta$ | Decision threshold derived from $\mu_C$ and mode |
| $M_{\text{active}}$ | Final returned count after threshold and clamping |

---

## 3. Algorithmic Pipeline

```
[ Raw Vector Query ]
        │
[ V_total ≤ Min? ] ──(Yes)──> [ Cold-Start Bypass: return all ]
        │ (No)
[ Slice top N_C → pool C ]
        │
[ Compute μ, median, σ, Sk on C ]
        │
[ Apply cutoff mode → threshold θ ]
        │
[ Filter C: score > θ → above_threshold ]
        │
[ above_threshold.length < Min? ]
  (Yes)──> [ Floor: return top Min from sorted ]
  (No) ──> [ Clamp to Max: return above_threshold[:Max] ]
```

### Step 1 — Cold-start bypass

If $V_{\text{total}} \le \text{Min}$, return all candidates immediately and emit `metadata: null`. There is no meaningful distribution to analyse.

### Step 2 — Build candidate pool

Extract the top $N_C$ items from the sorted raw results:

$$N_C = \max\!\left(\left\lfloor P \times M \right\rceil,\ 6\right)$$

The minimum of 6 prevents degenerate statistics when Max is set very low (e.g. Max=2, P=2 would yield N_C=4 without the floor).

### Step 3 — Pool statistics

Compute over the pool $C$:

$$\mu_C = \frac{1}{N_C}\sum_{i=0}^{N_C-1} c_i$$

$$\tilde{x}_C = \text{median}(C)$$

$$\sigma_C = \max\!\left(\sqrt{\frac{1}{N_C}\sum_{i=0}^{N_C-1}(c_i - \mu_C)^2},\ 0.01\right)$$

$$Sk = \frac{3(\mu_C - \tilde{x}_C)}{\sigma_C} \quad \text{(display only — does not affect cutoff)}$$

Skewness is retained as telemetry. It is logged in the console header and written to `cnz_rag_health.csv`. It may inform a future v5 strategy but is not a decision variable here.

### Step 4 — Threshold

The threshold $\theta$ is selected by the user's Cutoff Mode setting:

| Mode | Threshold |
|---|---|
| `mean` | $\theta = \mu_C$ |
| `mean+1sd` | $\theta = \mu_C + \sigma_C$ |
| `mean+2sd` | $\theta = \mu_C + 2\sigma_C$ |

### Step 5 — Filter and clamp

```
above_threshold = [ c ∈ C : c.score > θ ]

if len(above_threshold) < Min:
    M_active = top Min items from full sorted list   # floor guarantee
else:
    M_active = above_threshold[:Max]                 # clamp to ceiling
```

The floor path pulls from the full sorted list (not just the pool) so that cold/sparse queries always return something useful even when the pool mean is artificially high.

---

## 4. Behavioural Profiles

| Query type | Pool shape | Outcome |
|---|---|---|
| Hyper-specific callback | One standout, pool drops sharply | Mean threshold above all but the top item → returns Min |
| Thematic dense scene | Multiple items cluster near the top | Items above mean may fill to Max |
| Uniform noise | Flat pool, all items near mean | Most items are near or below mean → returns Min |
| Cold/sparse | V_total ≤ Min | Bypass — all items returned |

The key difference from v3: there is no amplification mechanism. The window never expands beyond what clears the threshold. The pool multiple $P$ is the tuning knob for how much context to give the statistics, not for inflating the result count.

---

## 5. Controls

Three knobs directly affect retrieval volume; one affects only pool statistics:

| Setting | ID | Effect |
|---|---|---|
| Min Results | `ragChatMin` / `ragLbMin` | Floor on returned items |
| Max Results | `ragChatMax` / `ragLbMax` | Ceiling on returned items |
| Pool Multiple ($P$) | `ragPoolMultiple` | Controls pool size; larger values give more context to the statistics but do not raise Max |
| Cutoff Mode | `ragCutoffMode` | Threshold strictness: `mean` is most permissive, `mean+2sd` is most selective |

### Guidance for tuning

- Start with `mean`, `P=2`, and your preferred Min/Max.
- If too many marginally relevant results are being injected, raise to `mean+1sd` before reaching for `mean+2sd`.
- Increase $P$ (to 3 or 4) when your Max is large (≥10) so the pool has enough shape to be meaningful.
- `mean+2sd` is useful only in very dense chats where a clear elite tier separates from background; in short chats it will almost always hit the Min floor.

---

## 6. Console Telemetry

Every channel emits a collapsible group on each turn:

```
[CNZ] chat | 81 raw  pool=16  μ=0.513  Sk=1.40  (mean)  → 5 injected
  c+h    ████████████████████  0.578
  c      ██████████████████░░  0.561
  ...
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ cutoff  (threshold 0.513)
  k      ████████████████░░░░  0.497  ← gray (below cutoff)
  ...
```

**Bar normalization:** Absolute — `barLen = round(score / poolMax × 20)`. Bars are not range-normalized because range compression exaggerates small differences. A short bar on an absolute scale is meaningful; a short bar on a compressed scale is misleading.

**Lane colors (chat channel only):**

| Lane | Color | Trigger |
|---|---|---|
| content | `#4fc3f7` (blue) | Chunk matched via content body embedding |
| header | `#ffb74d` (amber) | Chunk matched via header embedding |
| keyword | `#81c784` (green) | Chunk matched via FTS keyword hit |

Each filled bar is divided into equal segments, one per source lane that contributed to the chunk's RRF score. Items below the cutoff line are rendered gray regardless of lanes. LB and plot channel items have no source field (no RRF layer) and render as a single inherit-color bar.

**Health CSV columns:** `timestamp, character, channel, provider, model, candidates, max_score, min_score, pool_size, local_mean, local_median, local_std_dev, pearson_skewness, threshold, cutoff_mode, returned`

---

## 7. What was removed from v3

| v3 feature | Reason removed |
|---|---|
| Sensitivity factor $k$ | Exponential mapping is non-intuitive; hard to explain to users |
| Scaling factor $R = e^{-k \cdot Sk}$ | Skewness as a direct decision variable produces unstable windows |
| Cliff detection | Mean drop-off $\mu_D$ computed over a flat noise plateau makes the threshold trivially easy to exceed |
| $M_{\text{active}}$ as a computed expansion | Eliminated; the window never inflates, only filters |

Skewness is retained as an observable. If a future version finds a reliable way to use pool shape as a signal (e.g. high positive skew reliably meaning "one standout, cut at Min"), that would become v5.
