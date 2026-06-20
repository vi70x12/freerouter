# Analytics Provider Filtering — Design

## Architecture Decision: Server-Side SQL Filtering

All filtering happens in the SQL layer. The client (`AnalyticsPage.tsx`) is unchanged — it already renders empty states when arrays are empty and zeroed stat cards. No new client code needed.

## Active Provider Definition (Canonical)

A platform is **active** when **both** hold:

1. `EXISTS (SELECT 1 FROM api_keys WHERE platform = ? AND enabled = 1)`  
2. `EXISTS (SELECT 1 FROM models WHERE platform = ? AND enabled = 1)`

Edge cases:
- **Keyless providers** (Kilo, Pollinations, OVH) have sentinel `api_keys` rows with `enabled = 1` when active — they naturally pass check 1.
- **Archived custom providers** (`custom_providers.archived = 1`) have their keys and models disabled by cascade, so they naturally fail both checks.
- **Platform with keys but no enabled models** (e.g. all models manually disabled) → inactive. The router wouldn't route there anyway.
- **Platform with models but no keys** (keys deleted) → inactive. Same reasoning.

## Implementation Strategy: CTE + Parameterized IN

Rather than two EXISTS subqueries per analytics row, compute the active set **once** as a CTE and join against it. This is clean, fast, and keeps the SQL readable.

### Core CTE

```sql
WITH active_platforms AS (
  SELECT DISTINCT k.platform
  FROM api_keys k
  WHERE k.enabled = 1
    AND EXISTS (
      SELECT 1 FROM models m
      WHERE m.platform = k.platform AND m.enabled = 1
    )
)
```

Every analytics query then adds:

```sql
AND r.platform IN (SELECT platform FROM active_platforms)
```

(Or `AND platform IN (...)` for queries that don't alias `requests` as `r`.)

### Zero-Active-Platforms Fast Path

If the CTE yields zero rows, all endpoints return their empty/zero shape immediately — no need to run the full analytics queries against an empty set.

Detect this in the route handler by running the CTE first:

```ts
const activePlatforms = db.prepare(`
  SELECT DISTINCT k.platform
  FROM api_keys k
  WHERE k.enabled = 1
    AND EXISTS (SELECT 1 FROM models m WHERE m.platform = k.platform AND m.enabled = 1)
`).all() as { platform: string }[];
```

If `activePlatforms.length === 0`, return the empty response shape for that endpoint.

Otherwise, build the IN clause from `activePlatforms.map(p => p.platform)` and splice it into the existing queries.

## Endpoint-by-Endpoint Changes

### 1. `GET /api/analytics/summary`

**Current SQL** (simplified):
```sql
SELECT COUNT(*) as total_requests, ...
FROM requests r
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
WHERE r.created_at >= ?
```

**New SQL**:
```sql
WHERE r.created_at >= ?
  AND r.platform IN (SELECT platform FROM active_platforms)
```

The CTE is prepended. Bind params unchanged (CTE has no params; the IN subquery is self-contained).

**Empty response**: `{ totalRequests: 0, successRate: 0, totalInputTokens: 0, totalOutputTokens: 0, avgLatencyMs: 0, estimatedCostSavings: 0, pinnedRequests: 0, pinHonoredRequests: 0, firstRequestAt: null }`

### 2. `GET /api/analytics/by-model`

**Current SQL**:
```sql
SELECT r.platform, r.model_id, ...
FROM requests r
LEFT JOIN models m ON m.platform = r.platform AND m.model_id = r.model_id
WHERE r.created_at >= ?
GROUP BY r.platform, r.model_id
```

**New SQL**:
```sql
WHERE r.created_at >= ?
  AND r.platform IN (SELECT platform FROM active_platforms)
```

Note: the `LEFT JOIN models` is already present for `display_name` and cost pricing — not the same as the active-platform check (which needs `models.enabled = 1` without the model_id scope).

**Empty response**: `[]`

### 3. `GET /api/analytics/by-platform`

**Current SQL**:
```sql
SELECT platform, COUNT(*) as requests, ...
FROM requests
WHERE created_at >= ?
GROUP BY platform
```

**New SQL**:
```sql
WHERE created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**Empty response**: `[]`

### 4. `GET /api/analytics/timeline`

**Current SQL**:
```sql
SELECT strftime(...) as timestamp, COUNT(*) as requests, ...
FROM requests
WHERE created_at >= ?
GROUP BY strftime(...)
ORDER BY timestamp ASC
```

**New SQL**:
```sql
WHERE created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**Empty response**: `[]`

### 5. `GET /api/analytics/error-distribution`

Three internal queries. All three get the same filter:

**Detailed query**:
```sql
WHERE status = 'error' AND created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**byCategory query**:
```sql
WHERE status = 'error' AND created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**byPlatform query**:
```sql
WHERE status = 'error' AND created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**Empty response**: `{ byCategory: [], byPlatform: [], detailed: [] }`

### 6. `GET /api/analytics/errors`

**Current SQL**:
```sql
WHERE status = 'error' AND created_at >= ?
ORDER BY created_at DESC
LIMIT 50
```

**New SQL**:
```sql
WHERE status = 'error' AND created_at >= ?
  AND platform IN (SELECT platform FROM active_platforms)
```

**Empty response**: `[]`

## Helper: `getActivePlatforms()`

A small extracted function shared by all six endpoints:

```ts
/** Return platforms that have ≥1 enabled key AND ≥1 enabled model. */
function getActivePlatforms(db: Database.Database): string[] {
  return (db.prepare(`
    SELECT DISTINCT k.platform
    FROM api_keys k
    WHERE k.enabled = 1
      AND EXISTS (
        SELECT 1 FROM models m
        WHERE m.platform = k.platform AND m.enabled = 1
      )
  `).all() as { platform: string }[]).map(r => r.platform);
}
```

## Helper: `buildPlatformFilter()`

```ts
/** Build an IN-clause fragment for active platforms.
 *  Returns { sql, params } — sql is '' when no active platforms exist. */
function buildPlatformFilter(activePlatforms: string[], alias?: string): { sql: string; params: string[] } {
  if (activePlatforms.length === 0) return { sql: '', params: [] };
  const col = alias ? `${alias}.platform` : 'platform';
  return {
    sql: `AND ${col} IN (${activePlatforms.map(() => '?').join(',')})`,
    params: activePlatforms,
  };
}
```

Usage pattern in each endpoint:

```ts
const active = getActivePlatforms(db);
if (active.length === 0) {
  return res.json(EMPTY_SHAPE);
}
const pf = buildPlatformFilter(active, 'r');  // or '' for unaliased
// ... existing SQL ... + pf.sql  ...bind: [...existingBindings, ...pf.params]
```

## Files Changed

| File | Change |
|---|---|
| `server/src/routes/analytics.ts` | Add `getActivePlatforms()`, `buildPlatformFilter()`. Update all 6 endpoints per above. |
| `server/src/__tests__/routes/analytics.test.ts` | Add `insertKey()` helper. Seed keys in `beforeAll`/`beforeEach`. Add `describe('active provider filtering')` with 7+ new tests. |

No other files change. Client is untouched.

## Migration / Compatibility Notes

- **No schema changes**. This is purely a query-time filter.
- **No API contract changes**. Response shapes are identical; some rows are simply absent.
- **Existing tests** must be updated to seed at least one enabled key for every platform they insert `requests` rows for. Without this, the filter would exclude all test data and every existing test would break.
