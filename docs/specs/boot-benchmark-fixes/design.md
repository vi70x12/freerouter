# Design — Boot-Time Benchmark Fetch Fixes

**Date:** 2026-06-20  
**Related Specs:** `benchmark-unification` (provides the composite recomputation that depends on correct per-source scores), `dynamic-degradation`  
**Affected Symbols:**
- `server/src/services/benchmarks.ts::BenchmarkService.fetchNIMBenchmarks#method`
- `server/src/db/benchmark-scores.ts::fetchAAScores#function`
- `server/src/db/migrations.ts::migrateDbSchema#function`

---

## D1: NIM Fetch Resilience (fetchNIMBenchmarks)

### Current (buggy)
```
fetch → response.json() → parse models array
```
If the server returns HTML (e.g. Cloudflare error page, WAF block, or the NIM endpoint is down and serves a default HTML page), `response.json()` throws an unhandled `SyntaxError` that surfaces as:
```
[NIM] External fetch failed: Unexpected token '<', "<!DOCTYPE >"
```

### Proposed (fixed)
```
fetch with 10 s timeout
  ├── Content-Type !== application/json?
  │     └── log warn, return []
  ├── response.json() throws?
  │     └── log warn with body preview, return []
  ├── data.models array?
  │     └── parse NIM speed/reliability fields, return BenchmarkScore[]
  ├── data is plain array?
  │     └── parse array items, return BenchmarkScore[]
  └── else
        └── log warn, return []
```

### D1.1: Timeout
Introduce `AbortController` + `setTimeout(10_000)` identical to AA.

### D1.2: Content-Type Gate
Before touching `response.json()`, check `response.headers.get('content-type')?.includes('application/json')`. If false, the response body is read as text, logged (first 80 chars), and `[]` is returned.

### D1.3: JSON Parse Guard
Wrap `response.json()` in `try/catch`. On `SyntaxError`, read the body as text, log the preview, return `[]`.

---

## D2: AA Fetch 404 Handling (fetchAAScores)

### Current (buggy)
```typescript
if (!res.ok) {
  const msg = `AA API returned ${res.status}`;
  lastFetchResult = { updated: 0, errors: [msg] };
  // ... returns error to caller
}
```
The caller (`updateAllBenchmarkScores`) then surfaces this as a thrown error, which appears in boot log as `[Boot] Benchmark errors: AA: AA API returned 404`.

### Proposed (fixed)
```
fetch AA with 10 s timeout (already present)
  ├── 5xx or network error?
  │     └── retry once after 2 s exponential backoff
  ├── 404?
  │     └── log single warn line (non-error severity)
  │     └── apply static BENCHMARK_SCORES fallback via applyBenchmarkScores logic
  │     └── set lastFetchResult from static table counts
  │     └── return { updated: staticCount, errors: [], source: 'static' }
  └── 200
        └── parse JSON, upsert per-source columns as today
```

### D2.1: Static Fallback Population
When 404 is received, instead of returning an empty error result, trigger `applyBenchmarkScores(db)` inline (reusing the existing function that applies the static `BENCHMARK_SCORES` table). This ensures `aa_score` columns are populated from the embedded static data.

### D2.2: Boot Error Summary
By returning `{ errors: [] }` on 404 after populating static fallback, the boot log no longer shows `AA API returned 404` as an error. The log becomes:
```
[Benchmarks] AA fetch: 404, falling back to static scores (47 models)
```

---

## D3: Boot-Time Async Orchestration (migrations.ts)

### Current (buggy)
```typescript
try {
  fetchLiveBenchmarkScores(db);       // async, not awaited → rejections leak
} catch (error) {
  console.warn('...');
}

try {
  new BenchmarkService().updateAllBenchmarkScores() // promise, fire-and-forget
    .then(...)
    .catch(err => console.warn('[Boot] SWE-rebench fetch failed:', err));
} catch (error) {
  console.warn('SWE-rebench boot fetch failed:', error);
}
```

### Proposed (fixed)
```typescript
// AA static/live fetch — fire-and-forget with proper rejection handling
fetchLiveBenchmarkScores(db).catch(err =>
  console.warn('[Boot] AA fetch error:', err.message)
);

// SWE-rebench + NIM + AA composite pipeline — fire-and-forget
new BenchmarkService().updateAllBenchmarkScores()
  .then(({ updated, errors }) => {
    if (updated > 0) console.log(`[Boot] SWE-rebench updated ${updated} models`);
    if (errors.length > 0) console.warn('[Boot] Benchmark errors:', errors.join('; '));
  })
  .catch(err => console.warn('[Boot] SWE-rebench fetch failed:', err));
```

Remove the outer `try/catch` wrapper around `updateAllBenchmarkScores()` because the only synchronous throw site (`BenchmarkService` constructor) is infallible.

---

## D4: Retry Logic

Introduce a small internal helper `fetchWithRetry(url, options)`:
```typescript
async function fetchWithRetry(url: string, opts: { timeout: number; retries: number }):
  try fetch → ok
  catch → retry once after 2 s
  → log, return undefined
```
Use it for:
- AA live fetch (replaces manual `AbortController`)
- NIM fetch (new, currently unprotected)

---

## D5: File Map

| File | Symbol | Change |
|------|--------|--------|
| `server/src/services/benchmarks.ts` | `fetchNIMBenchmarks()` | Add content-type check, JSON parse guard, timeout, retry |
| `server/src/db/benchmark-scores.ts` | `fetchAAScores()` | Add 404→static fallback path; add retry; downgrade 404 from error to warn |
| `server/src/db/benchmark-scores.ts` | `BENCHMARK_SCORES` | Re-export count helper so `fetchAAScores` can report static model count |
| `server/src/db/migrations.ts` | `migrateDbSchema()` | Remove `try/catch` around `updateAllBenchmarkScores`; fix `fetchLiveBenchmarkScores` await |

