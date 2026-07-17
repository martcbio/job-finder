# CLAUDE.md

Guidance for Claude Code (and any other agent) working in this repository.

This is a Bun job-search system with local and cloud operating lanes. Its primary
scanner is `lab-openings`: a launchd-scheduled macOS arm writes local market
artifacts, while a three-hourly Modal arm writes to the `careers` schema in the
estate Supabase project. Both arms publish parity digests from the same
`org:ats:id` identity set. Notion code remains legacy/optional; it is not the
source of truth for current API, UI, scanner, or application work.

The local JSON API is normally kept alive by launchd on `127.0.0.1:3737`. The
launchd-managed Vite review UI listens on `127.0.0.1:32002` and exposes Overview,
Review Queue, Cloud Lane, and the application pipeline board. The API fronts
local Postgres job-search data plus cloud-durable openings, operations, parity,
and `careers.applications` lifecycle data.

The bar for changes is: the next run is at least as trustworthy as the last
one. False positives in evaluation cost more than false negatives, so we err
toward strictness; flaky LLM behaviour gets contained, not papered over.

## Tasks

```sh
bun run labs:openings      # inspect/record the lab-openings scanner
bun run api                # local API on 127.0.0.1:3737
bun run jobs:fast-refresh  # cheap local Postgres refresh path
bun run test               # unit tests (src/**/__tests__/)
bun run test:integration   # full eval-pipeline tests, hits real LLM
bun run lint               # biome check
bun run lint:fix           # biome check --write
bun run typecheck          # tsc --noEmit
```

Pre-commit runs `lint`, `typecheck`, and `test` in parallel via lefthook. If a
hook fails, fix the cause — do not bypass with `--no-verify`.

## Runtime: Bun

- Use `bun` for everything: `bun <file>`, `bun test`, `bun install`,
  `bun run <script>`. Never `node`, `npm`, `pnpm`, `ts-node`, `jest`, `vitest`.
- Bun loads `.env` automatically; do not add `dotenv`.
- Prefer Bun built-ins: `Bun.file`, `Bun.$`, `bun:sqlite`, `bun:test`.
- Tests use `import { test, expect } from "bun:test"`.

## Architecture

The current system has four connected lanes:

```
lab-openings (mac launchd + Modal) → Supabase careers.openings + parity
local source fanout → Postgres ingest/classify/duplicates → human review queue
review decision → careers.applications lifecycle → owner-performed send
shortlisted application → resume3 CV bridge → dummy-rendered cv_staged artifact
```

```
src/
  api/             local JSON API, including cloud openings/applications/ops
  pipeline/        scanners, refresh, ingest, classify, review, and legacy stages
    __tests__/     unit tests
    __integration__/  full-pipeline tests + .md fixtures
  cv/              deterministic resume3 application staging bridge
  services/        external integrations (ATS, HTTP, LLM, legacy Notion)
    llm.ts         the only place that talks to OpenAI/OpenRouter
    ats/           dispatcher for greenhouse/lever/ashby
  concurrency/     reusable primitives — Semaphore, RateLimiter, CircuitBreaker, retry
  config/          validated configuration for the legacy Notion-first entrypoint
scripts/           API/scanner/backup wrappers and one-off operational tools
cloud/             Modal scanner arm and Supabase careers schema
prototypes/ui/     Vite review cockpit
```

`src/index.ts` still wires the retired Notion-first `scrape`/`reconcile` path.
Do not use it as the architecture template for new API, UI, or scanner work.

### Application and CV safety

`careers.applications` advances through
`interested → shortlisted → cv_staged → sent → response → interview → offer`;
`closed` is reachable from any active state. Agents may stage and record, but
only the owner sends: the API rejects `sent` unless `by` is `owner`, and no route
submits an external application.

The CV bridge runs resume3 subprocesses with `AGENT_MODE=1` and
`--identity=dummy`. It stores only dummy HTML/PDF renders and the case reference;
failure aborts the lifecycle transition.

### Operations and backup

Scheduled macOS and Modal work records control-plane runs/heartbeats. Operations
surfaces use `doctor_v2` (with explicit legacy-doctor detection), alerts, and
parity rows; a zero process exit is not a substitute for those beacons. The
nightly local Postgres backup lane writes custom-format dumps under
`market/backups`, retains 14, and emits a `jobs-db-backup` run beacon.

## Hard rules

- **Conventional commits.** Enforced by the `commit-msg` hook. Types:
  `feat|fix|refactor|chore|docs|test|style|perf|ci|build|revert`. The squash
  commit on merge becomes a line in the auto-generated release notes — write it
  like a release note, not a diary entry.
- **Atomic commits.** One logical change per commit. Don't fold unrelated
  cleanup into a feature commit.
- **Never bypass hooks.** No `--no-verify`. If lefthook fails, the underlying
  problem is the bug, not the hook.
- **Validate env at each runtime boundary.** The legacy Notion-first app owns its
  environment through `src/config`; the API, cloud arm, and scheduled wrappers
  have separate explicit configuration boundaries. Do not import `src/config`
  into new API/frontend code because it intentionally requires legacy secrets.
- **Structured logging via Pino child loggers.** Pass structured fields
  (`log.info({ url, attempt }, "search retry")`), not interpolated strings.
  Never log secrets.
- **Fail loud.** Errors propagate or are explicitly handled. Silent `catch`
  blocks are forbidden. Green CI with broken runtime is worse than red CI.
- **Tests must always run.** No `skipIf`, no `describe.skip`, no conditional
  skipping. If a test needs an env var, it should fail loudly when missing —
  not silently pass.
- **Fixed-version dependencies.** Every entry in `package.json` is pinned to an
  exact version. No `^`, no `~`. Updates are deliberate, lockfile-checked, and
  land in their own commit.
- **Modules are domain models.** A file's name describes the subject it
  owns (`exchangeRates.ts`, `notionCache.ts`, `tokenTracker.ts`). If a
  candidate filename describes a role rather than a piece of the domain,
  push back on the design — you probably haven't decided what it is yet.

## Type system

Lean on compile-time checks. Anything `tsc`, Biome, or lefthook can catch
before the code runs is the cheapest place to catch it. Save runtime checks
for what types can't see — config from the environment, network responses,
LLM output. A linter rule that fires on every save beats a unit test that
fires once an hour.

- **Parse at boundaries.** Validate config, LLM tool-call responses, and
  ATS payloads with Zod the moment they enter the system. Don't
  `JSON.parse` and cast — let the schema fail loudly so a malformed input
  never reaches the rest of the code.
- **Discriminated unions over boolean flags.** Model state with a `status`
  or `kind` field. Combinations of `isReady` / `isComplete` invite invalid
  states; a tagged union doesn't.
- **`as const` for shared constants and error codes** so callers get a
  narrow type and the values inline at compile time.
- **`noExplicitAny` and `noNonNullAssertion` are Biome errors.** If you
  reach for `as any` or `!`, the type model is wrong — fix the model.

### Direction: `neverthrow` for new fallible domain code

We are gradually adopting `Result<T, E>` / `ResultAsync<T, E>` for fallible
domain functions. The rule:

- New fallible domain code returns a `Result` and uses typed `as const` error
  codes — not strings, not exceptions.
- Existing code that throws stays as-is until we touch it. When you touch it,
  prefer converting it.
- Boundary helpers and entrypoints (`src/index.ts`, scripts) are allowed to
  catch + log + exit. They are the place errors finally surface.

This is a direction, not a retrofit. Don't open a PR that rewrites the world.

## Testing

Two layers. Unit tests in `src/**/__tests__/` guard the deterministic
parts — dedup, structural filter, scrape parsing, the concurrency
primitives — and run on every commit via lefthook. Integration tests in
`src/**/__integration__/` guard the LLM-driven verdicts via fixture
batches; they hit OpenRouter and cost money, so run them with
`bun run test:integration` before merging anything that changes prompts
or the eval pipeline.

- **Test names are third-person verbs.** `test("returns the canonical url")`,
  `describe("Dedup")`. Names describe behaviour, not implementation.
- **All tests always run.** Never `skipIf`, never `describe.skip`. A test that
  needs `OPENROUTER_API_KEY` should fail loudly without it.
- **Integration tests run the full eval pipeline.** `evaluateJob` (filters
  AND-ed, profiles OR-ed) — not isolated criteria. The contract under test is
  the system's verdict, not any single LLM call.
- **Fixtures are body-visible Markdown files.** Every fixture in
  `src/pipeline/__integration__/fixtures/` is a `.md` document whose reject
  reason is *visible in the body text*. Don't fixturise jobs whose reject
  reason only exists in ATS API metadata — those tests can't be reproduced
  from the fixture alone.
- **Parallel LLM calls in `beforeAll` with `Semaphore` + per-task error
  recovery.** Run all evaluations once, in parallel, with a bounded
  `Semaphore`. Wrap each task so a single failure doesn't tank the suite —
  store the error on the result and assert on it in its own test.
- **Track FP and FN separately.** False positives (a bad job marked pass) cost
  more than false negatives (a good job marked reject). The integration suite
  asserts a stricter FP threshold than FN.
- **N-shot examples in filter prompts.** Small, fast models (Gemini Flash,
  Haiku) need worked examples to be reliable. New filter prompts ship with
  N-shot examples *and* fixtures that exercise them.

## LLMs are non-deterministic black boxes

Treat every LLM call like a coin flip with strong opinions. The model
can be unreliable, will occasionally hallucinate, and sometimes returns
fluent nonsense. The pipeline keeps working anyway because composition
— structural filter, AND-ed filters, OR-ed profiles, fixture-pinned
thresholds — enforces decisions; the LLM only informs them.

- **All LLM calls go through `services/llm.ts`.** It owns the OpenRouter
  client. No direct `openai` imports anywhere else.
- **Token usage is tracked.** Every call logs token usage via `TokenTracker`.
  If you add a new LLM call site, wire the tracker through.
- **LLM bursts are bounded.** Stack `Semaphore` → `CircuitBreaker` →
  `withRetry` from `src/concurrency/`. Don't reinvent.
- **Failure modes are defined.** Timeout, malformed `tool_call`, rate limit —
  each is handled explicitly. Malformed `tool_call` throws so the retry stack
  catches it; do not silently return a default verdict.
- **Correctness must not depend on a specific LLM output.** Fixtures, profile
  rules, and the AND/OR composition enforce decisions; the LLM informs them.
  A single LLM hallucination should change at most one job's outcome, never the
  pipeline's behaviour.
- **Prompt changes ship with fixtures.** New prompt behaviour (added
  criterion, changed N-shot example) gets a fixture that exercises it — both a
  passing case and a rejecting case.

## Persistence boundaries

- Local Postgres is the source of truth for search runs, jobs, observations,
  classifications, duplicate candidates, review events, and local pipeline runs.
- The Supabase `careers` schema is the durable source for lab openings, scanner
  runs/parity/ops state, targets, and the application lifecycle.
- Notion integrations are legacy/optional. If deliberately maintaining them,
  keep all access through `services/notion`, preserve one-cache-per-run and
  idempotent reconcile behaviour, and handle rate limits with `withRetry`.
- Dedup canonicalises URLs. See `pipeline/dedup.ts`; new job sources need their
  URL shape considered before they are trusted as unique.

## Concurrency primitives

`src/concurrency/` exports composable primitives. Use them; do not reinvent.

- `Semaphore` — bounded parallelism (e.g. `jinaSearchSemaphore`).
- `RateLimiter` — RPS cap.
- `CircuitBreaker` — fail-fast on persistent upstream failure.
- `withRetry` — jittered backoff with `shouldRetry` and `onRetry` hooks.

Upstream calls are stacked: `Semaphore.run(() => Breaker.run(() => withRetry(...)))`.
The order matters — the semaphore bounds total in-flight work, the breaker
fails fast on a sick upstream, retries handle transient flakes inside that.

## Git workflow

- **Conventional commits**, atomic, per logical change.
- **Branches** are flat: `feat-ats-dispatcher`, not `feature/ats-dispatcher`.
- **Squash merge to `main` triggers a release.** `.github/workflows/release.yml`
  cuts a CalVer tag and a GitHub Release with auto-generated notes from commit
  messages. The squash commit title shows up verbatim in those notes — write
  it for the reader.
- **Solo dev workflow.** No required reviews. Self-review with `/review`
  before merge.
- `Co-Authored-By` trailers are fine.

## Style

- Biome handles formatting and lint. Don't fight it; run `bun run lint:fix`.
- Imports are relative within `src/`. No path aliases configured.
- Keep functions short enough to read without scrolling.
