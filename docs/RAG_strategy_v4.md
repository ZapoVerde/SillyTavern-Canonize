# Technical Specification: v4 — Hybrid Micro-Pool Threshold

This specification describes the RAG retrieval strategy implemented on the `rag-v3-dynamic-threshold` branch.

---

## 1. Design Philosophy

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

## Appendix A: Understanding the Knobs — 2×-Mean vs. 5×-1sd

The reason two configurations can return a similar *number* of results on standard queries yet behave differently comes down to how **pool size ($N_C$)** and **threshold strictness** interact with score distributions.

The two profiles below are specific combinations of the Pool Multiple ($P$) and Cutoff Mode controls — not named presets.

| Profile | $P$ | Mode | Strategy | Target Behaviour |
| :--- | :--- | :--- | :--- | :--- |
| **2×-Mean** | 2 | `mean` | **Local Neighbourhood** | Inclusive. Looks at the immediate top candidates and takes the average of that tight group. |
| **5×-1sd** | 5 | `mean+1sd` | **Elite Signal** | Discriminatory. Reaches deep into the pool to establish a background level, then demands results stand meaningfully above it. |

---

### The Mathematical Dissection

Assume **Max Results ($M$)** = 8, **Min** = 2.

#### Profile A: 2×-Mean (P=2, Mode=mean)

- **Pool Size ($N_C$):** $2 \times 8 = 16$ candidates.
- **The Math:** Compute the mean of the top 16 blended scores ($\mu_{C16}$).
- **Threshold:** $\theta = \mu_{C16}$.
- **Behaviour:** The pool consists mostly of your best-performing candidates. The mean is relatively high, but any result even slightly better than average for that top tier will pass.

#### Profile B: 5×-1sd (P=5, Mode=mean+1sd)

- **Pool Size ($N_C$):** $5 \times 8 = 40$ candidates.
- **The Math:** By reaching 24 candidates deeper, the pool collects lower-scoring items that **drag $\mu_{C40}$ down**.
- **Threshold:** $\theta = \mu_{C40} + \sigma_{C40}$.
- **Behaviour:** The depressed mean is compensated by requiring items to stand one standard deviation above it. Items must clear a higher bar relative to the extended background.

---

### Visualising the Outcomes

#### Scenario 1: The Standard Thematic Query

Active, coherent scene. The database has a healthy gradient of strong to moderate matches.

**Scores:** `[0.85, 0.82, 0.78, 0.75, 0.70, 0.65, 0.62, 0.58]` followed by gradual decay to `0.20` at candidate 40.

**2×-Mean (pool of 16):**
- Pool Mean ($\mu_{C16}$) $\approx 0.59$.
- Threshold: `0.59`.
- Kept: items 1–7 (`[0.85, …, 0.62]`).
- **Returned: 7**

**5×-1sd (pool of 40):**
- Pool Mean ($\mu_{C40}$) $\approx 0.38$ (dragged down by the long tail of lower scores).
- Pool Std Dev ($\sigma_{C40}$) $\approx 0.18$.
- Threshold ($\mu + \sigma$): `0.38 + 0.18 = 0.56`.
- Kept: items 1–8 (`[0.85, …, 0.58]`), clamped to Max.
- **Returned: 8**

> **The Lesson:** On healthy queries, both modes reach broadly the same result through different paths. 2×-Mean uses a high baseline with a low hurdle; 5×-1sd uses a lower baseline with a higher hurdle. Mean mode may pull in one or two additional high-scoring neighbours; signal mode is slightly tighter around genuine peaks.

---

#### Scenario 2: The Flat Noise Query

Generic banter. No real matches in the database — the top scores form a flat plateau of mediocre, undifferentiated results.

**Scores:** `[0.45, 0.44, 0.43, 0.42, 0.41, 0.40, 0.39, 0.38]` decaying to `0.30` at candidate 16, `0.25` at candidate 40.

**2×-Mean (pool of 16):**
- Pool Mean ($\mu_{C16}$) $\approx 0.375$ (pool includes the declining tail from 0.38 to 0.30).
- Threshold: `0.375`.
- Kept: all eight plateau items — each scores above the group average.
- **Returned: 8**
- **The problem:** Token leak. The pool was small and set its own mean against a modest group, and every flat-noise item cleared it.

**5×-1sd (pool of 40):**
- Pool Mean ($\mu_{C40}$) $\approx 0.33$ (reaching further into the tail pulls the mean below the plateau).
- Pool Std Dev ($\sigma_{C40}$) $\approx 0.05$.
- Threshold ($\mu + \sigma$): `0.33 + 0.05 = 0.38`.
- Kept: items above `0.38`: `[0.45, 0.44, 0.43, 0.42, 0.41, 0.40, 0.39]` — the weakest plateau item fails.
- **Returned: 7**

The mean mode passes its whole flat plateau. The signal mode already trims the weakest item. On a truly flat pool the effect is more dramatic — see below.

> **The Innate Clamp:** When scores are genuinely flat, the pool's natural standard deviation approaches zero. The implementation floors $\sigma$ at `0.01` — a guard against degenerate statistics, not a noise-detection feature. This raises the threshold to $\mu + 0.01$, sitting just above the entire flat cluster. Nothing clears it; the result collapses to `Min`. There is no special detection path — this falls directly out of the threshold arithmetic. Mean mode has no equivalent: its threshold is always $\mu$, so the top half of any pool passes regardless of how tight the spread is.

---

### Trade-offs: Choosing Your Profile

#### 2×-Mean (Inclusive Neighbourhood)

- **Best for:** Small databases, early chats, or thematic stories where high recall matters — you want surrounding context even if some of it is marginal.
- **The risk:** Vulnerable to leaking mediocre context when overall match quality is low. The threshold is set by the pool's own mean, so a uniformly weak pool grades on a curve.

#### 5×-1sd (Discriminatory Elite)

- **Best for:** Large databases (thousands of turns), multi-genre stories, or when you want high precision — only standout hits.
- **The risk:** Can be aggressive on high-contrast queries. A single strong outlier (e.g., `0.95`) inflates $\sigma$, raising the threshold high enough to choke off solid `0.68` results that would otherwise be useful.
