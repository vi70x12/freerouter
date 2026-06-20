# Tasks: Remove Cost/Savings Calculator

## Before You Start

1. **Do NOT touch `~/freellmapi`** — it is STAGING/PROD.
2. **Work in your own directory** — e.g. `~/freellmapi-remove-savings` or similar.
3. **Ensure you are on `feat/remove-savings-costs`** branch, based on `main`.
4. The LLM endpoint `localhost:3001` is DOWN — **do NOT use `spawn_agent`**. Apply all changes directly.

## Task 1: Delete Model Pricing Module

**File:** `server/src/db/model-pricing.ts`

- [ ] Delete the entire file `server/src/db/model-pricing.ts`.

## Task 2: Remove Migration Call

**File:** `server/src/db/migrations.ts`

- [ ] Remove: `import { applyModelPricing } from './model-pricing.js';`
- [ ] Remove: `applyModelPricing(db);` call

## Task 3: Rewrite Analytics `/summary` Endpoint

**File:** `server/src/routes/analytics.ts`

- [ ] Remove import of `FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M` from `../db/model-pricing.js`
- [ ] Remove savings comment block (lines 33-37)
- [ ] Remove `MIN(r.created_at) as first_request_at` from SQL SELECT
- [ ] Remove `LEFT JOIN models m` from SQL FROM clause
- [ ] Remove the `est_savings` SUM expression from SQL SELECT
- [ ] Change `.get(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since)` → `.get(since)`
- [ ] Remove `estimatedCostSavings` from JSON response
- [ ] Remove `firstRequestAt` from JSON response
- [ ] Remove comment on `firstRequestAt`

## Task 4: Rewrite Analytics `/by-model` Endpoint

**File:** `server/src/routes/analytics.ts`

- [ ] Remove `LEFT JOIN models m` from SQL FROM clause
- [ ] Remove `m.display_name` from SQL SELECT
- [ ] Remove the `est_cost` SUM expression from SQL SELECT
- [ ] Change `.all(FALLBACK..., FALLBACK..., since)` → `.all(since)`
- [ ] Change `displayName: r.display_name ?? r.model_id` → `displayName: r.model_id`
- [ ] Remove `estimatedCost` from JSON response mapping

## Task 5: Update Shared Types

**File:** `shared/types.ts`

- [ ] Remove `estimatedCostSavings: number;` from `AnalyticsSummary` interface

## Task 6: Update Client AnalyticsPage

**File:** `client/src/pages/AnalyticsPage.tsx`

- [ ] Remove `summary30` useQuery block (lines ~100-103)
- [ ] Remove `actualSavings` variable
- [ ] Remove `baseSavings` variable
- [ ] Remove `spanDays` variable and its IIFE
- [ ] Remove `extrapolated` variable
- [ ] Remove `savings30d` variable
- [ ] Remove `rangeLabel` variable
- [ ] Remove `spanLabel` variable
- [ ] Remove `savingsHint` variable
- [ ] Remove the "Est. savings" `Stat` card JSX (lines ~163-167)
- [ ] Change `lg:grid-cols-6` to `lg:grid-cols-5` on the stats grid
- [ ] Remove "Saved" `TableHead` column from the per-model table
- [ ] Remove the `estimatedCost` `TableCell` from the per-model row mapping
- [ ] Add `pr-4` to the "Out tokens" `TableHead` (now the last column)

## Task 7: Update Server Tests

**File:** `server/src/__tests__/routes/analytics.test.ts`

- [ ] Remove `insertTokensRequest` helper function (if it exists only for savings tests)
- [ ] Remove test case: "prices savings at the served model paid-equivalent rate"
- [ ] Remove test case: "falls back to modest default pricing for unmapped models"
- [ ] Remove test case: "excludes failed requests from savings"
- [ ] Remove test case: "returns per-model estimated cost in the by-model breakdown"

## Task 8: Verify

- [ ] Run: `npm run test -w server` — all tests pass
- [ ] Run: `npm run build` — client and server both compile
- [ ] Check for any remaining references to `estimatedCostSavings`, `estimatedCost`, `est_savings`, `est_cost`, `FALLBACK_INPUT`, `FALLBACK_OUTPUT`, `model-pricing`, `applyModelPricing`:
  ```bash
  grep -r "estimatedCostSavings\|est_savings\|est_cost\|FALLBACK_INPUT\|FALLBACK_OUTPUT\|model-pricing\|applyModelPricing" --include="*.ts" --include="*.tsx" server/ client/ shared/ || echo "Clean!"
  ```

## Task 9: Commit

- [ ] Stage all changes: `git add .`
- [ ] Commit: `git commit -m "feat: remove cost/savings calculator"`
- [ ] Push: `git push origin feat/remove-savings-costs`
- [ ] Open PR to `main`

## Checklist for Agent Handoff

- [ ] All 6 files have been modified/deleted as specified
- [ ] `npm run test -w server` passes
- [ ] `npm run build` passes
- [ ] No orphaned references to removed cost/savings code remain
- [ ] The `models` table is still used for routing (not dropped)
- [ ] Commit is on `feat/remove-savings-costs` branch
