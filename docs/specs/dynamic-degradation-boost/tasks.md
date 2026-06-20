# Dynamic Degradation + Boost Multiplier — Implementation Tasks

## Task 1: Extend Degradation Engine with Boost (`degradation.ts`)

### What to build
Add the `boost` field to `DegradationState`, implement `getBoost`/`setBoost`/`resetBoost`, and update all data lifecycle methods (create, flush, load, view).

### Exact changes

**In `DegradationState` interface:**
Add `boost: number` field. Default is `1.0` in `getOrCreateState`.

**In `initDegradation()`:**
Read two new env vars:
- `DEGRADE_BOOST_MIN` → `boostMin` (default: 0.1)
- `DEGRADE_BOOST_MAX` → `boostMax` (default: 100.0)
Both are parsed with `envFloat()`.

**Add exports:**
```typescript
export function getBoost(modelDbId: number): number;
export function setBoost(modelDbId: number, value: number): void;
export function resetBoost(modelDbId: number): void;
```

**`getBoost(modelDbId)`:**
- Look up state in `degradationStates` Map.
- Return `state.boost` if found, else `1.0`.

**`setBoost(modelDbId, value)`:**
- Clamp `value` to `[cfg.boostMin, cfg.boostMax]` using `Math.max`/`Math.min`.
- `getOrCreateState(modelDbId)` — this may create a state for a model with zero penalty.
- Store old boost, assign new, set `dirty = true`.
- Emit `degradation.boost` event with `oldBoost`, `newBoost`, `modelDbId`, `at`.

**`resetBoost(modelDbId)`:**
- Look up state. If no state, return (nothing to reset).
- Store old boost, set to `1.0`, set `dirty = true`.
- Emit `degradation.boost` event.
- If `state.penalty <= 0`, delete the state from the Map (clean up).

**Update `getAllStatesView()`:**
Include `boost` in the returned state object.

**Update `flushDirtyStates()`:**
Already returns full state copies — no change needed except DB schema (see Task 7).

**Update `getOrCreateState()`:**
Initialize `boost: 1.0`.

**Critical invariants:**
1. `getBoost` never returns undefined, NaN, or a value outside `[boostMin, boostMax]`.
2. `setBoost` on a model with no prior state creates the state (with penalty=0, boost=clamped).
3. `resetBoost` on a model with penalty=0 cleans up the state to prevent Map bloat.
4. Setting boost does NOT affect penalty, tier, or half-life.
5. Boost is NOT time-decayed — it is a static multiplier until explicitly changed.

---

## Task 2: Add Boost Tests to `degradation.test.ts`

### Test structure
Use the existing `beforeEach`/`afterEach` with `vi.useFakeTimers()`. The `publish` mock is already in place.

### Test cases (minimum set)

**Group: `getBoost`**
- Returns `1.0` for a modelDbId with no state.
- Returns the stored boost value after `setBoost`.

**Group: `setBoost`**
- Sets boost within bounds, sets `dirty = true`.
- Clamps below `boostMin` to `boostMin`.
- Clamps above `boostMax` to `boostMax`.
- Creates a new state for a model with no prior penalty.
- Emits `degradation.boost` event with `oldBoost` and `newBoost`.

**Group: `resetBoost`**
- Resets boost to `1.0`, sets `dirty = true`.
- Emits `degradation.boost` event.
- Deletes the state from the Map if `penalty === 0`.
- Does nothing if no state exists.

**Group: `boost + penalty interaction`**
- `setBoost` on a model with penalty > 0: boost is set, penalty unchanged.
- `resetBoost` on a model with penalty > 0: boost reset to 1.0, state kept (penalty > 0).

**Group: `getAllStatesView`**
- Returns `boost` field in the view.

---

## Task 3: Integrate Boost into `router.ts`

### Changes
In `scoreChainEntry`, after computing `degradationFactor`, read `boost` and multiply:

```typescript
// server/src/services/router.ts
import { getDegradationFactor, getBoost } from './degradation.js';

// In scoreChainEntry:
const degradationFactor = getDegradationFactor(entry.model_db_id);
const boost = getBoost(entry.model_db_id);

const baseScore = combineScore({ reliability, speed, intelligence, degradationFactor }, weights);
const score = baseScore * boost;
```

### What NOT to change
- Do NOT modify `combineScore` or `scoring.ts` — boost is applied outside.
- Do NOT change `orderChain` or any other router logic.

---

## Task 4: Update Router Tests

If there are router unit tests that assert exact score values, they will need a `× 1.0` factor (no change to the numeric result, just the expression). If tests mock `getDegradationFactor` but not `getBoost`, add:

```typescript
vi.mock('../../services/degradation.js', () => ({
  // ... existing mocks
  getBoost: vi.fn(() => 1.0),
}));
```

Or better: add a test specific to boost:
- Mock `getDegradationFactor` to return 0.5 and `getBoost` to return 2.0.
- Assert that `scoreChainEntry` returns a score that reflects `base × 0.5 × 2.0`.

---

## Task 5: Add Boost API to `fallback.ts`

### Endpoints to add

**`GET /api/fallback/boost`**
Returns all models with a non-default boost (or all models in the degradation table if simpler).
```typescript
fallbackRouter.get('/boost', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT model_db_id, boost FROM model_degradation WHERE boost != 1.0').all();
  res.json(rows.map(r => ({ modelDbId: r.model_db_id, boost: r.boost })));
});
```

**`PUT /api/fallback/boost/:modelDbId`**
Body: `{ "boost": number }`
- Parse and validate `boost` is a number.
- Clamp to `[DEGRADE_BOOST_MIN, DEGRADE_BOOST_MAX]`.
- Call `setBoost(modelDbId, clamped)`.
- Persist to DB via upsert (or rely on periodic flush if you prefer; for API responsiveness, do an immediateService-worker write directly).
- Respond with `{ modelDbId, boost: clamped }`.

**`DELETE /api/fallback/boost/:modelDbId`**
- Call `resetBoost(modelDbId)`.
- Update DB row: `UPDATE model_degradation SET boost = 1.0 WHERE model_db_id = ?`.
- If `penalty == 0` after this, consider `DELETE FROM model_degradation WHERE model_db_id = ?`.
- Respond with `{ modelDbId, boost: 1.0 }`.

### Update existing `GET /degradation`
Add `boost` to each item in the response array.

---

## Task 6: Update Database Migration

In `server/src/migrations.ts`, add the `boost` column:

```typescript
// Add to the migration that creates model_degradation, or as a separate migration:
function addBoostColumn(db) {
  const hasBoost = db.prepare(`
    SELECT COUNT(*) AS count FROM pragma_table_info('model_degradation') WHERE name = 'boost'
  `).get().count > 0;
  
  if (!hasBoost) {
    db.prepare(`ALTER TABLE model_degradation ADD COLUMN boost REAL NOT NULL DEFAULT 1.0`).run();
    console.log('[Migration] Added boost column to model_degradation');
  }
}
```

If `model_degradation` does NOT exist yet (dynamic-degradation hasn't landed), create the full table (see design.md §2.2).

---

## Task 7: Update Persistence (Periodic Flush + Startup Load)

### Periodic flush (unchanged logic, updated SQL)
The `upsert` prepared statement in the 60-second flush interval must include `boost`.

### Startup load (with decay + boost)
In the startup hydration loop (from dynamic-degradation Task 7), load `boost` from each row:
```typescript
loadState(row.model_db_id, {
  // ... other fields
  boost: row.boost ?? 1.0,
});
```

**Important**: The hydration condition `decayedPenalty >= 0.01` should be relaxed to `decayedPenalty >= 0.01 || (row.boost !== 1.0)` so that models with a non-default boost are loaded even if their penalty has fully decayed.

---

## Task 8: Update `events.ts`

Add `degradation.boost` to the `LiveEvent` union type:

```typescript
export type LiveEvent =
  | { type: 'degradation.hit'; modelDbId: number; tier: string; penalty: number; consecutive: number; consecutiveMajor: number; at: number }
  | { type: 'degradation.recovery'; modelDbId: number; penalty: number; at: number }
  | { type: 'degradation.boost'; modelDbId: number; oldBoost: number; newBoost: number; at: number }
  // ... existing events
```

---

## Task 9: Dashboard UI — Boostedness Panel

### Client-side changes (conceptual — actual UI files are in `client/`)

The degradation panel should be extended with:

**Boost Slider Component:**
- Range: `0.1` to `100` (logarithmic scale for UX)
- Default position: `1.0` (center)
- Visual: "Demote" (left) and "Promote" (right) labels
- Value display: `×1.0`, `×10`, `×0.5`

**API calls:**
- On slider change (debounced 300ms): `PUT /api/fallback/boost/:modelDbId` with `{ boost }`
- Reset button: `DELETE /api/fallback/boost/:modelDbId`

**Visual integration:**
- Show boost multiplier next to the degradation tier badge.
- If `boost !== 1.0`, highlight the row in a distinct color (e.g., amber for promoted, blue for demoted).

---

## Task 10: Cleanup and Final Integration

### Checklist
- [ ] `degradation.ts` compiles and all existing tests pass
- [ ] New boost tests pass
- `npm run test` (server tests) passes
- [ ] `router.ts` changes compile
- [ ] `fallback.ts` new endpoints respond correctly
- [ ] Manual curl test:
  ```bash
  curl -X PUT http://localhost:3000/api/fallback/boost/1 -H "Content-Type: application/json" -d '{"boost": 50}'
  curl http://localhost:3000/api/fallback/degradation | jq '.[0].boost'
  curl -X DELETE http://localhost:3000/api/fallback/boost/1
  ```
- [ ] Restart server → boost value is restored from DB

---

## Dependency Graph

```
Task 1 (degradation.ts core)
  │
  ├─→ Task 2 (tests for degradation)
  │
  ├─→ Task 3 (router.ts integration)
  │     │
  │     └─→ Task 4 (router tests)
  │
  ├─→ Task 5 (fallback.ts API)
  │     │
  │     └─→ Task 9 (dashboard UI)
  │
  ├─→ Task 6 (migration)
  │     │
  │     └─→ Task 7 (persistence)
  │
  └─→ Task 8 (events.ts)

Task 10 (cleanup) depends on ALL above.
```

**Parallelizable groups:**
- Group A: Tasks 1, 2 (pure logic + tests)
- Group B: Tasks 3, 4 (router + router tests) — depends on 1
- Group C: Tasks 5, 6, 7, 8 (API + migration + persistence + events) — depends on 1
- Group D: Task 9 (UI) — depends on 5
- Group E: Task 10 (final verification) — depends on all
