# Requirements: Remove Cost/Savings Calculator

## Context

FreeLLMApi is a free-tier LLM proxy — all models are accessed via free API keys. The analytics dashboard currently shows an misleading "Est. savings" figure that calculates "what the same tokens would have cost on paid APIs." Since the project is fundamentally a free-tier aggregator and users are not paying anything, this metric is nonsensical and misleading.

## Goal

Strip out every trace of cost/savings calculation logic across the entire stack: server API, shared types, client UI, database migrations, and tests.

## Functional Requirements

### REQ-1: Remove Savings from Analytics Summary
- The `/api/analytics/summary` endpoint must no longer compute, query, or return any estimated savings data.
- Remove the SQL expression that calculates `est_savings` from the summary query.
- Remove the `LEFT JOIN models` from the summary query (it only existed for pricing columns).
- Remove `MIN(r.created_at) as first_request_at` from the summary query.
- Remove `estimatedCostSavings` from the JSON response.
- Remove `firstRequestAt` from the JSON response.

### REQ-2: Remove Cost from Per-Model Breakdown
- The `/api/analytics/by-model` endpoint must no longer compute, query, or return per-model estimated cost.
- Remove the SQL expression that calculates `est_cost` from the by-model query.
- Remove the `LEFT JOIN models` from the by-model query.
- Remove `m.display_name` from the SELECT; use `r.model_id` directly or map `displayName: r.model_id`.
- Remove `estimatedCost` from the per-model JSON response.

### REQ-3: Delete Model Pricing Module
- Delete `server/src/db/model-pricing.ts` entirely.
- Remove the `applyModelPricing` call from `server/src/db/migrations.ts`.
- Remove the import of `applyModelPricing` from migrations.
- The `models` table itself **must not** be deleted — it is still used for routing.
- The new columns `paid_input_per_m` and `paid_output_per_m` (if they exist in existing DBs) are harmless orphans — do not add a migration to drop them.

### REQ-4: Update Shared Types
- Remove `estimatedCostSavings: number` from `AnalyticsSummary` interface in `shared/types.ts`.

### REQ-5: Update Client Analytics Dashboard
- Remove the `summary30` useQuery block (it existed only to support the savings projection).
- Remove all savings-related variables: `actualSavings`, `baseSavings`, `spanDays`, `extrapolated`, `savings30d`, `rangeLabel`, `spanLabel`, `savingsHint`.
- Remove the "Est. savings" `Stat` card from the summary grid.
- Change the grid columns from `lg:grid-cols-6` to `lg:grid-cols-5`.
- Remove the "Saved" column (`TableHead` and `TableCell`) from the per-model breakdown table.
- Add `pr-4` class to the last column header ("Out tokens") since it is now the rightmost column.

### REQ-6: Update Server Tests
- Remove the `insertTokensRequest` helper function from `server/src/__tests__/routes/analytics.test.ts` (if it exists only for savings tests).
- Remove all test cases related to savings/cost calculations.
- Ensure remaining test cases continue to pass.

## Non-Functional Requirements

### NFR-1: Do Not Touch Staging
- The original repo `~/freellmapi` is STAGING — **never modify it**.
- All work must be done in a separate workspace/checkout.

### NFR-2: Preserve Existing Functionality
- All analytics endpoints that do NOT relate to cost/savings must continue to work identically.
- The `models` table must remain intact for routing purposes.
- The `PlatformStats`, `TimelinePoint`, `RequestLog` types in `shared/types.ts` must remain unchanged.

### NFR-3: Clean Cleanup
- Remove dead imports after deletions.
- Remove dead code paths that become unreachable after the savings logic is removed.
- Do not leave orphaned comments that only made sense in the context of savings calculations.

### NFR-4: Branch Hygiene
- Create branch: `feat/remove-savings-costs`
- Parent: `main` (commit `ff9f095`)
- Squash commits if multiple, or use a single descriptive commit.

## Acceptance Criteria

- [ ] `server/src/db/model-pricing.ts` does not exist.
- [ ] `/api/analytics/summary` returns JSON without `estimatedCostSavings` and `firstRequestAt` keys.
- [ ] `/api/analytics/by-model` returns JSON without `estimatedCost` key.
- [ ] `shared/types.ts` has no `estimatedCostSavings` field.
- [ ] Client `AnalyticsPage.tsx` does not show an "Est. savings" card.
- [ ] Client per-model table does not show a "Saved" column.
- [ ] `npm run test -w server` passes.
- [ ] `npm run build` passes (client compiles without type errors).
