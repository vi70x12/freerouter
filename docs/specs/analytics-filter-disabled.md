# SPEÇ: Filter Disabled / No-Active-Key Providers from Analytics
> Branch: `feat/analytics-filter-disabled`
> Workspace: `/home/vi/freellmapi-analytics-filter`
> Target files: `server/src/routes/analytics.ts`, `server/src/__tests__/routes/analytics.test.ts`

## Problem
Currently, the analytics dashboard includes ALL requests across ALL platforms, regardless of whether a platform is currently configured (has at least one enabled API key). This skews success rates and clutters charts with dead providers.

## Goal
**Hide** providers that are **disabled or have no active keys** from every analytics endpoint AND exclude them from all calculations (success rate, totals, averages, savings projection).

## Definition of "Active Provider"
A platform is "active" if `api_keys` has at least one row with `enabled = 1` for that platform.

Keyless providers (kilo, pollinations, ovh) auto-create sentinel key rows and naturally satisfy this test. Archived custom providers get their keys disabled and naturally get filtered out. Key deletion removes the row → filtered out.

## Requirements

### R1: Filter in ALL endpoints
The filter must be applied to **all** analytics endpoints:
1. `/api/analytics/summary`
2. `/api/analytics/by-platform`
3. `/api/analytics/by-model`
4. `/api/analytics/timeline`
5. `/api/analytics/error-distribution`
6. `/api/analytics/errors`

### R2: Correct handling with zero active providers
When there are zero active providers, endpoints must return their "empty" shape (e.g. `totalRequests: 0`, empty arrays) **without crashing**.

### R3: Parameters work correctly
Query parameters (`range`, `interval`) must continue working exactly as before.

### R4: Tests added
Add new tests that verify:
- Requests from a provider with no keys are excluded from all endpoints.
- Requests from a provider with only disabled keys are excluded.
- Enabling a key (for a previously uncounted provider) makes its requests appear.
- Existing tests (especially pinned vs. auto requests, savings calculation) still pass (they may need an `insertKey()` call if the test platform was previously un-keyed).

## Design

### Approach
Use runtime filtering via SQL `IN` clause. On each request, query `api_keys.enabled = 1` for all distinct platforms, then inject `AND platform IN (...)` into every analytics query.

### DB Tables Involved
| Table | Columns | Relevance |
|-------|---------|-----------|
| `api_keys` | `platform`, `enabled` | Source of truth for "active" |
| `requests` | `platform`, `model_id`, `status`, etc. | The data being filtered |
| `models` | `display_name`, `paid_input_per_m`, `paid_output_per_m` | Joined for savings cost calculation |

### Helper Functions
```ts
/** Return platforms that have at least one enabled API key. */
function getActivePlatforms(db: import('better-sqlite3').Database): string[]

/**
 * Build a platform-filter clause and its bind params for SQL queries.
 * Returns `{ sql: string; params: string[] }`.
 * sql is empty/params empty if no active platforms exist.
 */
function platformFilterClause(db: import('better-sqlite3').Database, tablePrefix: string = 'r.'): { sql: string; params: string[] }
```

### SQL Parameterization Strategy
For `IN` clause with variable number of elements:
```ts
const pf = platformFilterClause(db, 'r.'); // or '' for unqualified
// Query binds:  FALLBACK_..., FALLBACK_..., since, ...pf.params
// SQL snippet:
//   WHERE r.created_at >= ?
//   ${pf.sql}
```
Where `pf.sql` would be something like `AND r.platform IN ('groq','cerebras')`.

For SQLite with `better-sqlite3`, use parameterized query with `?` placeholders for IN elements:
```ts
`... AND r.platform IN (${active.map(() => '?').join(',')})`
// bind: FALLBACK_IN, FALLBACK_OUT, since, ...active
```

### Test Helpers
```ts
function insertKey(platform: string, enabled: number): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
    VALUES (?, 'test', ?, ?, ?, 'healthy', ?)
  `).run(platform, '0'.repeat(64), '0'.repeat(32), '0'.repeat(32), enabled);
}
```

### Test Data Consideration
Existing tests insert `requests` rows for platforms like `'test'`, `'groq'`, `'custom'`. These platforms do **not** have matching rows in `api_keys`, so with the new filtering they would all be excluded. You must add `insertKey()` calls to seed test data so existing tests continue to pass.

The recommended approach in `beforeEach` or per-test setup:
```ts
// For the 'test' platform used by insertRequest()
insertKey('test', 1);
// For groq used by certain tests
insertKey('groq', 1);
// For 'custom' platform
insertKey('custom', 1);
```

## Tasks

### Task 1: Modify `server/src/routes/analytics.ts`

Add the `getActivePlatforms()` and `platformFilterClause()` helpers at the top of the file (after `getSinceTimestamp`).

Update every endpoint to:
1. Call `platformFilterClause()`
2. If `params.length === 0`, return the empty/zero shape immediately
3. Otherwise, execute the SQL with the additional `IN` clause bind params

**Specific endpoints:**

- **GET `/summary`**
  - Empty response: `{ totalRequests: 0, successRate: 0, totalInputTokens: 0, totalOutputTokens: 0, avgLatencyMs: 0, estimatedCostSavings: 0, pinnedRequests: 0, pinHonoredRequests: 0, firstRequestAt: null }`
  - Add `AND r.platform IN (...)` to the WHERE clause.
  - Bind params order: `FALLBACK_INPUT_PER_M, FALLBACK_OUTPUT_PER_M, since, ...pf.params`

- **GET `/by-model`**
  - Empty response: `[]`
  - Add `AND r.platform IN (...)` to WHERE clause, after `r.created_at >= ?`

- **GET `/by-platform`**
  - Empty response: `[]`
  - Add `AND platform IN (...)` to WHERE clause, after `created_at >= ?`

- **GET `/timeline`**
  - Empty response: `[]`
  - Add `AND platform IN (...)` to WHERE clause, after `created_at >= ?`

- **GET `/error-distribution`**
  - Empty response: `{ byCategory: [], byPlatform: [], detailed: [] }`
  - Apply IN filter to all three internal queries (detailed, byCategory, byPlatform)

- **GET `/errors`**
  - Empty response: `[]`
  - Add `AND platform IN (...)` to WHERE clause

### Task 2: Modify `server/src/__tests__/routes/analytics.test.ts`

1. Add `insertKey` helper after `insertTokensRequest`. Use the exact SQL above.
2. Add `insertKey('test', 1)`, `insertKey('groq', 1)`, and `insertKey('custom', 1)` in the test `beforeAll` (or in `beforeEach`) so existing tests have the required keys seeded.
3. Add a new `describe` block 'active provider filtering' with tests:
   - `excludes requests from providers with no enabled keys (summary)` - insert a request for a platform with no enabled key, verify it's filtered out
   - `excludes requests from providers with only disabled keys (summary)` - insert key with `enabled=0`, verify request is excluded
   - `includes requests once a key is enabled` - disabled key, then enabled, verify counts change
   - `filters by-platform endpoint` - verify by-platform only returns active platform
   - `filters by-model endpoint` - verify by-model only returns active platform models
   - `filters timeline endpoint` - verify timeline only counts active platform requests
   - `filters error-distribution endpoint` - verify errors from inactive platforms are hidden

### Task 3: Run tests
```bash
cd /home/vi/freellmapi-analytics-filter && npm run test -w server -- --run server/src/__tests__/routes/analytics.test.ts
```

If tests fail, fix the `beforeEach`/`beforeAll` key-seeding logic so existing tests pass with the new filtering.

## Acceptance Criteria
- [ ] All 6 analytics endpoints filter out requests from providers without enabled keys.
- [ ] When no keys are enabled anywhere, all endpoints return sensible empty/zero values.
- [ ] Existing tests pass (after adding key seeds as needed).
- [ ] New tests cover: exclusion (no keys), exclusion (disabled keys), and inclusion (keys enabled).
- [ ] No changes required to `client/src/pages/AnalyticsPage.tsx` (it already renders whatever the server returns).

## Notes
- Do NOT modify the client. If the server returns empty arrays or zeroed stats, the client already handles "No data yet" and renders empty states.
- Do NOT modify any other files. Only `analytics.ts` and `analytics.test.ts` should change.
