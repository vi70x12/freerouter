# Dynamic Degradation + Boost Multiplier — Requirements

## 1. Problem Statement

The Thompson-sampling bandit router routes via `score = combineScore(reliability, speed, intelligence) × degradationFactor`. When an operator wants to test a new model or temporarily route more traffic to a specific model, there is no clean mechanism. Manually reordering the fallback chain is coarse and doesn't interact with the bandit scores.

The system needs a **per-model boost multiplier** that:
- Multiplies the final score after degradation (so degradation still protects against truly broken models)
- Is adjustable per-model via API and dashboard UI
- Has configurable min/max bounds to prevent operator accidents
- Persists across restarts
- Integrates naturally with the existing dynamic degradation system

## 2. User Stories

### US-1: Temporary Model Promotion
**As an operator**, I want to set a boost multiplier > 1 on a specific model so the Thompson sampler heavily prioritizes it, so I can evaluate a newly-added endpoint before it has enough traffic to earn a high bandit score.

### US-2: Temporary Model Demotion
**As an operator**, I want to set a boost multiplier < 1 (but > 0) on a specific model so it is deprioritized without being completely disabled, so I can temporarily route away from a flaky model while keeping it in the chain for emergencies.

### US-3: Visual Control
**As an operator**, I want a slider in the dashboard to adjust the boost for any model, so I don't need to craft curl commands.

### US-4: Safety Bounds
**As an operator**, I want the system to enforce configurable min/max boost limits so a typo or bug doesn't set a 10,000× boost or a negative boost.

### US-5: Persistence
**As an operator**, I want boost values to survive server restart, so I don't re-apply them after every deploy.

### US-6: Coexistence with Degradation
**As an operator**, I want the boost to multiply the **post-degradation** score, so a model with a high boost but also heavy degradation is still somewhat protected (boost amplifies, but degradation can still drive the score near zero).

## 3. Functional Requirements

### FR-B1: Boost Multiplier
Each model shall have a `boost` multiplier (default 1.0). The final routing score becomes:

```
finalScore = combineScore(reliability, speed, intelligence) × degradationFactor × boost
```

where `boost ∈ [boostMin, boostMax]` (see FR-B7).

### FR-B2: Boost API
The dashboard API shall expose:

- `GET /api/fallback/boost` — returns all model boost values (read from DB, not in-memory cache)
- `PUT /api/fallback/boost/:modelDbId` — body `{ boost: number }`, validates bounds, persists to DB, updates in-memory cache
- `DELETE /api/fallback/boost/:modelDbId` — resets boost to 1.0 (default), deletes row from DB, updates in-memory cache

### FR-B3: Boost Applied After Degradation
Boost must multiply the score **after** the degradation factor, not before. This preserves the safety property: a model at `penalty=100` (degradationFactor≈0.02) with `boost=100` still has `finalScore ≈ base × 2.0`, which is competitive but not absurd — the model is still somewhat penalized for being broken.

### FR-B4: Boost in Dashboard
The degradation dashboard panel (`/degradation` endpoint and UI) shall display the current boost value alongside penalty and display tier. Operators can adjust boost via a slider.

### FR-B5: Boost Persistence
Boost values shall be stored in the same `model_degradation` table as penalties (or a new `model_boost` table if that is cleaner). On startup, boost values are loaded into the in-memory degradation state.

### FR-B6: Boost Event
Setting or clearing a boost shall emit a `degradation.boost` event via the `publish()` event bus for observability.

### FR-B7: Configuration Bounds

| Parameter | Env Var | Default |
|-----------|---------|---------|
| Minimum boost | `DEGRADE_BOOST_MIN` | 0.1 |
| Maximum boost | `DEGRADE_BOOST_MAX` | 100.0 |

Values outside this range shall be clamped on write and the API shall return 400.

### FR-B8: Default Boost
A model with no explicit boost row in the database has an implicit boost of 1.0 (neutral). Deleting a boost row resets to 1.0.

## 4. Integration with Existing Dynamic Degradation

### FR-D1 (existing, retained): Severity Classification
Remain as before — errors classified into `minor`/`major`/`critical` tiers with the same triggers and the `consecutiveMajorHits` rule.

### FR-D2 (existing, retained): Progressive Penalty Accumulation
Remain as before — compounding formula, float snapping, `consecutiveMajorHits` for critical escalation.

### FR-D3 (existing, retained): Dynamic Expiry (Recovery)
Remain as before — per-tier half-lives, ratchet-up half-life policy, float snapping at <0.01.

### FR-D4 (existing, retained): Success Recovery
Remain as before — `floor(penalty × successRecovery)` recovery, reset counters, snap to zero at <1.

### FR-D5 (existing, retained): Degradation Factor
Remain as before — `1 / (1 + (penalty/maxPenalty)² × dampStrength)`.

### FR-D6 (existing, retained): Score Integration Degradation
The degradation factor is applied **inside** `combineScore` (existing). The boost is applied **outside** `combineScore`, in `scoreChainEntry`.

## 5. Non-Functional Requirements

### NFR-1: Performance
- Boost read is O(1) from in-memory Map (same as penalty)
- No additional DB queries on the hot path
- DB write on PUT/DELETE only (not per-request)

### NFR-2: Backward Compatibility
- Models without a boost row behave identically to today (boost = 1.0)
- Existing routing strategy presets produce identical scores when boost = 1.0 and penalty = 0
- All existing degradation tests must pass without modification

### NFR-3: Observability
- `degradation.boost` events emitted on every change
- Boost values logged at `debug` level

### NFR-4: Correctness
- Boost must never be ≤ 0 (clamped to `boostMin`)
- Boost must never be NaN, Infinity, or undefined (validated on write)
- Concurrent boost updates to the same model must be serializable (single-process Node, in-memory update is sufficient)
