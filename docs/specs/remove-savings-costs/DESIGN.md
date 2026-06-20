# Design: Remove Cost/Savings Calculator

## Overview

This design document describes the surgical removal of cost/savings calculation from the FreeLLMApi stack. The change spans 6 files across server, client, shared types, and tests. No new code is introduced — only deletion and minimal rewrites.

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `server/src/db/model-pricing.ts` | **DELETE** | Entire module — pricing data and migration function |
| `server/src/db/migrations.ts` | **EDIT** | Remove `applyModelPricing` import and call |
| `server/src/routes/analytics.ts` | **EDIT** | Remove savings/cost from `/summary` and `/by-model` endpoints |
| `shared/types.ts` | **EDIT** | Remove `estimatedCostSavings` from `AnalyticsSummary` interface |
| `client/src/pages/AnalyticsPage.tsx` | **EDIT** | Remove savings card, savings variables, and "Saved" table column |
| `server/src/__tests__/routes/analytics.test.ts` | **EDIT** | Remove savings-related test helper and test cases |

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
- Map `displayName: r.model_id` (no `display_name` available)
- Remove `estimatedCost` field

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

#### Remove Savings Query

Remove:
```typescript
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

#### Update Stats Grid

Change grid columns:
```jsx
// FROM:
<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
// TO:
<div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
```

Remove the "Est. savings" Stat card:
```jsx
{/* REMOVE THIS ENTIRE STAT CARD:
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

**Action:** Remove the following helpers and test cases:

1. `insertTokensRequest` helper (if it exists)
2. Test case: "prices savings at the served model paid-equivalent rate"
3. Test case: "falls back to modest default pricing for unmapped models"
4. Test case: "excludes failed requests from savings"
5. Test case: "returns per-model estimated cost in the by-model breakdown"

## Dependencies

None. This is a pure removal — no new packages needed.

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|-----------|
| Breaks existing analytics tests | Low | Remove only savings-specific test cases; leave all others intact |
| Client type error from missing field | Low | Remove `estimatedCostSavings` from shared types, remove client usages |
| Dead code left behind | Low | Remove all variables, imports, and SQL expressions that are no longer used |
| Models table accidentally affected | Very Low | Do not drop the table; only remove `applyModelPricing` call |

## Rollback Plan

If needed, revert the single commit on `feat/remove-savings-costs`. The `model-pricing.ts` file and all changes are isolated to this branch.
