import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { z } from "zod";
import { type AgentProcessInput, type AgentProcessReceipt, runAgentProcess } from "./agentProcess";
import {
  createIsolatedDoctorWorktree,
  doctorAgentEnvironment,
  resolveRepoHead,
} from "./gitWorktree";
import { err, ok, type Result } from "./result";
import {
  attachDoctorIncidentRepoHead,
  createDoctorDispatchArtifacts,
  type DoctorDispatchReceipt,
  type DoctorIncident,
  type DoctorRuntimeState,
  type DoctorSpoolError,
  doctorSpoolPaths,
  finalizeDoctorDispatch,
  listActiveDoctorDispatchAttempts,
  listPendingDoctorIncidents,
  readDoctorRuntimeState,
  recoverDoctorRawFinalOutput,
  updateDoctorDispatchProcessIdentity,
  writeDoctorDispatchAttempt,
  writeDoctorRuntimeState,
} from "./spool";
import {
  discoverDoctorProcessIdentity,
  proveRecordedDoctorProcessGroupAbsent,
  terminateVerifiedDoctorProcessGroup,
} from "./supervisorControl";

/** Parsed policy and command configuration for the Doctor dispatcher. */
export interface DoctorDispatcherConfig {
  readonly repoRoot: string;
  readonly spoolRoot: string;
  readonly agentExecutable: string;
  readonly gitExecutable: string;
  readonly timeoutMs: number;
  readonly cooldownMs: number;
  readonly maxRunsPerDay: number;
  readonly circuitFailureThreshold: number;
  readonly circuitOpenMs: number;
}

/** Clock used by the dispatcher application service. */
export interface DoctorClock {
  /** Return the current time. */
  now(): Date;
}

/** Port for the single explicit local agent process. */
export interface DoctorAgent {
  /** Run one bounded local agent command. */
  run(input: AgentProcessInput): Promise<Result<AgentProcessReceipt, Error>>;
}

/** Port which isolates workspace-write from the user's checkout. */
export interface DoctorWorktree {
  /** Create a detached worktree at the incident commit. */
  create(
    repoRoot: string,
    dispatchId: string,
    repoHead: string,
    gitExecutable: string,
    environment: NodeJS.ProcessEnv,
  ): Promise<Result<string, Error>>;
}

/** Terminal outcome of a run-pending dispatcher invocation. */
export type DoctorDispatchOutcome =
  | { readonly _tag: "no_pending" }
  | { readonly _tag: "busy" }
  | {
      readonly _tag: "deferred";
      readonly reason: "cooldown" | "daily_budget" | "circuit_open";
      readonly nextEligibleAt: string | null;
    }
  | {
      readonly _tag: "dispatched";
      readonly receipt: DoctorDispatchReceipt;
    };

/** Expected dispatcher failure. */
export class DoctorDispatchError extends Error {
  readonly _tag = "DoctorDispatchError" as const;

  constructor(
    readonly operation:
      | "lock"
      | "read_pending"
      | "read_state"
      | "write_state"
      | "create_artifacts"
      | "read_incident"
      | "agent"
      | "write_receipt",
    override readonly cause: unknown,
  ) {
    super(
      `Doctor dispatch ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

const systemClock: DoctorClock = {
  now: () => new Date(),
};

const localAgent: DoctorAgent = {
  run: runAgentProcess,
};

const localWorktree: DoctorWorktree = {
  create: createIsolatedDoctorWorktree,
};

function dateKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): Result<number, DoctorDispatchError> {
  if (value === undefined || value === "") return ok(fallback);
  if (!/^[1-9]\d*$/.test(value)) {
    return err(
      new DoctorDispatchError("read_state", new Error(`${name} must be a positive integer`)),
    );
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return err(
      new DoctorDispatchError("read_state", new Error(`${name} must be a safe positive integer`)),
    );
  }
  return ok(parsed);
}

/**
 * Parse Doctor dispatcher configuration once at the composition root.
 *
 * @param repoRoot - Jobsradar repository root.
 * @param environment - Process environment.
 * @returns Parsed bounded configuration.
 */
export function parseDoctorDispatcherConfig(
  repoRoot: string,
  environment: NodeJS.ProcessEnv,
): Result<DoctorDispatcherConfig, DoctorDispatchError> {
  const timeoutMs = parsePositiveInteger(
    environment.JOBSRADAR_DOCTOR_TIMEOUT_MS,
    "JOBSRADAR_DOCTOR_TIMEOUT_MS",
    15 * 60_000,
  );
  if (timeoutMs._tag === "err") return timeoutMs;
  const cooldownMs = parsePositiveInteger(
    environment.JOBSRADAR_DOCTOR_COOLDOWN_MS,
    "JOBSRADAR_DOCTOR_COOLDOWN_MS",
    60 * 60_000,
  );
  if (cooldownMs._tag === "err") return cooldownMs;
  const maxRunsPerDay = parsePositiveInteger(
    environment.JOBSRADAR_DOCTOR_MAX_RUNS_PER_DAY,
    "JOBSRADAR_DOCTOR_MAX_RUNS_PER_DAY",
    2,
  );
  if (maxRunsPerDay._tag === "err") return maxRunsPerDay;
  const circuitFailureThreshold = parsePositiveInteger(
    environment.JOBSRADAR_DOCTOR_CIRCUIT_FAILURE_THRESHOLD,
    "JOBSRADAR_DOCTOR_CIRCUIT_FAILURE_THRESHOLD",
    3,
  );
  if (circuitFailureThreshold._tag === "err") return circuitFailureThreshold;
  const circuitOpenMs = parsePositiveInteger(
    environment.JOBSRADAR_DOCTOR_CIRCUIT_OPEN_MS,
    "JOBSRADAR_DOCTOR_CIRCUIT_OPEN_MS",
    24 * 60 * 60_000,
  );
  if (circuitOpenMs._tag === "err") return circuitOpenMs;
  const agentExecutable = environment.JOBSRADAR_DOCTOR_CODEX_PATH;
  const gitExecutable = environment.JOBSRADAR_DOCTOR_GIT_PATH;
  if (!agentExecutable || !isAbsolute(agentExecutable)) {
    return err(
      new DoctorDispatchError(
        "read_state",
        new Error("JOBSRADAR_DOCTOR_CODEX_PATH must be an absolute executable path"),
      ),
    );
  }
  if (!gitExecutable || !isAbsolute(gitExecutable)) {
    return err(
      new DoctorDispatchError(
        "read_state",
        new Error("JOBSRADAR_DOCTOR_GIT_PATH must be an absolute executable path"),
      ),
    );
  }
  return ok({
    repoRoot,
    spoolRoot: environment.JOBSRADAR_DOCTOR_SPOOL ?? join(repoRoot, "logs", "doctor"),
    agentExecutable,
    gitExecutable,
    timeoutMs: timeoutMs.value,
    cooldownMs: cooldownMs.value,
    maxRunsPerDay: maxRunsPerDay.value,
    circuitFailureThreshold: circuitFailureThreshold.value,
    circuitOpenMs: circuitOpenMs.value,
  });
}

function buildPrompt(incident: DoctorIncident): string {
  return `You are the jobsradar token Doctor. Diagnose this immutable incident and, only when evidence supports it, prepare local code/config patches and tests in the current repository.

Hard limits:
- Do not deploy or mutate any external service.
- Do not rewrite canonical ingest data, database state, or evidence artifacts.
- Do not submit applications, send messages, or perform external writes.
- Preserve the ingest failure as a failure; never manufacture success.
- Work only in the current repository with workspace-write permissions.
- Run relevant local tests. End with a concise diagnosis, changed files, test results, and unresolved limits.

Incident:
${JSON.stringify(incident, null, 2)}
`;
}

function codexCommand(
  config: DoctorDispatcherConfig,
  finalOutputPath: string,
  worktreePath: string,
): ReadonlyArray<string> {
  return [
    config.agentExecutable,
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    worktreePath,
    "--output-last-message",
    finalOutputPath,
    "-",
  ];
}

function policyDecision(
  config: DoctorDispatcherConfig,
  state: DoctorRuntimeState,
  now: Date,
): DoctorDispatchOutcome | null {
  if (state.runsToday >= config.maxRunsPerDay) {
    return {
      _tag: "deferred",
      reason: "daily_budget",
      nextEligibleAt: new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
      ).toISOString(),
    };
  }
  if (state.circuitOpenedAt) {
    const reopenAt = new Date(state.circuitOpenedAt).getTime() + config.circuitOpenMs;
    if (reopenAt > now.getTime()) {
      return {
        _tag: "deferred",
        reason: "circuit_open",
        nextEligibleAt: new Date(reopenAt).toISOString(),
      };
    }
  }
  if (state.lastStartedAt) {
    const eligibleAt = new Date(state.lastStartedAt).getTime() + config.cooldownMs;
    if (eligibleAt > now.getTime()) {
      return {
        _tag: "deferred",
        reason: "cooldown",
        nextEligibleAt: new Date(eligibleAt).toISOString(),
      };
    }
  }
  return null;
}

const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive(),
    acquiredAt: z.string().datetime(),
  })
  .strict();

export interface DoctorDispatcherLease {
  readonly token: string;
  readonly ownerDirectory: string;
  readonly heartbeat: ReturnType<typeof setInterval> | null;
}

async function fileExists(path: string): Promise<boolean> {
  return stat(path)
    .then(() => true)
    .catch((error) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    });
}

async function writeDispatcherHeartbeat(ownerDirectory: string, token: string): Promise<void> {
  const path = join(ownerDirectory, "heartbeat");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${token} ${new Date().toISOString()}\n`);
  await rename(temporary, path);
}

function activateDispatcherLease(lease: DoctorDispatcherLease): DoctorDispatcherLease {
  const heartbeat = setInterval(() => {
    void writeDispatcherHeartbeat(lease.ownerDirectory, lease.token).catch(() => undefined);
  }, 250);
  heartbeat.unref();
  return { ...lease, heartbeat };
}

function pidIsLive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    return true;
  }
}

async function acquireOwnedTakeover(
  takeoverDirectory: string,
  token: string,
  now: Date,
  staleAfterMs: number,
): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mkdir(takeoverDirectory);
      await writeFile(
        join(takeoverDirectory, "owner.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          token,
          pid: process.pid,
          acquiredAt: now.toISOString(),
        })}\n`,
        { flag: "wx" },
      );
      await writeDispatcherHeartbeat(takeoverDirectory, token);
      return true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const ownerPath = join(takeoverDirectory, "owner.json");
    const owner = await readFile(ownerPath, "utf8")
      .then((text) => lockOwnerSchema.parse(JSON.parse(text)))
      .catch(() => null);
    const heartbeatAt = await stat(join(takeoverDirectory, "heartbeat"))
      .then((metadata) => metadata.mtimeMs)
      .catch(async () =>
        owner === null
          ? (await stat(takeoverDirectory)).mtimeMs
          : new Date(owner.acquiredAt).getTime(),
      );
    if (now.getTime() - heartbeatAt <= staleAfterMs || (owner !== null && pidIsLive(owner.pid)))
      return false;
    try {
      await rename(takeoverDirectory, `${takeoverDirectory}.stale-${randomUUID()}`);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return false;
}

async function ownsTakeover(takeoverDirectory: string, token: string): Promise<boolean> {
  return readFile(join(takeoverDirectory, "owner.json"), "utf8")
    .then((text) => lockOwnerSchema.parse(JSON.parse(text)).token === token)
    .catch(() => false);
}

async function reconcileAbandonedAttempts(
  config: DoctorDispatcherConfig,
  now: Date,
): Promise<Result<void, DoctorDispatchError>> {
  const active = await listActiveDoctorDispatchAttempts(config.spoolRoot);
  if (active._tag === "err") return err(new DoctorDispatchError("read_pending", active.error));
  for (const item of active.value) {
    const discovered = await discoverDoctorProcessIdentity(
      item.attempt.processToken,
      item.attempt.supervisorControlDirectory,
    );
    if (discovered._tag === "err") return err(new DoctorDispatchError("lock", discovered.error));
    if (discovered.value === null && item.attempt.pid !== null) {
      try {
        process.kill(item.attempt.pid, 0);
        return err(
          new DoctorDispatchError(
            "lock",
            new Error("Cannot prove the recorded Doctor process group has exited"),
          ),
        );
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
          return err(new DoctorDispatchError("lock", error));
        }
      }
    }
    if (discovered.value) {
      if (
        (item.attempt.pid !== null && item.attempt.pid !== discovered.value.pid) ||
        (item.attempt.pgid !== null && item.attempt.pgid !== discovered.value.pgid)
      ) {
        return err(
          new DoctorDispatchError(
            "lock",
            new Error("Live supervisor identity conflicts with its durable attempt"),
          ),
        );
      }
      const terminated = await terminateVerifiedDoctorProcessGroup(
        discovered.value,
        Math.min(5_000, config.timeoutMs),
      );
      if (terminated._tag === "err") return err(new DoctorDispatchError("lock", terminated.error));
    } else if (item.attempt.pgid !== null) {
      const absent = await proveRecordedDoctorProcessGroupAbsent(item.attempt.pgid);
      if (absent._tag === "err") return err(new DoctorDispatchError("lock", absent.error));
    }
    const recoveredRaw = await recoverDoctorRawFinalOutput(item.attempt);
    if (recoveredRaw._tag === "err")
      return err(new DoctorDispatchError("write_receipt", recoveredRaw.error));
    const receipt: DoctorDispatchReceipt = {
      schemaVersion: 1,
      dispatchId: item.attempt.dispatchId,
      incidentId: item.attempt.incidentId,
      fingerprint: item.attempt.fingerprint,
      startedAt: item.attempt.startedAt,
      finishedAt: now.toISOString(),
      status: "failed",
      exitCode: null,
      signal: null,
      error: discovered.value
        ? "Recovered and terminated an orphaned Doctor process group"
        : "Recovered an abandoned Doctor attempt with no live owned process group",
      command: item.attempt.command,
      eventsPath: item.attempt.eventsPath,
      finalOutputPath: item.attempt.finalOutputPath,
      stderrPath: item.attempt.stderrPath,
      worktreePath: item.attempt.worktreePath,
      policyStateAfter: updatedState(
        config,
        item.attempt.policyStateReserved,
        new Date(item.attempt.startedAt),
        "failed",
      ),
    };
    const finalized = await finalizeDoctorDispatch(
      config.spoolRoot,
      join(dirname(item.path), "receipt.json"),
      receipt,
    );
    if (finalized._tag === "err")
      return err(new DoctorDispatchError("write_receipt", finalized.error));
    await rm(item.attempt.supervisorControlDirectory, { recursive: true, force: true });
  }
  return ok(undefined);
}

export async function acquireDoctorDispatcherLock(
  config: DoctorDispatcherConfig,
  now: Date,
): Promise<Result<DoctorDispatcherLease | "busy", DoctorDispatchError>> {
  const paths = doctorSpoolPaths(config.spoolRoot);
  const token = randomUUID();
  const ownerDirectory = join(paths.lockOwners, token);
  const ownerPath = join(ownerDirectory, "owner.json");
  const candidate: DoctorDispatcherLease = { token, ownerDirectory, heartbeat: null };
  try {
    await mkdir(paths.lockOwners, { recursive: true });
    await mkdir(ownerDirectory, { recursive: true });
    await writeFile(
      ownerPath,
      `${JSON.stringify({
        schemaVersion: 1,
        token,
        pid: process.pid,
        acquiredAt: now.toISOString(),
      })}\n`,
      { flag: "wx" },
    );
    await writeDispatcherHeartbeat(ownerDirectory, token);
    try {
      await link(ownerPath, paths.lock);
      const reconciled = await reconcileAbandonedAttempts(config, now);
      if (reconciled._tag === "err") {
        await releaseDoctorDispatcherLock(candidate);
        return reconciled;
      }
      return ok(activateDispatcherLease(candidate));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const existing = lockOwnerSchema.parse(JSON.parse(await readFile(paths.lock, "utf8")));
    const existingDirectory = join(paths.lockOwners, existing.token);
    const released = await fileExists(join(existingDirectory, "released"));
    const heartbeatAge = await stat(join(existingDirectory, "heartbeat"))
      .then((metadata) => now.getTime() - metadata.mtimeMs)
      .catch(() => Number.POSITIVE_INFINITY);
    const stale = heartbeatAge > config.timeoutMs + 60_000 && !pidIsLive(existing.pid);
    if (!released && !stale) {
      await rm(ownerDirectory, { recursive: true, force: true });
      return ok("busy");
    }
    const takeover = join(existingDirectory, "takeover");
    if (!(await acquireOwnedTakeover(takeover, token, now, config.timeoutMs + 60_000))) {
      await rm(ownerDirectory, { recursive: true, force: true });
      return ok("busy");
    }
    const current = lockOwnerSchema.parse(JSON.parse(await readFile(paths.lock, "utf8")));
    if (current.token !== existing.token || !(await ownsTakeover(takeover, token))) {
      await rm(ownerDirectory, { recursive: true, force: true });
      return ok("busy");
    }
    if (stale) {
      const reconciled = await reconcileAbandonedAttempts(config, now);
      if (reconciled._tag === "err") {
        if (await ownsTakeover(takeover, token)) {
          await rm(takeover, { recursive: true, force: true });
        }
        await rm(ownerDirectory, { recursive: true, force: true });
        return reconciled;
      }
    }
    await unlink(paths.lock);
    try {
      await link(ownerPath, paths.lock);
      const reconciled = await reconcileAbandonedAttempts(config, now);
      if (reconciled._tag === "err") {
        await releaseDoctorDispatcherLock(candidate);
        return reconciled;
      }
      return ok(activateDispatcherLease(candidate));
    } catch (error) {
      await rm(ownerDirectory, { recursive: true, force: true });
      if (error instanceof Error && "code" in error && error.code === "EEXIST") return ok("busy");
      throw error;
    }
  } catch (error) {
    return err(new DoctorDispatchError("lock", error));
  }
}

export async function releaseDoctorDispatcherLock(lease: DoctorDispatcherLease): Promise<void> {
  if (lease.heartbeat !== null) clearInterval(lease.heartbeat);
  await writeFile(join(lease.ownerDirectory, "released"), `${lease.token}\n`, {
    flag: "wx",
  }).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
}

async function assertDoctorDispatcherLease(
  config: DoctorDispatcherConfig,
  lease: DoctorDispatcherLease,
): Promise<Result<void, DoctorDispatchError>> {
  const paths = doctorSpoolPaths(config.spoolRoot);
  try {
    const current = lockOwnerSchema.parse(JSON.parse(await readFile(paths.lock, "utf8")));
    if (current.token !== lease.token) throw new Error("Dispatcher lease ownership was lost");
    if (await fileExists(join(lease.ownerDirectory, "released"))) {
      throw new Error("Dispatcher lease was already released");
    }
    await writeDispatcherHeartbeat(lease.ownerDirectory, lease.token);
    const revalidated = lockOwnerSchema.parse(JSON.parse(await readFile(paths.lock, "utf8")));
    if (revalidated.token !== lease.token) {
      throw new Error("Dispatcher lease changed during renewal");
    }
    return ok(undefined);
  } catch (error) {
    return err(new DoctorDispatchError("lock", error));
  }
}

function updatedState(
  config: DoctorDispatcherConfig,
  reserved: DoctorRuntimeState,
  startedAt: Date,
  status: AgentProcessReceipt["status"],
): DoctorRuntimeState {
  const consecutiveFailures = status === "complete" ? 0 : reserved.consecutiveFailures + 1;
  return {
    schemaVersion: 1,
    dateKey: dateKey(startedAt),
    runsToday: reserved.runsToday,
    consecutiveFailures,
    lastStartedAt: reserved.lastStartedAt,
    circuitOpenedAt:
      consecutiveFailures >= config.circuitFailureThreshold
        ? startedAt.toISOString()
        : status === "complete"
          ? null
          : reserved.circuitOpenedAt,
  };
}

/**
 * Dispatch at most one pending incident through exactly one local Codex command.
 *
 * @param config - Parsed dispatcher policy.
 * @param dependencies - Explicit clock and agent ports for real-seam testing.
 * @returns A typed terminal dispatch outcome.
 */
export async function runPendingDoctor(
  config: DoctorDispatcherConfig,
  dependencies: {
    readonly clock?: DoctorClock;
    readonly agent?: DoctorAgent;
    readonly worktree?: DoctorWorktree;
  } = {},
): Promise<Result<DoctorDispatchOutcome, DoctorDispatchError>> {
  const clock = dependencies.clock ?? systemClock;
  const agent = dependencies.agent ?? localAgent;
  const worktreePort = dependencies.worktree ?? localWorktree;
  const lock = await acquireDoctorDispatcherLock(config, clock.now());
  if (lock._tag === "err") return lock;
  if (lock.value === "busy") return ok({ _tag: "busy" });
  const lease = lock.value;
  try {
    const pending = await listPendingDoctorIncidents(config.spoolRoot);
    if (pending._tag === "err") return err(new DoctorDispatchError("read_pending", pending.error));
    const next = pending.value[0];
    if (!next) return ok({ _tag: "no_pending" });

    const startedAt = clock.now();
    const state = await readDoctorRuntimeState(config.spoolRoot, dateKey(startedAt));
    if (state._tag === "err") return err(new DoctorDispatchError("read_state", state.error));
    const deferred = policyDecision(config, state.value, startedAt);
    if (deferred) return ok(deferred);
    let repoHead = next.incident.repoHead;
    if (repoHead === null) {
      const resolved = await resolveRepoHead(config.repoRoot, config.gitExecutable, process.env);
      if (resolved._tag === "err")
        return err(new DoctorDispatchError("create_artifacts", resolved.error));
      const ownership = await assertDoctorDispatcherLease(config, lease);
      if (ownership._tag === "err") return ownership;
      const attached = await attachDoctorIncidentRepoHead(
        config.spoolRoot,
        next.path,
        next.incident.fingerprint,
        resolved.value,
      );
      if (attached._tag === "err")
        return err(new DoctorDispatchError("create_artifacts", attached.error));
      repoHead = resolved.value;
    }

    let ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const artifacts = await createDoctorDispatchArtifacts(config.spoolRoot, startedAt);
    if (artifacts._tag === "err")
      return err(new DoctorDispatchError("create_artifacts", artifacts.error));
    ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const worktree = await worktreePort.create(
      config.repoRoot,
      artifacts.value.dispatchId,
      repoHead,
      config.gitExecutable,
      process.env,
    );
    if (worktree._tag === "err")
      return err(new DoctorDispatchError("create_artifacts", worktree.error));
    const reservedState: DoctorRuntimeState = {
      ...state.value,
      dateKey: dateKey(startedAt),
      runsToday: state.value.runsToday + 1,
      lastStartedAt: startedAt.toISOString(),
    };
    ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const persistedReservation = await writeDoctorRuntimeState(config.spoolRoot, reservedState);
    if (persistedReservation._tag === "err")
      return err(new DoctorDispatchError("write_state", persistedReservation.error));
    const command = codexCommand(config, artifacts.value.rawFinalOutputPath, worktree.value);
    const processToken = randomUUID();
    const supervisorControlDirectory = join("/tmp", `jobsradar-doctor-${processToken}`);
    ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const persistedAttempt = await writeDoctorDispatchAttempt(
      config.spoolRoot,
      artifacts.value.attemptPath,
      {
        schemaVersion: 1,
        dispatchId: artifacts.value.dispatchId,
        incidentId: next.incident.incidentId,
        fingerprint: next.incident.fingerprint,
        startedAt: startedAt.toISOString(),
        worktreePath: worktree.value,
        command,
        eventsPath: artifacts.value.eventsPath,
        finalOutputPath: artifacts.value.finalOutputPath,
        rawFinalOutputPath: artifacts.value.rawFinalOutputPath,
        stderrPath: artifacts.value.stderrPath,
        processToken,
        supervisorControlDirectory,
        pid: null,
        pgid: null,
        policyStateReserved: reservedState,
      },
    );
    if (persistedAttempt._tag === "err")
      return err(new DoctorDispatchError("write_receipt", persistedAttempt.error));
    ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const processResult = await agent.run({
      executable: command[0] ?? config.agentExecutable,
      args: command.slice(1),
      cwd: worktree.value,
      prompt: buildPrompt({ ...next.incident, repoHead }),
      timeoutMs: config.timeoutMs,
      eventsPath: artifacts.value.eventsPath,
      finalOutputPath: artifacts.value.finalOutputPath,
      rawFinalOutputPath: artifacts.value.rawFinalOutputPath,
      stderrPath: artifacts.value.stderrPath,
      environment: doctorAgentEnvironment(process.env),
      processToken,
      supervisorControlDirectory,
      onSpawn: async (identity) =>
        updateDoctorDispatchProcessIdentity(
          config.spoolRoot,
          artifacts.value.attemptPath,
          next.incident.fingerprint,
          identity.token,
          identity.pid,
          identity.pgid,
        ),
    });
    const finishedAt = clock.now();
    const processReceipt: AgentProcessReceipt =
      processResult._tag === "ok"
        ? processResult.value
        : {
            status: "failed",
            exitCode: null,
            signal: null,
            error: processResult.error.message,
          };
    const receipt: DoctorDispatchReceipt = {
      schemaVersion: 1,
      dispatchId: artifacts.value.dispatchId,
      incidentId: next.incident.incidentId,
      fingerprint: next.incident.fingerprint,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: processReceipt.status,
      exitCode: processReceipt.exitCode,
      signal: processReceipt.signal,
      error: processReceipt.error,
      command,
      eventsPath: artifacts.value.eventsPath,
      finalOutputPath: artifacts.value.finalOutputPath,
      stderrPath: artifacts.value.stderrPath,
      worktreePath: worktree.value,
      policyStateAfter: updatedState(config, reservedState, startedAt, processReceipt.status),
    };
    ownership = await assertDoctorDispatcherLease(config, lease);
    if (ownership._tag === "err") return ownership;
    const persistedReceipt = await finalizeDoctorDispatch(
      config.spoolRoot,
      artifacts.value.receiptPath,
      receipt,
    );
    if (persistedReceipt._tag === "err")
      return err(new DoctorDispatchError("write_receipt", persistedReceipt.error));
    return ok({ _tag: "dispatched", receipt: persistedReceipt.value });
  } finally {
    await releaseDoctorDispatcherLock(lease);
  }
}

/** Snapshot of pending work and current policy state without invoking an agent. */
export interface DoctorStatus {
  readonly pendingCount: number;
  readonly pending: ReadonlyArray<{
    readonly incidentId: string;
    readonly fingerprint: string;
    readonly createdAt: string;
    readonly attempts: number;
  }>;
  readonly state: DoctorRuntimeState;
}

/**
 * Read Doctor spool status without starting a process.
 *
 * @param config - Parsed dispatcher configuration.
 * @param now - Clock value used for the daily state view.
 * @returns Pending incidents and policy counters.
 */
export async function readDoctorStatus(
  config: DoctorDispatcherConfig,
  now: Date,
): Promise<Result<DoctorStatus, DoctorSpoolError>> {
  const [pending, state] = await Promise.all([
    listPendingDoctorIncidents(config.spoolRoot),
    readDoctorRuntimeState(config.spoolRoot, dateKey(now)),
  ]);
  if (pending._tag === "err") return pending;
  if (state._tag === "err") return state;
  return ok({
    pendingCount: pending.value.length,
    pending: pending.value.map((item) => ({
      incidentId: item.incident.incidentId,
      fingerprint: item.incident.fingerprint,
      createdAt: item.incident.createdAt,
      attempts: item.attempts.length,
    })),
    state: state.value,
  });
}
