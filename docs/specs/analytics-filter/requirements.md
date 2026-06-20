# Analytics Provider Filtering — Requirements

## Problem

The Analytics tab currently shows **every provider that has historical request rows** in the SQLite `requests` table, regardless of whether that provider is currently active. This produces noisy, misleading output:

- Disabled providers (all keys toggled off) still appear in bar charts, tables, and error panels.
- Providers with zero active keys (all deleted or disabled) inflate error counts and drag down the aggregate success rate.
- A user who just disabled a broken provider still sees it polluting every metric — success rate, latency averages, error breakdowns — with stale data from before it was turned off.
- The per-model breakdown table shows models from disabled providers alongside active ones, making it hard to focus on what matters.

**Goal:** Analytics should only surface providers that are **currently active** — i.e. have at least one enabled key in `api_keys` **and** at least one enabled model in `models`. Disabled/no-key providers are hidden from all charts, tables, and summary calculations.

## Stakeholders

| Role | Interest |
|---|---|
| Dashboard user | Wants clean, actionable analytics without noise from disabled providers |
| Operator debugging issues | Needs to see only active providers to trace problems |
| Developer implementing | Needs clear spec on what "active" means and where filtering applies |

---

## Functional Requirements

### FR-1: Define "active provider"

A provider (platform) is considered **active** when **both** conditions are true:

1. `EXISTS (SELECT 1 FROM api_keys WHERE platform = ? AND enabled = 1)`
2. `EXISTS (SELECT 1 FROM models WHERE platform = ? AND enabled = 1)`

Both must hold. If a provider has keys but no enabled models, or models but no enabled keys, it is inactive for analytics purposes (the router would never send traffic there anyway).

**Keyless providers** (e.g. Kilo, Pollinations — `provider.keyless === true`) are treated as having an active key if their sentinel row in `api_keys` has `enabled = 1`.

Custom providers (`custom_providers` table) follow the same rule: their slug is the platform identifier. An archived custom provider (`archived = 1`) is always inactive regardless of key/model state.

### FR-2: Summary endpoint filters inactive providers

`GET /api/analytics/summary` must only count requests from active providers in its aggregate metrics:

- `totalRequests` — only requests where `r.platform` is in the active set
- `successRate` — computed from the filtered request set
- `totalInputTokens`, `totalOutputTokens` — only from active providers
- `avgLatencyMs` — average over the filtered request set
- `estimatedCostSavings` — only from active providers' successful requests
- `pinnedRequests`, `pinHonoredRequests` — only from active providers
- `firstRequestAt` — earliest request among active providers only

### FR-3: By-platform endpoint filters inactive providers

`GET /api/analytics/by-platform` must exclude rows for inactive providers entirely. If a disabled provider had 500 requests last week, it does not appear in the bar chart data.

### FR-4: By-model endpoint filters inactive providers

`GET /api/analytics/by-model` must exclude rows where the model's platform is inactive. Models belonging to disabled providers are hidden from the per-model breakdown table.

### FR-5: Timeline endpoint filters inactive providers

`GET /api/analytics/timeline` must only count requests from active providers. Success/failure counts per time bucket exclude disabled-provider traffic.

### FR-6: Error distribution endpoint filters inactive providers

`GET /api/analytics/error-distribution` must exclude errors from inactive providers in all three sub-responses (`byCategory`, `byPlatform`, `detailed`).

### FR-7: Recent errors endpoint filters inactive providers

`GET /api/analytics/errors` must exclude error rows from inactive providers. Recent errors from disabled providers are hidden.

### FR-8: Client-side no changes needed for hiding logic

Filtering is done **server-side**. The client (`AnalyticsPage.tsx`) just renders whatever data it receives; no client-side filter logic is required. However, the client may optionally show a small badge or note like "Showing N active providers" if useful.

## Non-Functional Requirements

### NFR-1: Performance

The active-provider check is a two-column EXISTS query on `api_keys` and `models`, both indexed by `platform`. Compute the active set **once per request** (not per row) using a CTE or subquery. This adds negligible overhead — the analytics queries already JOIN against `models`; adding an EXISTS on `api_keys` is trivial.

### NFR-2: No data deletion

This feature only changes **query visibility**, never deletes or modifies historical request rows. Disabled-provider data stays in the `requests` table for auditing, retention policies, and potential future "show all" mode.

### NFR-3: Backward compatibility

Existing API contracts (response shapes, field names) remain identical. The only change is that some rows are absent from responses. Any client that depends on a specific provider appearing in analytics will simply not see it when that provider is inactive — no breaking schema changes.

### NFR-4: Consistency

All six analytics endpoints must use the **same** active-provider definition. A provider is active or inactive globally within a single request — no endpoint-specific quirks.

### NFR-5: Caching consideration

The active-provider set changes only when keys or models are toggled (rare events). A future optimization could cache the active set with a short TTL (e.g. 5s) or invalidate on key/model mutations. For the initial implementation, computing it per-request is sufficient.
