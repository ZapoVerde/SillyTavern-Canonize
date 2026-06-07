# Technical Specification: Dynamic Thresholding via Micro-Pool Shape Analysis

This specification defines the architectural design, mathematical framework, and algorithmic execution for a self-leveling, adaptive RAG (Retrieval-Augmented Generation) retrieval pipeline. The system is designed to dynamically scale the volume of retrieved context based on the statistical topology of a localized candidate pool rather than a global database average [docs/RAG_strategy_v2.md]. This approach provides robust precision and recall across all database scales—from empty cold-starts to massive, long-running story campaigns—without requiring manual user-facing threshold calibration [README.md, docs/RAG_strategy_v2.md].

---

## 1. Architectural Purpose and Design Philosophy

Traditional RAG retrieval models typically rely on fixed similarity thresholds (e.g., `0.75`) or fixed result counts (e.g., always returning exactly 5 results) [docs/RAG_strategy_v2.md]. These approaches degrade rapidly under real-world conditions:
1.  **The Scale-Smothering Effect:** Standard deviation and mean calculations performed over a global database pool are heavily smothered by the massive "noise floor" of hundreds of unrelated documents, masking the subtle, high-dimensional differences between the top-ranked results.
2.  **Model-Scale Sensitivity:** Similarity scores are not uniform across models. What represents a tight, highly relevant match in one embedding model may score similarly to background noise in another, leading to erratic retrieval [docs/RAG_strategy_v2.md].
3.  **Prompt Dilution and Hallucinations:** Injecting excessive or low-relevance context blocks dilutes the LLM's attention span, causing the model to ignore formatting presets, break character card instructions, and experience memory hallucinations in long chats [README.md].

To resolve these challenges, this specification introduces a **Two-Pass Localized Shape Analysis** model [docs/RAG_strategy_v2.md, rag/cutoff.js]. By extracting a fixed multiple of the user's maximum results ceiling and evaluating its local skewness and drop-off "cliffs," the engine dynamically squeezes the context window shut for highly isolated standout memories, and opens it to let rich, interconnected background context pass when appropriate [README.md, docs/RAG_strategy_v2.md, rag/cutoff.js].

---

## 2. Core Definitions and Variables

*   $M$: The user's configured maximum results ceiling (`Max Results`) [rag/cutoff.js].
*   $\text{Min}$: The user's configured minimum results floor (`Min Results`) [rag/cutoff.js].
*   $k$: The Sensitivity Factor (or strictness coefficient) representing the user's preferred strictness [settings/handlers-rag-embed.js].
*   $C$: The Candidate Pool—the array containing the top-performing results returned by the raw vector search, sorted in descending order of similarity score [docs/RAG_strategy_v2.md, rag/cutoff.js].
*   $N_C$: The size of the Candidate Pool $C$, calculated dynamically as $\max(2 \times M, 6)$ [rag/cutoff.js].
*   $\mu_C$: The arithmetic mean of the scores in the Candidate Pool $C$ [rag/cutoff.js].
*   $\tilde{x}_C$: The median score of the Candidate Pool $C$ [rag/cutoff.js].
*   $\sigma_C$: The standard deviation of the scores in the Candidate Pool $C$ [rag/cutoff.js].
*   $Sk$: The Pearson Median Skewness Coefficient of the Candidate Pool $C$.
*   $R$: The calculated dynamic scaling factor [rag/cutoff.js].
*   $M_{\text{active}}$: The final dynamically computed results limit [rag/cutoff.js].
*   $D_i$: The absolute drop-off value (the step difference) between adjacent candidates in $C$.
*   $\mu_D$: The mean drop-off value across all adjacent pairs in $C$.

---

## 3. The Algorithmic Pipeline

The retrieval engine executes this multi-pass pipeline on every generation turn [rag/rag-fetch.js]:

```text
                     [ Raw Vector Query ]
                              │
                    [ V_total <= Min? ] ───(Yes)───> [ Bypass: Return All ]
                              │ (No)
                [ Build Candidate Pool (N_C) ]
                              │
                 [ Compute Local Stats of C ]
                (mean, median, std_dev w/ floor)
                              │
               [ Calculate Pearson Skewness (Sk) ]
                              │
                 [ Compute Scaling Factor (R) ]
                              │
                  [ Derive M_active & Clamp ]
                              │
              [ Step-by-Step Cliff-Detection ]
               (relative check AND noise floor)
                              │
                   [ Final Truncated Handoff ]
```

### Pass 1: Localized Candidate Extraction
1.  Query the vector store to return raw results sorted by descending similarity score [rag/file-store.js].
2.  Evaluate the total database size ($V_{\text{total}}$).
    *   *Cold-Start Bypass:* If $V_{\text{total}} \le \text{Min}$, immediately return all available database items and terminate the pipeline.
3.  Extract the top $N_C$ items from the raw results to form the Candidate Pool $C$, where:
$$N_C = \max(2 \times M, 6)$$
*(Note: Enforcing a hard minimum size of 6 ensures the statistical calculations have sufficient data points to establish a distribution shape, even when the user configures a restrictive maximum limit, such as $M = 2$)* [rag/cutoff.js].

### Pass 2: Local Skewness Profiling
Calculate the local metrics of the Candidate Pool $C$: $\mu_C$, $\tilde{x}_C$, and $\sigma_C$. To prevent division-by-zero errors in perfectly uniform pools, enforce a minimum standard deviation floor:
$$\sigma_C = \max(\sigma_C, 0.01)$$

1.  **Calculate Pearson's Median Skewness ($Sk$):**
    Measure the distance in standard deviations between the average candidate and the middle candidate:
$$Sk = \frac{3(\mu_C - \tilde{x}_C)}{\sigma_C}$$
2.  **Compute the Scaling Factor ($R$):**
    Map the skewness exponentially to the user's strictness coefficient ($k$):
$$R = e^{-k \cdot Sk}$$
3.  **Determine the Active Limit ($M_{\text{active}}$):**
    Multiply the user's maximum ceiling by the scaling factor, rounding to the nearest integer:
$$M_{\text{active}} = \lfloor (M \times R) + 0.5 \rfloor$$
4.  **Apply Boundary Clamping:**
    Ensure the active limit never violates the user's configured floor or ceiling:
$$M_{\text{active}} = \max(\text{Min}, \min(M_{\text{active}}, M))$$

### Pass 3: Surgical Cliff-Detection Override
A "cliff" represents a distinct, mathematically significant drop-off in score between two adjacent results in the sorted pool, indicating a sharp separation between highly relevant context and trailing background noise [docs/RAG_strategy_v2.md].

1.  **Calculate Step Differences ($D_i$):**
    Calculate the positive drop-offs between adjacent scores in the sorted candidate pool for all indices from $0$ up to $N_C - 2$:
$$D_i = C_i - C_{i+1}$$
2.  **Calculate the Mean Drop-off ($\mu_D$):**
    Calculate the average step change across the $N_C - 1$ adjacent pairs:
$$\mu_D = \frac{1}{N_C - 1} \sum_{i=0}^{N_C - 2} D_i$$
3.  **Evaluate Cliff Trigger Conditions:**
    Iterate through the candidate pairs from index $0$ up to $M_{\text{active}} - 1$. If a specific step reveals an anomalous drop-off that satisfies **both** the relative step check and the absolute noise floor:
$$D_i > 1.5 \times \mu_D \quad \mathbf{AND} \quad D_i > 0.015$$
    *   *Surgical Truncation:* A genuine statistical cliff has been identified [docs/RAG_strategy_v2.md]. Immediately truncate the retrieval at that index, overriding the previously calculated limit:
$$M_{\text{active}} = i + 1$$
    *   *Terminate Evaluation:* Stop scanning; the remaining trailing candidates are discarded [docs/RAG_strategy_v2.md].

---

## 4. Mathematical Behavior Profiles

The pipeline adapts organically to the narrative flow of a conversation by resolving into four distinct mathematical shapes [docs/RAG_strategy_v2.md, rag/cutoff.js]:

*   **The Sharp Peak (Right-Skewed / $Sk > 0$):** Occurs during a hyper-specific callback (e.g., referencing a rare weapon). A single elite memory scores very high, while trailing items drop off sharply. $Sk$ becomes positive, driving $R$ below `1.0`. The active window squeezes down to $\text{Min}$, shutting out trailing filler [docs/RAG_strategy_v2.md, rag/cutoff.js].
*   **The High Plateau (Left-Skewed / $Sk < 0$):** Occurs during continuous, thematic scenes (e.g., an ongoing battle). Multiple memories match heavily with identical keyword and conceptual density. $Sk$ becomes negative, driving $R$ above `1.0`. The window expands up to $M$, allowing rich background context to pass [docs/RAG_strategy_v2.md, rag/cutoff.js].
*   **The Symmetric Flatline ($Sk \approx 0$):** Occurs when scores degrade linearly or remain completely uniform. $R$ settles at `1.0`, yielding the user's standard $M$ limit, unless the Cliff-Detector identifies a clean break-point [docs/RAG_strategy_v2.md, rag/cutoff.js].
*   **The Sandwich Distribution:** Occurs when there is one hyper-relevant standout, a cluster of mediocre results, and one massive trailer. The Skewness math provides the baseline window reduction, while the Cliff-Detector snaps a hard line right after the first standout item, isolating the elite signal [docs/RAG_strategy_v2.md, rag/cutoff.js].

---

## 5. Interface and Telemetry Specifications

### User Interface Surface
To preserve the extension's usability guidelines, the underlying statistical complexity is entirely hidden behind three simple, intuitive configuration controls [settings/panel.js, settings/html-rag.js]:
*   **Max Results ($M$):** Numeric slider representing the hard ceiling of allowed context items [settings/html-rag.js].
*   **Min Results ($\text{Min}$):** Numeric slider representing the hard floor of required context items [settings/html-rag.js].
*   **Memory Focus / Strictness ($k$):** A slider ranging from `0.1` (Highly Permissive / Expanded Windows) to `1.5` (Highly Strict / Selective Windows). Default baseline is set to `0.7`.

### Telemetry Logging Format
For auditing retrieval behavior during active chat sessions, the engine outputs a structured string to the debug console and appends telemetry metadata to the runtime logs (`cnz_rag_health.csv`) on every turn using the following scheme [README.md, log.js, rag/rag-health.js]:

```json
{
  "telemetry": {
    "database_total_items": 412,
    "candidate_pool_size": 12,
    "local_mean": 0.814,
    "local_median": 0.785,
    "local_std_dev": 0.042,
    "pearson_skewness": 2.071,
    "sensitivity_k": 0.7,
    "scaling_factor_R": 0.235,
    "clamped_m_active": 2,
    "cliff_detected": true,
    "cliff_index": 1,
    "final_returned_count": 1
  }
}
```