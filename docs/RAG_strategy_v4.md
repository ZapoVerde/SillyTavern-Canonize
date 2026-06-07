# Technical Specification: v4 — Hybrid Micro-Pool Threshold

This specification describes the RAG retrieval strategy implemented on the `rag-v3-dynamic-threshold` branch. It supersedes v3 [docs/RAG_strategy_v3.md], which used a skewness-driven exponential scaling factor and cliff detection — both abandoned for simpler, more interpretable equivalents.

---

## 1. Design Philosophy

### Why v3 was rejected

v3 computed a scaling factor $R = e^{-k \cdot Sk}$ to adjust the result window. Two problems emerged in testing:

1. **Cliff detection fires too easily.** Mean drop-off $\mu_D$ is computed over the entire pool, including a flat noise plateau. One genuine gap trivially exceeds $1.5 \times \mu_D$.
2. **$k$ is hard to reason about.** The exponential is steep and non-intuitive; small changes at high skewness values swing the window dramatically.

### What v4 does instead

v4 combines two well-established ideas:

1. **Local micro-pool statistics** — compute mean/σ/skewness on only the top $N_C$ candidates rather than the full database, eliminating the scale-smothering effect of a noise floor with hundreds of irrelevant documents.
2. **Hybrid search** — fuse vector similarity (cosine) with keyword relevance (TF-IDF) before applying the threshold, using an anchored normalisation so the keyword contribution is always expressed as a fraction of the strongest vector score in this query.

The result is a retrieval pipeline that adapts to both the *shape* of the query's semantic neighbourhood and the *lexical specificity* of individual terms (proper nouns, rare phrases) that embedding models sometimes smooth over.

---

## 2. Variables

| Symbol | Meaning |
|---|---|
| $M$ | Max results ceiling |
| $\text{Min}$ | Min results floor |
| $P$ | Pool multiple (default 2) |
| $\alpha$ | Vector/keyword blend weight (default 0.7) |
| $V_{\text{total}}$ | Total items in raw result set |
| $N_C$ | Candidate pool size: $\max(\lfloor P \times M \rceil, 6)$ |
| $C$ | Sorted descending slice of length $N_C$ from blended results |
| $s^{\text{vec}}_i$ | Vector score for item $i$ (best cosine across content/header lanes, ×1.08 if both matched) |
| $t_i$ | Raw TF-IDF score for item $i$ from keyword search (null if no match) |
| $s_i$ | Final blended score for item $i$ |
| $\mu_C$ | Arithmetic mean of $s_i$ in $C$ |
| $\tilde{x}_C$ | Median of $s_i$ in $C$ |
| $\sigma_C$ | Population standard deviation of $C$ (floor 0.01) |
| $Sk$ | Pearson Median Skewness — telemetry only |
| $\theta$ | Decision threshold |
| $M_{\text{active}}$ | Final returned count |

---

## 3. Algorithmic Pipeline

```
[ Raw Vector Query ]            [ FTS Keyword Query ]
        │                               │
        └──────── RRF Fusion ───────────┘
                      │
               [ s_vec per item ]
               [ t_kw  per item ]
                      │
         [ Temporal decay (chat only) ]
                      │
         [ Keyword blend → s_i ]
                      │
        [ V_total ≤ Min? ] ──(Yes)──> [ Cold-start bypass ]
                      │ (No)
        [ Slice top N_C → pool C ]
                      │
        [ Compute μ, median, σ, Sk on C ]
                      │
        [ Apply cutoff mode → threshold θ ]
                      │
        [ Filter C: s_i > θ → above_threshold ]
                      │
        [ len < Min? ]
          (Yes)──> [ Floor: return top Min from full sorted ]
          (No) ──> [ Clamp to Max ]
```

### Step 1 — RRF fusion

Three lanes are merged per item:

- **Content lane:** cosine similarity between the query vector and the chunk's content embedding.
- **Header lane:** cosine similarity against the chunk's header/summary embedding. Items matching both content and header receive a 1.08× dual-confirmation bonus.
- **Keyword lane:** TF-IDF score from a full-text search index built over chunk content. Raw scores are preserved as $t_i$ for use in the blend step.

Each item's vector score $s^{\text{vec}}_i$ is the best cosine seen across content and header lanes (after dual bonus). Keyword-only items (no vector match) carry $s^{\text{vec}}_i = 0$.

### Step 2 — Temporal decay (chat channel only)

```
age    = max(0, totalPairs - pairEnd)
factor = max(0.70, 1.0 - 0.025 × ln(age + 1))
s_vec  = s_vec × factor
```

Older chunks are gently down-weighted. The floor of 0.70 prevents ancient-but-relevant chunks from being buried entirely.

### Step 3 — Keyword blend

For each channel independently:

$$s^{\text{kw-max}} = (1 - \alpha) \times \max_i(s^{\text{vec}}_i)$$

$$s_i = s^{\text{vec}}_i + \frac{t_i}{t_{\max}} \times s^{\text{kw-max}}$$

The top keyword match contributes exactly $(1-\alpha) \times$ the strongest vector score in this result set. All other keyword contributions are proportional. Items with no keyword match receive no bonus. Keyword-only items (no vector match) have $s^{\text{vec}}_i = 0$ and rank purely on their keyword contribution, capped at $s^{\text{kw-max}}$.

This anchoring means the blend weight $\alpha$ is directly interpretable: at $\alpha = 0.7$, the keyword lane can contribute at most 30% of the top vector score, regardless of the absolute TF-IDF values.

### Step 4 — Pool statistics

Extract the top $N_C$ blended scores into pool $C$:

$$N_C = \max\!\left(\left\lfloor P \times M \right\rceil,\ 6\right)$$

Compute:

$$\mu_C,\quad \tilde{x}_C,\quad \sigma_C = \max\!\left(\sqrt{\tfrac{1}{N_C}\sum(s_i - \mu_C)^2},\ 0.01\right)$$

$$Sk = \frac{3(\mu_C - \tilde{x}_C)}{\sigma_C} \quad \text{(logged, not used for cutoff)}$$

### Step 5 — Threshold and clamp

| Cutoff Mode | Threshold |
|---|---|
| `mean` | $\theta = \mu_C$ |
| `mean+1sd` | $\theta = \mu_C + \sigma_C$ |
| `mean+2sd` | $\theta = \mu_C + 2\sigma_C$ |

```
above_threshold = [ c ∈ C : s_i > θ ]

if len(above_threshold) < Min:
    M_active = top Min from full sorted list
else:
    M_active = above_threshold[:Max]
```

---

## 4. Behavioural Profiles

| Query type | Pool shape | Outcome |
|---|---|---|
| Hyper-specific callback (proper noun) | One standout; keyword lane boosts it further | Threshold above most items → Min returned |
| Thematic dense scene | Multiple items cluster near top | Several clear the mean → fills toward Max |
| Uniform noise | Flat pool | Most items near or below mean → Min returned |
| Keyword-rich query | Strong TF-IDF hits on rare terms | Keyword contribution rescores items, may change cutoff boundary |
| Cold/sparse | $V_{\text{total}} \le \text{Min}$ | Bypass — all items returned |

---

## 5. Controls

| Setting | Key | Effect |
|---|---|---|
| Min Results | `ragChatMin` / `ragLbMin` | Floor on returned items |
| Max Results | `ragChatMax` / `ragLbMax` | Ceiling on returned items |
| Pool Multiple ($P$) | `ragPoolMultiple` | Pool size = P × Max (min 6). Larger pools give the statistics more shape but don't raise Max |
| Cutoff Mode | `ragCutoffMode` | `mean` is permissive; `mean+2sd` is selective |
| Keyword Blend ($\alpha$) | `ragKwBlend` | 0 = keyword dominates; 1 = vector only. Default 0.7 |

### Tuning guidance

- Start with `mean`, $P=2$, $\alpha=0.7$.
- If too many marginal results are injected, try `mean+1sd` before lowering $\alpha$.
- Raise $P$ to 3–4 when Max is large (≥10) so the pool has enough shape for stable statistics.
- Lower $\alpha$ toward 0.5–0.6 if your queries are proper-noun-heavy (character names, place names) and semantic similarity alone is missing them.
- `mean+2sd` is rarely useful outside dense chats where a clear elite tier separates from background.

---

## 6. Console Telemetry

Every channel emits a collapsible group each turn:

```
[CNZ] chat | 96 raw  pool=20  μ=0.685  Sk=0.91  (mean)  kw≤0.213  → 9 injected
  ████████████████████  355+313+213=881
  ████████████████░░░░  390+319+148=857
  ...
  ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌ cutoff  (threshold 0.685)
  ██████████████░░░░░░  318+274+70=662
  ...
```

**Header fields:**
- `raw` — total candidates from vector store
- `pool` — N_C (pool size used for statistics)
- `μ` — pool mean (the `mean` threshold value)
- `Sk` — Pearson Median Skewness (display only)
- `(mode)` — active cutoff mode
- `kw≤` — maximum keyword contribution in this result set (omitted if no keyword matches)
- `→ N injected` — items returned above threshold

**Bar format:** Each bar line shows:
```
  [████blue████][███amber███][██green██][░░░░░░░░]  content+header+kw=total
```
- **Blue** (`#4fc3f7`) — content embedding contribution (proportional to content cosine score)
- **Amber** (`#ffb74d`) — header embedding contribution (proportional to header cosine score)
- **Green** (`#81c784`) — keyword contribution (proportional to actual blended contribution)
- **Dark** (`#3a3a3a`) — empty/trailing fill
- Score suffix: three integers summing to the blended score × 1000

All items (above and below cutoff) are colored. The cutoff line visually separates injected from non-injected. Bar lengths use absolute normalization: `barLen = round(score / poolMax × 20)`.

**Channels:** Chat, LB, and plot all run the full pipeline (vector + FTS + blend) and display identical bar format. LB entries use a single content vector lane (the combined comment+keys+content embedding) so bars are blue/green only — no amber header lane.

**Health CSV columns:** `timestamp, character, channel, provider, model, candidates, max_score, min_score, pool_size, local_mean, local_median, local_std_dev, pearson_skewness, threshold, cutoff_mode, returned`

---

## 7. What was removed from v3

| v3 feature | Reason removed |
|---|---|
| Sensitivity factor $k$ | Non-intuitive exponential; hard to explain |
| Scaling factor $R = e^{-k \cdot Sk}$ | Skewness as decision variable produces unstable windows |
| Cliff detection | Flat noise plateau makes $\mu_D$ trivially small; cliff triggers constantly |
| $M_{\text{active}}$ as computed expansion | Eliminated; window only filters, never inflates |
| Fixed `KEYWORD_SCORE = 0.3` | Replaced by anchored normalisation; keyword-only items now rank by actual TF-IDF strength |
| Keyword as boolean tag | Keyword contribution is now proportional and scored; visible in bar breakdown |
