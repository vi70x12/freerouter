# Design: Remove Cost/Savings Calculator

## Overview

This design document describes the surgical removal of cost/savings calculation from the FreeLLMApi stack. The change spans 6 files across server, client, shared types, and tests. No new code is introduced — only deletion and minimal rewrites.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `server/src/db/model-pricing.ts` | **DELETE** | Entire module — pricing data and migration function |
| `server/src/db/migrations.ts` | **EDIT** | Remove `applyModelPricing` import and call |
| `server/src/routes/analytics.ts` | **EDIT** | Remove savings/cost from `/summary` and `/by-model` endpoints; clean up `SummaryResponse` interface, `EMPTY_SUMMARY` constant, dead comments |
| `shared/types.ts` | **EDIT** | Remove `estimatedCostSavings` from `AnalyticsSummary` interface |
| `client/src/pages/AnalyticsPage.tsx` | **EDIT** | Remove savings card, savings variables, and "Saved" table column |
| `server/src/__tests__/routes/analytics.test.ts` | **EDIT** | Remove 4 savings test cases; **keep all test helpers** |

## Detailed Design

### 1. Server — `server/src/db/model-pricing.ts`

**Action:** Delete the entire file.

This file contains:
- `MODEL_PRICING` array with per-model paid-API rates
- `FALLBACK_INPUT_PER_M` / `FALLBACK_OUTPUT_PER_M` constants
- `applyModelPricing(db)` function that adds columns and updates prices

After deletion, the `models` table still exists but will not have `paid_input_per_m`/`paid_output_per_m` populated on new installs. Existing DBs with these columns are harmless — they are simply not accessed.

### 2. Server — `server/src/db/migrations.ts`

**Action:** Remove the import and invocation of `applyModelPricing`.

```typescript
// REMOVE:
import { applyModelPricing } from './model-pricing.js';

// REMOVE:
applyModelPricing(db);
```

No other changes needed. Existing `models` rows remain intact.

### 3. Server — `server/src/routes/analytics.ts`

#### Dead Import

```typescript
// REMOVE (line 5):
import { FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M } from '../db/model-pricing.js';
```

#### `SummaryResponse` Interface and `EMPTY_SUMMARY` Constant (lines 55-69)

Remove `estimatedCostSavings` and `firstRequestAt` from both:

```typescript
interface SummaryResponse {
  totalRequests: number; successRate: number;
  totalInputTokens: number; totalOutputTokens: number;
  avgLatencyMs: number;
  // REMOVE: estimatedCostSavings: number;
  pinnedRequests: number; pinHonoredRequests: number;
  // REMOVE: firstRequestAt: string | null;
}

const EMPTY_SUMMARY: SummaryResponse = {
  totalRequests: 0, successRate: 0,
  totalInputTokens: 0, totalOutputTokens: 0,
  avgLatencyMs: 0,
  // REMOVE: estimatedCostSavings: 0,
  pinnedRequests: 0, pinHonoredRequests: 0,
  // REMOVE: firstRequestAt: null,
};
```

#### Dead Comment Block (lines 82-86)

Remove the 5-line savings pricing methodology comment:
```
// REMOVE: savings are priced per request at the served model's paid-equivalent
// rate (models.paid_input_per_m / paid_output_per_m — see db/model-pricing.ts),
// with a modest fallback for custom/unmapped models, and only count
// successful requests. This is "what the same tokens would have cost on
// paid APIs", not a GPT-4o fantasy number.
```

#### `/summary` Endpoint

**Current SQL (simplified):**
```sql
SELECT
  COUNT(*) as total_requests,
  SUM(...) as success_count,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  AVG(r.latency_ms) as avg_latency_ms,
  MIN(r.created_at) as first_request_at,
  SUM(...) as pinned_count,
  SUM(...) as pin_honored_count,
  SUM(CASE WHEN r.status = 'success' THEN
    r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
    r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
  ELSE 0 END) as est_savings
FROM requests r
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
WHERE r.created_at >= ?
```

**New SQL:**
```sql
SELECT
  COUNT(*) as total_requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) as success_count,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(CASE WHEN r.requested_model IS NOT NULL THEN 1 ELSE 0 END) as pinned_count,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pin_honored_count
FROM requests r
WHERE r.created_at >= ?
```

**Changes:**
- Remove `MIN(r.created_at) as first_request_at`
- Remove `est_savings` expression
- Remove `LEFT JOIN models`
- Change `.get(FALLBACK..., FALLBACK..., since)` → `.get(since)`

**Response changes:**
- Remove `estimatedCostSavings` field
- Remove `firstRequestAt` field
- Remove comment on `firstRequestAt` (line 124)

#### `/by-model` Endpoint

**Current SQL (simplified):**
```sql
SELECT
  r.platform,
  r.model_id,
  m.display_name,
  COUNT(*) as requests,
  ...
  SUM(CASE WHEN r.status = 'success' THEN
    r.input_tokens  * COALESCE(m.paid_input_per_m,  ?) / 1000000.0 +
    r.output_tokens * COALESCE(m.paid_output_per_m, ?) / 1000000.0
  ELSE 0 END) as est_cost
FROM requests r
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
WHERE r.created_at >= ?
GROUP BY r.platform, r.model_id
```

**New SQL:**
```sql
SELECT
  r.platform,
  r.model_id,
  COUNT(*) as requests,
  SUM(CASE WHEN r.status = 'success' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as success_rate,
  AVG(r.latency_ms) as avg_latency_ms,
  SUM(r.input_tokens) as total_input_tokens,
  SUM(r.output_tokens) as total_output_tokens,
  SUM(CASE WHEN r.requested_model = r.model_id THEN 1 ELSE 0 END) as pinned_requests
FROM requests r
WHERE r.created_at >= ?
GROUP BY r.platform, r.model_id
ORDER BY requests DESC
```

**Changes:**
- Remove `m.display_name` from SELECT
- Remove `est_cost` expression
- Remove `LEFT JOIN models`
- Change `.all(FALLBACK..., FALLBACK..., since)` → `.all(since)`

**Response changes:**
- Map `displayName: r.model_id` (no `display_name` available after JOIN removal)
- Remove `estimatedCost` field and its inline comment (lines 170-172)

> **Behavioral change:** The per-model breakdown table will now show raw model IDs (e.g. `llama-3.3-70b-versatile`) instead of human-friendly display names. This is an accepted UX tradeoff — the `LEFT JOIN models` existed solely for pricing and `display_name`; restoring display names would require a JOIN that no longer serves a purpose.

### 4. Shared — `shared/types.ts`

**Change:**
```typescript
export interface AnalyticsSummary {
  totalRequests: number;
  successRate: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  avgLatencyMs: number;
  // REMOVE: estimatedCostSavings: number;
}
```

### 5. Client — `client/src/pages/AnalyticsPage.tsx`

#### Remove Savings Comment Block and Query (lines 93-103)

Remove the 7-line comment block describing the savings projection logic AND the `summary30` query it precedes:
```typescript
// REMOVE (lines 93-99): savings card explanation comment
// Savings card shows ONE stable monthly figure...
// ...Querying 30d separately is free: react-query shares the cache
// with the 30d tab.

// REMOVE (lines 100-103):
const { data: summary30 } = useQuery({
  queryKey: ['analytics', 'summary', '30d'],
  queryFn: () => apiFetch<any>(`/api/analytics/summary?range=30d`),
})
```

#### Remove Savings Variables

Remove all these lines:
```typescript
const actualSavings = summary?.estimatedCostSavings ?? 0
const baseSavings = summary30?.estimatedCostSavings ?? 0
const spanDays = ...
const extrapolated = spanDays < 29.5
const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
const rangeLabel = ...
const spanLabel = ...
const savingsHint = ...
```

#### Update Stats Grid (line 157)

Change grid columns:
```jsx
// FROM:
<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
// TO:
<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
```

Remove the "Est. savings" Stat card AND its 4-line JSX comment (lines 163-167):
```jsx
{/* REMOVE THESE 5 LINES:
  {/* Priced per request at the served model's paid-API equivalent
      rate (not a flat frontier-model rate) — see db/model-pricing.ts.
      The value is a 30-day projection; the hover hint tells the whole
      story (actual period amount + whether it was extrapolated). * /}
  <Stat label="Est. savings" value={`$${savings30d.toFixed(2)}`} hint={savingsHint} />
*/}
```

#### Update Per-Model Table

Remove the "Saved" column header:
```jsx
{/* REMOVE: <TableHead className="text-right pr-4">Saved</TableHead> */}
```

Remove the "Saved" cell from the row mapping:
```jsx
{/* REMOVE:
<TableCell className="text-right tabular-nums pr-4">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
*/}
```

Add `pr-4` to the "Out tokens" header since it's now the last column:
```jsx
<TableHead className="text-right pr-4">Out tokens</TableHead>
```

### 6. Tests — `server/src/__tests__/routes/analytics.test.ts`

**Action:** Remove the 4 savings-specific test cases below. **Do NOT remove any test helpers**.

> **Important:** `insertTokensRequest` is used by 10+ test cases in the `active provider filtering` describe block (lines 221-313) and must remain intact. `insertModel`, `insertKey`, and `insertErrorRequest` are also used by non-savings tests and must stay.

Test cases to remove (lines 133-172):
1. "prices savings at the served model paid-equivalent rate"
2. "falls back to modest default pricing for unmapped models"
3. "excludes failed requests from savings"
4. "returns per-model estimated cost in the by-model breakdown"

## Dependencies

None. This is a pure removal — no new packages needed.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Breaks existing analytics tests | Low | Remove only the 4 savings-specific test cases; keep `insertTokensRequest` and all other helpers |
| Client type error from missing field | Low | Remove `estimatedCostSavings` from both `shared/types.ts` AND local `SummaryResponse` in `analytics.ts` |
| Dead code left behind | Low | Remove dead imports, dead comment blocks, and the `EMPTY_SUMMARY` savings fields |
| Models table accidentally affected | Very Low | Do not drop the table; only remove `applyModelPricing` call |
| UX regression: raw model IDs shown | Certain | Accepted tradeoff — `display_name` was only accessible via the pricing JOIN being removed. A future PR could add a lightweight display-name lookup if needed. |

## Rollback Plan

If needed, revert the single commit on `feat/remove-savings-costs`. The `model-pricing.ts` file and all changes are isolated to this branch.
