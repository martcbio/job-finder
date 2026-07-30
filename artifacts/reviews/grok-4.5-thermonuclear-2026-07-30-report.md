# Grok 4.5 thermonuclear review: jobsradar

Model: `cursor/grok-4.5` through Pi  
Effort: high  
Fast mode: off  
Mode: read-only  
Date: 2026-07-30

## Verdict

There is a model-free raw acquisition path, but there is not yet an explicit
product boundary for deterministic raw ingestion.

- `ingestNormalizedJobs` → `persistSearchResult` has no LLM dependency.
- `runFastRefresh`, `labs:openings`, and `opps update` mix acquisition with
  classification, screening, ranking, URL verification, bookmark signals, or
  email.
- Lab ATS preserves `raw`, but adds `classifyLabOpening` before persistence.
- Modal and Mac disagree on degraded-run semantics.
- Moving to `careers/jobsradar` is feasible but requires a staged path and
  service cutover.

## Highest-priority findings

### P0: degraded Modal runs can mutate durable openings and appear successful

`cloud/modal_app.py:642-663` upserts scan rows before checking whether the run is
complete. `src/pipeline/labBoards.ts:54-57` returns success for degraded runs.
Mac publication correctly retains the previous complete snapshot.

Required correction: on degraded runs, persist run health and diagnostics but
do not mutate `careers.openings`; degraded must not be operational success.

### P0: no raw-ingestion product boundary

The pure primitives exist, but every operator-facing refresh command adds
downstream policy:

- `src/pipeline/normalizedJobIngest.ts:54-91` is pure ingestion.
- `src/pipeline/fastRefresh/run.ts:64-72` always classifies after ingestion.
- `src/pipeline/labOpenings.ts:778-783` classifies during acquisition.
- `scripts/opps:35-48` adds signals, strict report health, email and reporting.

### P1: the current name cannot be changed by a blind directory move

Hard-coded old paths occur in:

- `scripts/opps`
- `scripts/lab-openings-scheduled.sh`
- `src/pipeline/labOpenings.ts`
- `scripts/com.mcb.job-finder-api.plist`
- `launchd/com.mcb.job-finder.fast-refresh.plist`
- `prototypes/ui/scripts/com.mcb.job-finder-ui.plist`
- `cloud/modal_app.py`
- related tests and documentation

The launchd jobs must be reinstalled and the Modal image path changed and
redeployed during cutover.

### P1: persistence is not run-atomic

`src/pipeline/normalizedJobIngest.ts:79-140` persists each job separately and
allows `completed_with_errors`. Individual observations are idempotent, but a
whole source run is not transactional.

### P1: report commands carry external email side effects

`opps list` and `opps update` email through Resend by default. A raw-ingestion
command must have no email, signal, URL-verification, ranking, CV or application
side effects.

### P2: Linear and Google evidence is weaker than ATS/JobServe evidence

`src/pipeline/directSources.ts:250-269` has no retry stack. Its `raw` payload is
thin listing metadata rather than the original response/body, weakening
forensic replay.

### P2: missing persistence contract tests

Normalization helpers are tested, but the durable
`ingestNormalizedJobs` database write loop is not.

## Target boundary

```text
jobsradar ingest
  fetch
  preserve source evidence
  validate
  normalize
  canonicalize/deduplicate
  persist jobs + observations + bodies
  emit per-source health receipt

  no classification
  no screening
  no ranking or Picks
  no bookmarks
  no URL verification
  no email
  no CV/application operations
  no Notion/LLM path
```

Network acquisition is variable because upstream sites change. Given frozen
source evidence and one normalizer version, evidence-to-persistence should be
deterministic and replayable.

## Recommended order

1. Add a tested `jobsradar ingest` command without moving the repository.
2. Add `skipClassify` to fast refresh and make it the ingest-command default.
3. Split lab raw acquisition from `classifyLabOpening`.
4. Correct degraded Modal upsert and exit semantics.
5. Add evidence preservation/retries for Linear and Google.
6. Add persistence and degraded-run contract tests.
7. Make paths location-derived or configurable.
8. Move to `/Users/mcb/Claudelocal/careers/jobsradar`.
9. Update/reinstall launchd and redeploy Modal.
10. Retain `opps` temporarily only as a deprecated report alias.

## Acceptance criteria

- `jobsradar ingest` performs zero model calls and cannot invoke Resend.
- Replaying the same captured source evidence creates no duplicate jobs.
- Every source produces a structured complete/degraded/failed receipt.
- A degraded Modal run cannot modify the durable current opening set.
- Lab raw evidence exists independently of screening/disposition.
- JobServe remains opt-in and bounded.
- Typecheck, lint and deterministic unit suites pass.
- After the move, API, UI, launchd, Modal sync, backups and doctor checks use
  the new path with no compatibility symlink required.

## Preserve

Do not rewrite:

- canonical URL and ATS identity logic;
- idempotent job observations;
- ATS Zod validation, rate limiting, circuit breaker and retries;
- raw ATS JSON preservation;
- Mac retention of the last complete publication;
- parity guards;
- bounded opt-in JobServe behaviour;
- owner-only application sending.

## Non-goals

Summarization, subjective ranking, ChatGPT Picks, CV generation, application
submission, automatic duplicate merging, and a wholesale rewrite of the legacy
Notion lane.
