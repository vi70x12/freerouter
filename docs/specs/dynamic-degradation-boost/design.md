# Dynamic Degradation + Boost Multiplier — Design

## 1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                        Router                                 │
│  ┌───────────────────────────────────────────────────────┐  │
│ scoreChainEntry: score = base × degradationFactor × getBoost(modelDbId) │
│  │  └─ getDegradationFactor(modelDbId) ──┘               │  │
│  │                                      │                 │  │
│  │  ┌───────────────────────────────────┴─────────────┐   │  │
│  │  │            Degradation Engine                  │   │  │
│  │  │  ┌─────────┐ ┌─────────┐ ┌─────────┐ ┌──────┐  │   │  │
│  │  │  │ Penalty │ │  Tier   │ │ HalfLife│ │ Boost│  │   │  │
│  │  │  │  Map    │ │  State  │ │ Ratchet │ │ (new)│  │   │  │
│  │  │  └─────────┘ └─────────┘ └─────────┘ └──────┘  │   │  │
│  │  └──────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────┘  │
│                           │                                  │
│                    ┌──────┴──────┐                          │
│                    │  model_degradation                       │
│                    │  (SQL: penalty + boost)                  │
│                    └─────────────┘                          │
└─────────────────────────────────────────────────────────────┘
```

The boost is a **separate, orthogonal axis** from degradation. It does not affect penalty calculation, decay, or tier classification. It only affects the final routing score.

## 2. Core Data Model

### 2.1 `DegradationState` (augmented)

Existing `DegradationState` in `degradation.ts` gains a `boost` field:

```typescript
export interface DegradationState {
  /** Accumulated penalty (0 = healthy, MAX_PENALTY = dead). */
  penalty: number;
  /** Severity tier that drove the most recent half-life (for half-life ratchet). */
  tier: 'minor' | 'major' | 'critical';
  /** Consecutive failure count (all tiers) since last success. Reset on success. */
  consecutiveHits: number;
  /** Consecutive MAJOR failure count since last success or minor failure. */
  consecutiveMajorHits: number;
  /** Timestamp (ms) of the most recent failure. */
  lastHitAt: number;
  /** Half-life (ms) currently in effect. Ratchets up, resets to minor only at penalty=0. */
  halfLifeMs: number;
  /** Dirty flag — true if state changed since last DB flush. */
  dirty: boolean;
  /** NEW: Boost multiplier (default 1.0). Applied AFTER degradation. */
  boost: number;
}
```

### 2.2 Database Table

Extend the existing `model_degradation` table (from dynamic-degradation Task 7) to include a `boost` column:

```sql
CREATE TABLE IF NOT EXISTS model_degradation (
  model_db_id INTEGER PRIMARY KEY,
  penalty REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'minor',
  consecutive_hits INTEGER NOT NULL DEFAULT 0,
  consecutive_major_hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL DEFAULT 0,
  half_life_ms INTEGER NOT NULL DEFAULT 120000,
  dirty INTEGER NOT NULL DEFAULT 0,
  boost REAL NOT NULL DEFAULT 1.0,  -- NEW
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

**Migration strategy**: If the table already exists (from dynamic-degradation implementation), add the column via `ALTER TABLE`. If creating fresh, include it.

### 2.3 Configuration (augmented)

```typescript
interface DegradationConfig {
  minor: DegradationTierConfig;
  major: DegradationTierConfig;
  critical: DegradationTierConfig & { consecutiveThreshold: number };
  compoundFactor: number;
  successRecovery: number;
  dampStrength: number;
  maxPenalty: number;
  boostMin: number;   // NEW
  boostMax: number;    // NEW
}
```

## 3. Algorithm Details

### 3.1 `getBoost(modelDbId): number`

```typescript
export function getBoost(modelDbId: number): number {
  const state = degradationStates.get(modelDbId);
  if (!state) return 1.0; // Default when no state exists
  return state.boost;
}
```

### 3.2 `setBoost(modelDbId, value): void`

```typescript
export function setBoost(modelDbId: number, value: number): void {
  const cfg = getConfig();
  // Clamp to bounds
  const clamped = Math.max(cfg.boostMin, Math.min(cfg.boostMax, value));
  
  const state = getOrCreateState(modelDbId);
  const oldBoost = state.boost;
  state.boost = clamped;
  state.dirty = true;

  publish({
    type: 'degradation.boost',
    modelDbId,
    oldBoost,
    newBoost: clamped,
    at: Date.now(),
  } as any);
}
```

### 3.3 `resetBoost(modelDbId): void`

```typescript
export function resetBoost(modelDbId: number): void {
  const state = degradationStates.get(modelDbId);
  if (!state) return;
  
  const oldBoost = state.boost;
  state.boost = 1.0;
  state.dirty = true;

  publish({
    type: 'degradation.boost',
    modelDbId,
    oldBoost,
    newBoost: 1.0,
    at: Date.now(),
  } as any);
  
  // If penalty is also 0, we can clean up the entry entirely
  if (state.penalty <= 0) {
    degradationStates.delete(modelDbId);
  }
}
```

### 3.4 Changes to `scoreChainEntry` (router.ts)

The final score calculation in `scoreChainEntry` becomes:

```typescript
const degradationFactor = getDegradationFactor(entry.model_db_id);
const boost = getBoost(entry.model_db_id);

const score = combineScore({ reliability, speed, intelligence, degradationFactor }, weights) * boost;
```

**This is the ONLY place boost is applied.** No changes to `combineScore` itself.

## 4. Integration Points

### 4.1 Changes to `degradation.ts`

Add to `DegradationState`:
- `boost: number` (default 1.0 in `getOrCreateState`)

Add exports:
- `getBoost(modelDbId: number): number`
- `setBoost(modelDbId: number, value: number): void`
- `resetBoost(modelDbId: number): void`

Update `getAllStatesView()` to include `boost` in the returned state.
Update `flushDirtyStates()` to include `boost` in the DB upsert.

### 4.2 Changes to `router.ts`

Import `getBoost` from `degradation.js`.
In `scoreChainEntry`, after computing `degradationFactor`, read `boost` and multiply the final score.

### 4.3 Changes to `fallback.ts` (Dashboard API)

Add endpoints:
- `GET /api/fallback/boost` — returns `{ modelDbId, boost }[]` for all models with non-default boost
- `PUT /api/fallback/boost/:modelDbId` — body `{ boost: number }`, validates, calls `setBoost`, persists to DB
- `DELETE /api/fallback/boost/:modelDbId` — calls `resetBoost`, deletes row or sets boost=1.0 in DB

Update `GET /api/fallback/degradation` to include `boost` in the response.

### 4.4 Database Migration

```sql
-- Add boost column if table exists
ALTER TABLE model_degradation ADD COLUMN boost REAL NOT NULL DEFAULT 1.0;
```

Or if creating the table fresh (from dynamic-degradation spec):
```sql
CREATE TABLE IF NOT EXISTS model_degradation (
  model_db_id INTEGER PRIMARY KEY,
  penalty REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'minor',
  consecutive_hits INTEGER NOT NULL DEFAULT 0,
  consecutive_major_hits INTEGER NOT NULL DEFAULT 0,
  last_hit_at INTEGER NOT NULL DEFAULT 0,
  half_life_ms INTEGER NOT NULL DEFAULT 120000,
  dirty INTEGER NOT NULL DEFAULT 0,
  boost REAL NOT NULL DEFAULT 1.0,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 4.5 Persistence Strategy (updated)

**Periodic flush** (every 60s):
```typescript
const upsert = db.prepare(`
  INSERT INTO model_degradation (model_db_id, penalty, tier, consecutive_hits,
    consecutive_major_hits, last_hit_at, half_life_ms, dirty, boost)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(model_db_id) DO UPDATE SET
    penalty = excluded.penalty,
    tier = excluded.tier,
    consecutive_hits = excluded.consecutive_hits,
    consecutive_major_hits = excluded.consecutive_major_hits,
    last_hit_at = excluded.last_hit_at,
    half_life_ms = excluded.half_life_ms,
    dirty = 0,
    boost = excluded.boost
`);
```

**Startup load** (with decay during hydration):
```typescript
const now = Date.now();
for (const row of rows) {
  const elapsed = now - row.last_hit_at;
  const decayedPenalty = applyDecay(row.penalty, elapsed, row.half_life_ms);
  
  if (decayedPenalty >= 0.01 || row.boost !== 1.0) {
    loadState(row.model_db_id, {
      penalty: decayedPenalty,
      tier: row.tier,
      consecutiveHits: row.consecutive_hits,
      consecutiveMajorHits: row.consecutive_major_hits,
      lastHitAt: now,
      halfLifeMs: row.half_life_ms,
      dirty: false,
      boost: row.boost ?? 1.0,  // Load persisted boost
    });
  }
}
```

## 5. Testing Strategy

### Unit Tests for Boost (`degradation.test.ts`)

Add test groups:
- `getBoost`: returns 1.0 for unknown model, returns stored value for known model
- `setBoost`: clamps to bounds, sets dirty flag, emits event
- `setBoost` with penalty=0: creates state if not exists
- `resetBoost`: resets to 1.0, emits event, deletes state if penalty also 0
- `scoreChainEntry`: final score = combineScore × boost
- Boost + degradation interaction: high boost + high penalty = moderate score

### Integration Tests
- `PUT /api/fallback/boost/:id` persists and is reflected in `GET /degradation`
- `DELETE /api/fallback/boost/:id` resets to 1.0
- Startup hydration loads persisted boost values

## 6. Dashboard UI (conceptual)

The degradation panel in the dashboard should show:
- Penalty bar (0–100)
- Display tier (healthy/minor/major/critical)
- **Boost slider** (logarithmic scale: 0.1 to 100, default position at 1.0)
- Reset button (resets boost to 1.0)

Slider behavior:
- Center position = 1.0
- Left drag = demote (0.1 to <1.0)
- Right drag = promote (>1.0 to 100)

## 7. Files Changed

| File | Change |
|------|--------|
| `server/src/services/degradation.ts` | Add `boost` to state, add `getBoost`/`setBoost`/`resetBoost`, update flush/load |
| `server/src/services/router.ts` | Multiply score by boost in `scoreChainEntry` |
| `server/src/services/events.ts` | Add `degradation.boost` to `LiveEvent` union |
| `server/src/routes/fallback.ts` | Add boost endpoints, include boost in degradation GET |
| `server/src/__tests__/services/degradation.test.ts` | Add boost test groups |
| `server/src/__tests__/routes/fallback.test.ts` (or similar) | Add boost API tests |
| `server/src/migrations.ts` | Add `boost` column to `model_degradation` |
