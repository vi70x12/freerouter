# Requirements — Boot-Time Benchmark Fetch Fixes

**Date:** 2026-06-20  
**Severity:** High — boot log noise, degraded composite scores, unnecessary network overhead  
**Scope:** `server/src/services/benchmarks.ts`, `server/src/db/benchmark-scores.ts`, `server/src/db/migrations.ts`

---

## Observed Symptoms (from systemd journal)

```
июн 20 18:40:19 pc npm[90653]: [server] [NIM] External fetch failed: Unexpected token '<', "<!DOCTYPE >"
июн 20 18:40:19 pc npm[90653]: [server] [Boot] Benchmark errors: AA: AA API returned 404
```

Two distinct, independent bugs fire on every boot. Both waste network I/O and leave `benchmark_score` composites stale.

---

## R1: NIM Endpoint Returns HTML Instead of JSON

**R1.1** The NIM external fetch to `https://nimstats.maurodruwel.be/api/v1/benchmarks` must **not** throw an unhandled parse error when the server returns an HTML page (HTTP 200/301/302 with `Content-Type: text/html`).

**R1.2** The `fetchNIMBenchmarks()` parser must verify the response body is valid JSON before calling `response.json()`. If the body starts with `<!` (case-insensitive), it must skip to the array-format fallback parser or return `[]`.

**R1.3** If JSON parsing fails for any reason (network, timeout, non-JSON body), the method must return `[]` and log a single warning line **with the HTTP status and the first 80 chars of the body**, not a raw `SyntaxError` stack trace.

**R1.4** The `Content-Type` response header must be checked; if it is not `application/json`, the response body should be discarded without attempting `response.json()`.

---

## R2: AA API Endpoint Returns 404

**R2.1** The AA live fetch to `https://artificialanalysis.ai/api/leaderboards/intelligence` must handle HTTP 404 gracefully. When `res.ok === false`, the code must log a single warning line and fall back to the static `BENCHMARK_SCORES` embedded table **immediately**, without attempting to parse the body.

**R2.2** The boot log must not report a 404 as a user-visible “error” string in the `[Boot] Benchmark errors:` summary. A 404 is an known upstream condition (endpoint may have moved or been deprecated), not a failure of local logic.

**R2.3** If the AA endpoint returns 404, the in-memory `lastFetchResult` must be populated from the static table so subsequent boot-time calls within `FETCH_CACHE_TTL_MS` serve cached static data instead of re-fetching.

---

## R3: Boot-Time Fetch Orchestration

**R3.1** The `fetchLiveBenchmarkScores(db)` call inside `migrateDbSchema` is **async** but not `await`-ed. The outer `try/catch` therefore catches only synchronous throws and misses asynchronous rejections. The call must be awaited (or `.catch()` must be attached) so async rejections are absorbed.

**R3.2** The `updateAllBenchmarkScores()` call (lines 86-101 of `migrations.ts`) fires a fire-and-forget promise with a `.catch()` on the **returned** promise, but the `try/catch` around it is redundant — `new BenchmarkService()` cannot throw. Remove the outer `try/catch` or restructure so the intent (fire-and-forget) is clear.

---

## R4: Resilience (Retroactive for Both Fetches)

**R4.1** Every live benchmark fetch must have a timeout (already present for AA, missing for NIM).

**R4.2** Every live benchmark fetch must retry once with exponential backoff on 5xx or network errors.

**R4.3** The boot-time sequence must complete even when **all** live sources fail, relying on static fallback data.
