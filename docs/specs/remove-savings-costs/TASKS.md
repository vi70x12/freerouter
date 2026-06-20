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

- [ ] Remove import of `FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M` from `../db/model-pricing.js` (line 5)
- [ ] Remove `estimatedCostSavings` and `firstRequestAt` from the local `SummaryResponse` interface (lines 55-61)
- [ ] Remove `estimatedCostSavings: 0` and `firstRequestAt: null` from the `EMPTY_SUMMARY` constant (lines 63-69)
- [ ] Remove savings pricing methodology comment block (lines 82-86) that references `paid_input_per_m`/`paid_output_per_m` and `db/model-pricing.ts`
- [ ] Remove `MIN(r.created_at) as first_request_at` from SQL SELECT
- [ ] Remove `LEFT JOIN models m` from SQL FROM clause
- [ ] Remove the `est_savings` SUM expression from SQL SELECT
- [ ] Change `.get(FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since, ...pf.params)` → `.get(since, ...pf.params)`
- [ ] Remove `estimatedCostSavings` from JSON response (line 116)
- [ ] Remove `firstRequestAt` from JSON response (line 124) and its comment (line 123)

## Task 4: Rewrite Analytics `/by-model` Endpoint

**File:** `server/src/routes/analytics.ts`

- [ ] Remove `LEFT JOIN models m` from SQL FROM clause
- [ ] Remove `m.display_name` from SQL SELECT
- [ ] Remove the `est_cost` SUM expression from SQL SELECT
- [ ] Change `.all(FALLBACK..., FALLBACK..., since, ...pf.params)` → `.all(since, ...pf.params)`
- [ ] Change `displayName: r.display_name ?? r.model_id` → `displayName: r.model_id`
- [ ] Remove `estimatedCost` from JSON response mapping AND its inline comment (lines 170-172)

## Task 5: Update Shared Types

**File:** `shared/types.ts`

- [ ] Remove `estimatedCostSavings: number;` from `AnalyticsSummary` interface

## Task 6: Update Client AnalyticsPage

**File:** `client/src/pages/AnalyticsPage.tsx`

- [ ] Remove the 7-line savings card explanation comment block (lines 93-99) that describes the 30-day projection logic
- [ ] Remove `summary30` useQuery block (lines 100-103)
- [ ] Remove `actualSavings` variable (line 104)
- [ ] Remove `baseSavings` variable (line 105)
- [ ] Remove `spanDays` variable and its IIFE (lines 106-113)
- [ ] Remove `extrapolated` variable (line 114)
- [ ] Remove `savings30d` variable (line 115)
- [ ] Remove `rangeLabel` variable (line 116)
- [ ] Remove `spanLabel` variable (line 117)
- [ ] Remove `savingsHint` variable (lines 118-122)
- [ ] Remove the 4-line JSX comment inside the "Est. savings" `Stat` card (lines 163-166) that references `db/model-pricing.ts`
- [ ] Remove the "Est. savings" `Stat` card JSX (line 167)
- [ ] Change `lg:grid-cols-6` to `lg:grid-cols-5` on the stats grid (line 157)
- [ ] Remove "Saved" `TableHead` column from the per-model table (line 240)
- [ ] Remove the `estimatedCost` `TableCell` from the per-model row mapping (line 254)
- [ ] Add `pr-4` to the "Out tokens" `TableHead` (now the last column, line 239)

## Task 7: Update Server Tests

**File:** `server/src/__tests__/routes/analytics.test.ts`

> **IMPORTANT: DO NOT remove any test helper functions.** `insertTokensRequest`, `insertModel`, `insertKey`, and `insertErrorRequest` are all used by non-savings tests (active provider filtering, pinned vs auto tracking, rolling window tests). Removing any helper will break 10+ other test cases.

- [ ] Remove test case: "prices savings at the served model paid-equivalent rate" (lines 133-144)
- [ ] Remove test case: "falls back to modest default pricing for unmapped models" (lines 146-154)
- [ ] Remove test case: "excludes failed requests from savings" (lines 156-163)
- [ ] Remove test case: "returns per-model estimated cost in the by-model breakdown" (lines 165-172)

## Task 8: Verify

- [ ] Run: `npm run test -w server` — all tests pass
- [ ] Run: `npm run build` — client and server both compile
- [ ] Check for any remaining references to `estimatedCostSavings`, `estimatedCost`, `est_savings`, `est_cost`, `FALLBACK_INPUT`, `FALLBACK_OUTPUT`, `model-pricing`, `applyModelPricing`, `paid_input_per_m`, `paid_output_per_m`:
  ```bash
  grep -rn "estimatedCostSavings\|estimatedCost\|est_savings\|est_cost\|FALLBACK_INPUT\|FALLBACK_OUTPUT\|model-pricing\|applyModelPricing\|paid_input_per_m\|paid_output_per_m" --include="*.ts" --include="*.tsx" server/ client/ shared/ || echo "Clean!"
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
