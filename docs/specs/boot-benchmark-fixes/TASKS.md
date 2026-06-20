# Tasks — Boot-Time Benchmark Fetch Fixes

**Date:** 2026-06-20  
**Estimated Effort:** ½ day  
**No DB migrations required** — all changes are in-memory / control-flow only.

---

## Task 1 — Harden NIM Fetch Against Non-JSON Responses

**Dependencies:** None  
**Files:** `server/src/services/benchmarks.ts`  
**Symbols:** `BenchmarkService.fetchNIMBenchmarks#method` (lines 122-165)

### Work
1. Add `AbortController` + 10 s timeout around the `fetch` call.
2. After `fetch`, before `response.json()`, check `response.headers.get('content-type')?.includes('application/json')`.
   - If `false`: read `response.text()`, log `[NIM] Non-JSON response (${status}): ${body.slice(0,80)}`, return `[]`.
3. Wrap `response.json()` in `try/catch`.
   - On `SyntaxError`: log `[NIM] JSON parse failed: ${err.message}`, return `[]`.
4. Keep existing `data.models` and plain-array parsing branches, but wrap each in `try/catch` so a malformed single model object doesn't crash the whole batch.
5. Add a single retry on 5xx or network errors (leave 4xx as terminal).

### Validation
- Unit test: mock `fetch` returning `text/html` body → expect `[]` and warn log.
- Unit test: mock `fetch` returning JSON with `models` array → expect parsed `BenchmarkScore[]`.
- Unit test: mock `fetch` throwing `ECONNRESET` → retry once, then `[]`.

---

## Task 2 — Graceful 404 Fallback for AA Fetch

**Dependencies:** None  
**Files:** `server/src/db/benchmark-scores.ts`  
**Symbols:** `fetchAAScores#function` (lines 436-518)

### Work
1. In the `!res.ok` branch (line 461), add a special case for `res.status === 404`:
   - Log: `[Benchmarks] AA fetch: 404, falling back to static scores`
   - Call `applyBenchmarkScores(db)` (already imported).
   - Compute `staticCount` from `BENCHMARK_SCORES` array length.
   - Set `lastFetchResult = { updated: staticCount, errors: [] }`.
   - Return `{ ...lastFetchResult, source: 'static', affectedIds: new Set() }`.
   - **Do not** add `AA API returned 404` to the `errors` array.
2. For non-404 non-ok statuses (e.g. 500, 403), keep existing error behavior but cap body read to first 80 chars.
3. Add a single retry on 5xx or network errors (2 s delay).

### Validation
- Unit test: mock `fetch` returning 404 → expect `source: 'static'`, `errors` empty, `updated > 0`.
- Unit test: mock `fetch` returning 500 then 200 → expect retry succeeds.
- Unit test: mock `fetch` returning 500 twice → expect error in `errors` array, no throw.

---

## Task 3 — Fix Boot-Time Async Orchestration

**Dependencies:** Task 1, Task 2 (or can be done in parallel with careful merge)  
**Files:** `server/src/db/migrations.ts`  
**Symbols:** `migrateDbSchema#function` (lines 13-102)

### Work
1. Change:
   ```typescript
   try {
     fetchLiveBenchmarkScores(db);
   } catch (error) {
     console.warn('Live benchmark fetch failed, using static scores:', error);
   }
   ```
   to:
   ```typescript
   fetchLiveBenchmarkScores(db).catch(err =>
     console.warn('[Boot] AA fetch error:', err.message)
   );
   ```
2. Change:
   ```typescript
   try {
     new BenchmarkService().updateAllBenchmarkScores()
       .then(...)
       .catch(err => console.warn('[Boot] SWE-rebench fetch failed:', err));
   } catch (error) {
     console.warn('SWE-rebench boot fetch failed:', error);
   }
   ```
   to:
   ```typescript
   new BenchmarkService().updateAllBenchmarkScores()
     .then(({ updated, errors }) => {
       if (updated > 0) console.log(`[Boot] SWE-rebench updated ${updated} models`);
       if (errors.length > 0) console.warn('[Boot] Benchmark errors:', errors.join('; '));
     })
     .catch(err => console.warn('[Boot] SWE-rebench fetch failed:', err));
   ```
3. Add comment: `// Fire-and-forget: benchmark data is non-blocking on boot`.

### Validation
- Manual: start server, verify no unhandled rejection warnings.
- Manual: start server, verify boot log is clean of `UnhandledPromiseRejection`.

---

## Task 4 — Acceptance Test: Clean Boot Log

**Dependencies:** Task 1, Task 2, Task 3  
**No code changes — run and observe.**

### Steps
1. Start the server: `npm run dev` (or just server via `npm run dev -w server`).
2. Observe the boot log.
3. Confirm **absence** of:
   - `[NIM] External fetch failed: Unexpected token '<'`
   - `[Boot] Benchmark errors: AA: AA API returned 404`
4. Confirm **presence** of (one of):
   - `[Benchmarks] AA fetch: 404, falling back to static scores (47 models)`  
   - or, if AA endpoint comes back: `[Benchmarks] AA fetch: <n> models updated`
   - `[Benchmarks] NIM updated <n> models` (or nothing if endpoint is genuinely down)
   - `[Benchmarks] Total: <n> models updated, <m> composites recomputed`

### Known Externalities
- The NIM endpoint may be temporarily or permanently offline. That is acceptable. The fix means the system **survives** the outage without console noise.
- The AA endpoint returning 404 may be a permanent upstream API change. The fix means the system **falls back** to static data without bothering the user.
