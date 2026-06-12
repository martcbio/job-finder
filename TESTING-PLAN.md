# Testing plan — queue refresh & source parity

The regression we hit was a **contract drift** problem: the backend knew about 43 refreshable sources, the UI only trusted 2, and nothing asserted they stayed aligned. This document captures the test plan to catch that class of bug early.

Status: **planned, not yet implemented** (except partial coverage in existing tests).

## Existing coverage

| File | What it covers |
|------|----------------|
| `src/pipeline/__tests__/queueRefresh.test.ts` | Partition planning, spot checks on registry ids |
| `src/api/__tests__/server.test.ts` | Partial `/api/sources` contract (queueRefresh, jobspy, rippling) |

## High value (add first)

### 1. Registry parity — single source of truth

**File:** `src/pipeline/__tests__/queueRefresh.registry.test.ts`

| Test | What it catches |
|------|-----------------|
| `allQueueRefreshSourceIds()` equals `JOB_SOURCE_SITES` ids + `jobserve` + `linear-careers` + `jobspy` | Missing ATS site in refresh list |
| Every `JOB_SOURCE_SITES` id has `queueRefreshKindFor(id) === "search"` | Site added to config but not refreshable |
| `jobspy` is `lane_import`, not `search` | Wrong partition bucket |
| `linear-careers` is `fast`, never `search` | Double-scheduling |

This is the test that would have caught **rippling/greenhouse marked “database only”** while they were already in `sourceSites`.

### 2. Generated UI registry stays in sync

**File:** `src/pipeline/__tests__/queueRefresh.registry.test.ts` (or CI script)

```ts
test("UI queueRefreshRegistry matches backend registry", () => {
  const backend = new Set(allQueueRefreshSourceIds());
  for (const id of QUEUE_REFRESH_SOURCE_IDS) expect(backend.has(id)).toBe(true);
  expect(QUEUE_REFRESH_SOURCE_IDS.size).toBe(backend.size);
});
```

Run `bun run gen:refresh-registry` in CI after registry changes; fail if git diff is non-empty. Prevents the UI fallback from going stale when someone adds a site.

### 3. API `/api/sources` contract (extend existing)

**File:** `src/api/__tests__/server.test.ts` — tighten existing assertions:

| Assertion | Why |
|-----------|-----|
| `refreshableSourceIds.length === queueRefresh.length` | Two lists diverging |
| `refreshableSourceIds` contains every id from `allQueueRefreshSourceIds()` | API subset of registry |
| `queueRefresh` ids are a superset of `fastRefresh` ids | Old 2-source world creeping back |
| Each `queueRefresh` entry has `supportsSourceScopedRefresh: true` | UI disable logic |
| `jobspy` present with expected kind | Lane import missing from API |

This catches **stale API process / handler not wired** without needing a live server.

### 4. `buildSourceCatalog` unit tests (UI, no browser)

**File:** `prototypes/ui/src/sourceFilters.test.ts` (vitest or bun test)

Mock inputs that reproduce the bug:

```ts
// Reproduces the screenshot bug: health has rippling, API only returns 2 fastRefresh
const catalog = buildSourceCatalog(
  [{ source_id: "rippling", source_label: "Rippling", success_rate: 0.8, ... }],
  [{ id: "jobserve", ... }, { id: "linear-careers", ... }], // stale API
  [], // no refreshableSourceIds from API
);
expect(catalog.find(s => s.id === "rippling")?.refreshable).toBe(true);
```

Also test:

- With `refreshableSourceIds` from API → uses API list
- Without API list → falls back to `QUEUE_REFRESH_SOURCE_IDS`
- Health-only source **not** in registry → `refreshable: false` (true “database only”)
- `refreshTargets()` returns only checked + refreshable entries

### 5. Partition → refresh dispatch (integration, mocked)

**File:** `src/pipeline/__tests__/queueRefresh.run.test.ts`

Mock `runFastRefresh`, `runSourceSearchForSites`, `runJobspyLaneRefresh` and assert:

| Input `sourceIds` | Expected calls |
|-------------------|----------------|
| `["jobserve", "greenhouse", "jobspy"]` | fast(jobserve), search(greenhouse), lane(jobspy) |
| All 43 ids | all three paths invoked with correct subsets |
| `["unknown-x"]` | skipped summary, no throw |
| Empty after partition | no network calls |

Prevents **“Update queue only hits jobserve”** when UI sends the full checked list.

---

## Medium value

### 6. `POST /api/refresh/fast` passes `sourceIds` through

Extend `server.test.ts`:

```ts
test("refresh/fast forwards sourceIds to queue refresh", async () => {
  // inject mock fastRefresh runner, POST with sourceIds: ["greenhouse", "rippling"]
  expect(calls[0].sourceIds).toEqual(["greenhouse", "rippling"]);
});
```

### 7. JobSpy lane refresh

**File:** `src/pipeline/__tests__/jobspyRefresh.test.ts`

- No snapshot file → `outcome: "not_implemented"`, clear error message
- Valid fixture JSON → `imported > 0`
- Empty array → `zero_results`

### 8. Source health ⊇ refreshable (optional DB test)

If integration tests against Postgres exist:

```sql
-- every refreshable id should appear in source_health OR be explicitly new
```

Or a script test: compare `allQueueRefreshSourceIds()` to distinct `source_id` from last 30 days of `search_queries`.

---

## Lower value / later

### 9. UI component smoke (Playwright)

One test on Signal Cockpit:

- Select all sources
- Assert sidebar shows **no** “In database only” for ids in `QUEUE_REFRESH_SOURCE_IDS`
- Assert “Will refresh:” line includes `greenhouse` when checked

Heavy for CI; good as a manual smoke checklist.

### 10. E2E refresh with discovery keys

Only in a dev/staging env with `BRAVE_API_KEY` / `JINA_API_KEY`. Assert `POST /api/refresh/fast` with `sourceIds: ["greenhouse"]` returns a source summary row for `greenhouse`. Flaky if keys/network fail — mark `@integration`.

---

## Suggested CI gate

```text
bun test src/pipeline/__tests__/queueRefresh*.test.ts
bun test src/api/__tests__/server.test.ts  # sources + refresh/fast sections
bun test prototypes/ui/src/sourceFilters.test.ts
bun run gen:refresh-registry && git diff --exit-code prototypes/ui/src/queueRefreshRegistry.ts
```

---

## Symptom → test mapping

| Symptom | Test that catches it |
|---------|----------------------|
| Only jobserve + linear refreshable in UI | Registry parity + `buildSourceCatalog` fallback test |
| rippling/jobspy “database only” | `buildSourceCatalog` with health row + stale 2-item API |
| API missing `queueRefresh` field | Contract test on `/api/sources` response shape |
| jobspy not in refresh list | `allQueueRefreshSourceIds` contains `jobspy` |
| Checked 43 sources but only 2 searched | Partition dispatch test with full id list |

## Highest ROI

**#1 registry parity**, **#2 generated file sync**, and **#4 `buildSourceCatalog` repro test** — three small test files, no browser, encoding the invariant:

> If we collect from a source, the UI and API must agree it is refreshable.
