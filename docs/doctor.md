# Jobsradar token Doctor

The Doctor is an out-of-band repair lane for deterministic `jobsradar ingest`
failures. Ingestion never calls a model. Only the CLI boundary classifies its
terminal receipt or thrown error.

Repair-worthy occurrences are written immutably under a stable fingerprint in
the gitignored `logs/doctor/incidents/` spool. Concurrent identical failures
deduplicate under a per-fingerprint lock. A repeated failure stays deduplicated
while pending, but a new occurrence is created if the same failure returns after
a successful Doctor attempt or while an attempt is active. Attempt reservation,
terminal receipt commit, and recurrence recording share the fingerprint-lock
protocol, so a concurrent recurrence cannot disappear when an attempt completes.
Pure external timeouts, blocking, rate limits, authentication failures, and
operator input errors do not create Doctor work unless the same outcome includes
unknown or internal evidence.

After a repair-worthy incident is safely spooled, the ingest CLI starts a
separate detached dispatcher. A launch failure is written under
`logs/doctor/launcher-failures/` and can be recovered manually:

```bash
bun run jobsradar:doctor -- run-pending
```

Read-only status never invokes a model:

```bash
bun run jobsradar:doctor -- status
bun run jobsradar:doctor -- status --json
```

## Agent boundary

Each eligible dispatch starts exactly one explicit command:

```text
<absolute-codex> exec --json --sandbox workspace-write -C <isolated-worktree> \
  --output-last-message <private-dispatch-raw-final> -
```

No model is specified, so Codex uses its current default. There is no AI stack
router and no model/provider fallback. The prompt is sent on stdin. The command
runs in a detached Git worktree at the incident's recorded HEAD, never in the
user's possibly dirty checkout. Worktree creation is fail-closed. The owned
Codex process group has workspace-write sandboxing and is terminated as a group
at the configured timeout or prompt-write failure. SIGKILL is always sent after
the termination grace period, even if the group leader has already exited.
An independently durable supervisor owns the timeout and a fresh tokenized
heartbeat. The active attempt records its PID/PGID before the supervisor is
authorized to start Codex. If the dispatcher dies, the supervisor still enforces
TERM then KILL; stale-lock recovery verifies the live heartbeat before signaling
and commits a failed receipt for the abandoned attempt.

At terminal completion, tracked changes are archived as
`worktree-archive/tracked.patch` and untracked files under
`worktree-archive/untracked/` in the private dispatch directory. A manifest and
the whole archive publish in one atomic directory rename, so abandoned-attempt
recovery can retry without destroying or colliding with preserved work. Only
after the archive succeeds does Doctor remove and prune the isolated worktree.
An archival failure leaves the worktree intact and marks the attempt failed.

Every attempt preserves:

- `agent-events.jsonl`: Codex JSONL event stream, including partial output
- `final-output.md`: final agent message when produced
- `agent-stderr.log`: process diagnostics
- `attempt.json`: durable active-attempt marker, updated once with the owned PID/PGID
- `receipt.json`: immutable command, timing, exit, artifact paths, and post-run
  policy state

Incident evidence, JSONL, final output, stderr, and persisted errors are
secret-pattern redacted. Codex receives only a minimal allowlisted environment;
provider keys, database URLs, and unrelated process variables are not inherited.
The raw final-output and supervisor control files live inside the private
dispatch directory. The raw file is removed after its redacted projection is
written or any process/output error is handled.

The terminal receipt atomically commits both completion and the post-run policy
transition. `runtime-state.json` is a replaceable projection reconciled from the
newest receipt, so a crash cannot leave a successful incident suppressed behind
stale circuit-breaker state.

The prompt permits local diagnosis, patches, and tests. It forbids deployment,
external-service mutations, canonical-data rewrites, external messages, and
manufactured success.

## Safety policy

Defaults:

- timeout: 15 minutes
- cooldown: 1 hour
- daily budget: 2 agent starts per UTC day
- circuit breaker: opens for 24 hours after 3 consecutive failed/timed-out starts
- concurrency: one dispatcher lock, with stale-lock recovery after timeout plus
  1 minute

Dispatcher and fingerprint locks are durable owner leases. Release only marks
the caller's unique owner record; it never deletes the canonical successor lock.
Stale takeover is exclusive, and an old holder cannot release a replacement.

Override only with positive integer environment values:

```text
JOBSRADAR_DOCTOR_TIMEOUT_MS
JOBSRADAR_DOCTOR_COOLDOWN_MS
JOBSRADAR_DOCTOR_MAX_RUNS_PER_DAY
JOBSRADAR_DOCTOR_CIRCUIT_FAILURE_THRESHOLD
JOBSRADAR_DOCTOR_CIRCUIT_OPEN_MS
JOBSRADAR_DOCTOR_SPOOL
JOBSRADAR_DOCTOR_CODEX_PATH
JOBSRADAR_DOCTOR_GIT_PATH
```

Executable paths must be absolute. The interactive CLI resolves them from the
current local installation. The launchd renderer persists the exact absolute
Codex, Git, and Bun paths into the periodic 15-minute agent. The template is
integrated with `scripts/install-jobsradar-launchd.sh doctor`, but is not
installed merely by merging these files.

The Doctor never changes the ingest exit status from failure to success. A
Doctor launch/spool failure is printed as an additional failure, and the
immutable incident remains recoverable with `run-pending`.
