import { randomUUID } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { projectDoctorRawFinalOutput } from "./finalProjection";
import { type DoctorIncidentDraft, redactDoctorIncidentDraft } from "./incident";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";

/** A persisted immutable Doctor incident. */
export interface DoctorIncident extends DoctorIncidentDraft {
  readonly incidentId: string;
  readonly createdAt: string;
  readonly repoHead: string | null;
}

/** Immutable receipt for one Doctor agent attempt. */
export interface DoctorDispatchReceipt {
  readonly schemaVersion: 1;
  readonly dispatchId: string;
  readonly incidentId: string;
  readonly fingerprint: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly status: "complete" | "failed" | "timed_out";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
  readonly command: ReadonlyArray<string>;
  readonly eventsPath: string;
  readonly finalOutputPath: string;
  readonly stderrPath: string;
  readonly worktreePath: string;
  readonly policyStateAfter: DoctorRuntimeState;
}

/** Durable marker proving an incident is actively being repaired. */
export interface DoctorDispatchAttempt {
  readonly schemaVersion: 1;
  readonly dispatchId: string;
  readonly incidentId: string;
  readonly fingerprint: string;
  readonly startedAt: string;
  readonly worktreePath: string;
  readonly command: ReadonlyArray<string>;
  readonly eventsPath: string;
  readonly finalOutputPath: string;
  readonly rawFinalOutputPath: string;
  readonly stderrPath: string;
  readonly processToken: string;
  readonly supervisorControlDirectory: string;
  readonly pid: number | null;
  readonly pgid: number | null;
  readonly policyStateReserved: DoctorRuntimeState;
}

/** Mutable policy state serialized under the single-dispatcher lock. */
export interface DoctorRuntimeState {
  readonly schemaVersion: 1;
  readonly dateKey: string;
  readonly runsToday: number;
  readonly consecutiveFailures: number;
  readonly lastStartedAt: string | null;
  readonly circuitOpenedAt: string | null;
}

const evidenceSchema = z
  .object({
    source: z.string(),
    status: z.string(),
    message: z.string(),
  })
  .strict();

const incidentSchema: z.ZodType<DoctorIncident> = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.enum(["ingest_result", "ingest_throw"]),
    severity: z.enum(["degraded", "failed"]),
    summary: z.string(),
    evidence: z.array(evidenceSchema),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    incidentId: z.string().min(1),
    createdAt: z.string().datetime(),
    repoHead: z
      .string()
      .regex(/^[0-9a-f]{40}$/i)
      .nullable(),
  })
  .strict();

const runtimeStateSchema: z.ZodType<DoctorRuntimeState> = z
  .object({
    schemaVersion: z.literal(1),
    dateKey: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    runsToday: z.number().int().nonnegative(),
    consecutiveFailures: z.number().int().nonnegative(),
    lastStartedAt: z.string().datetime().nullable(),
    circuitOpenedAt: z.string().datetime().nullable(),
  })
  .strict();

const receiptSchema: z.ZodType<DoctorDispatchReceipt> = z
  .object({
    schemaVersion: z.literal(1),
    dispatchId: z.string().min(1),
    incidentId: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime(),
    status: z.enum(["complete", "failed", "timed_out"]),
    exitCode: z.number().int().nullable(),
    signal: z.string().nullable(),
    error: z.string().nullable(),
    command: z.array(z.string()),
    eventsPath: z.string().min(1),
    finalOutputPath: z.string().min(1),
    stderrPath: z.string().min(1),
    worktreePath: z.string().min(1),
    policyStateAfter: runtimeStateSchema,
  })
  .strict();

const attemptSchema: z.ZodType<DoctorDispatchAttempt> = z
  .object({
    schemaVersion: z.literal(1),
    dispatchId: z.string().min(1),
    incidentId: z.string().min(1),
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    startedAt: z.string().datetime(),
    worktreePath: z.string().min(1),
    command: z.array(z.string()),
    eventsPath: z.string().min(1),
    finalOutputPath: z.string().min(1),
    rawFinalOutputPath: z.string().min(1),
    stderrPath: z.string().min(1),
    processToken: z.string().uuid(),
    supervisorControlDirectory: z.string().min(1),
    pid: z.number().int().positive().nullable(),
    pgid: z.number().int().positive().nullable(),
    policyStateReserved: runtimeStateSchema,
  })
  .strict();

const launcherFailureSchema = z
  .object({
    schemaVersion: z.literal(1),
    createdAt: z.string().datetime(),
    message: z.string(),
  })
  .strict();

const lockOwnerSchema = z
  .object({
    schemaVersion: z.literal(1),
    token: z.string().uuid(),
    pid: z.number().int().positive().nullable().default(null),
    acquiredAt: z.string().datetime(),
  })
  .strict();

/** Paths owned by the Doctor spool. */
export interface DoctorSpoolPaths {
  readonly root: string;
  readonly incidents: string;
  readonly dispatches: string;
  readonly launcherFailures: string;
  readonly recordLocks: string;
  readonly runtimeState: string;
  readonly lock: string;
  readonly lockOwners: string;
}

/** Failure to read or mutate the Doctor spool. */
export class DoctorSpoolError extends Error {
  readonly _tag = "DoctorSpoolError" as const;

  constructor(
    readonly operation: string,
    readonly path: string,
    override readonly cause: unknown,
  ) {
    super(
      `Doctor spool ${operation} failed at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Result of idempotently recording an incident fingerprint. */
export type RecordIncidentOutcome =
  | { readonly _tag: "created"; readonly incident: DoctorIncident; readonly path: string }
  | { readonly _tag: "deduplicated"; readonly incident: DoctorIncident; readonly path: string };

/** A pending incident and the immutable file that contains it. */
export interface PendingDoctorIncident {
  readonly incident: DoctorIncident;
  readonly path: string;
  readonly attempts: ReadonlyArray<DoctorDispatchReceipt>;
}

/** Build all paths for a gitignored Doctor spool root. */
export function doctorSpoolPaths(root: string): DoctorSpoolPaths {
  return {
    root,
    incidents: join(root, "incidents"),
    dispatches: join(root, "dispatches"),
    launcherFailures: join(root, "launcher-failures"),
    recordLocks: join(root, ".record-locks"),
    runtimeState: join(root, "runtime-state.json"),
    lock: join(root, ".dispatcher-lock"),
    lockOwners: join(root, ".dispatcher-lock-owners"),
  };
}

async function ensureDirectories(paths: DoctorSpoolPaths): Promise<void> {
  await Promise.all([
    mkdir(paths.incidents, { recursive: true }),
    mkdir(paths.dispatches, { recursive: true }),
    mkdir(paths.launcherFailures, { recursive: true }),
    mkdir(paths.recordLocks, { recursive: true }),
    mkdir(paths.lockOwners, { recursive: true }),
  ]);
}

export interface FingerprintLockLease {
  readonly token: string;
  readonly ownerDirectory: string;
  readonly heartbeat: ReturnType<typeof setInterval>;
}

async function writeLeaseHeartbeat(ownerDirectory: string, token: string): Promise<void> {
  const path = join(ownerDirectory, "heartbeat");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${token} ${new Date().toISOString()}\n`);
  await rename(temporary, path);
}

function startLeaseHeartbeat(
  ownerDirectory: string,
  token: string,
): ReturnType<typeof setInterval> {
  const heartbeat = setInterval(() => {
    void writeLeaseHeartbeat(ownerDirectory, token).catch(() => undefined);
  }, 250);
  heartbeat.unref();
  return heartbeat;
}

function pidIsLive(pid: number | null): boolean {
  if (pid === null) return false;
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
          acquiredAt: new Date().toISOString(),
        })}\n`,
        { flag: "wx" },
      );
      await writeLeaseHeartbeat(takeoverDirectory, token);
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
    if (
      Date.now() - heartbeatAt <= staleAfterMs ||
      (owner !== null && (owner.pid === null || pidIsLive(owner.pid)))
    )
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

export async function acquireDoctorFingerprintLock(
  paths: DoctorSpoolPaths,
  fingerprint: string,
): Promise<Result<FingerprintLockLease, DoctorSpoolError>> {
  const canonical = join(paths.recordLocks, `${fingerprint}.lock`);
  for (let attempt = 0; attempt < 200; attempt++) {
    const token = randomUUID();
    const ownerDirectory = join(paths.recordLocks, "owners", fingerprint, token);
    const ownerPath = join(ownerDirectory, "owner.json");
    try {
      await mkdir(ownerDirectory, { recursive: true });
      await writeFile(
        ownerPath,
        `${JSON.stringify({
          schemaVersion: 1,
          token,
          pid: process.pid,
          acquiredAt: new Date().toISOString(),
        })}\n`,
        { flag: "wx" },
      );
      await writeLeaseHeartbeat(ownerDirectory, token);
      try {
        await link(ownerPath, canonical);
        return ok({ token, ownerDirectory, heartbeat: startLeaseHeartbeat(ownerDirectory, token) });
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
      const existing = lockOwnerSchema.parse(JSON.parse(await readFile(canonical, "utf8")));
      const existingDirectory = join(paths.recordLocks, "owners", fingerprint, existing.token);
      const released = await stat(join(existingDirectory, "released"))
        .then(() => true)
        .catch((error) => {
          if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
          throw error;
        });
      const heartbeatAge = await stat(join(existingDirectory, "heartbeat"))
        .then((metadata) => Date.now() - metadata.mtimeMs)
        .catch(() => Number.POSITIVE_INFINITY);
      const stale = heartbeatAge > 60_000 && existing.pid !== null && !pidIsLive(existing.pid);
      if (!released && !stale) {
        await rm(ownerDirectory, { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const takeover = join(existingDirectory, "takeover");
      if (!(await acquireOwnedTakeover(takeover, token, 60_000))) {
        await rm(ownerDirectory, { recursive: true, force: true });
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      const current = lockOwnerSchema.parse(JSON.parse(await readFile(canonical, "utf8")));
      if (current.token !== existing.token || !(await ownsTakeover(takeover, token))) {
        await rm(ownerDirectory, { recursive: true, force: true });
        continue;
      }
      await rm(canonical, { force: true });
      try {
        await link(ownerPath, canonical);
        return ok({ token, ownerDirectory, heartbeat: startLeaseHeartbeat(ownerDirectory, token) });
      } catch (error) {
        await rm(ownerDirectory, { recursive: true, force: true });
        if (error instanceof Error && "code" in error && error.code === "EEXIST") continue;
        throw error;
      }
    } catch (error) {
      return err(new DoctorSpoolError("acquire fingerprint lock", canonical, error));
    }
  }
  return err(
    new DoctorSpoolError(
      "acquire fingerprint lock",
      canonical,
      new Error("Timed out waiting for concurrent incident writer"),
    ),
  );
}

export async function releaseDoctorFingerprintLock(lease: FingerprintLockLease): Promise<void> {
  clearInterval(lease.heartbeat);
  await writeFile(join(lease.ownerDirectory, "released"), `${lease.token}\n`, {
    flag: "wx",
  }).catch((error) => {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  });
}

async function assertDoctorFingerprintLock(
  paths: DoctorSpoolPaths,
  fingerprint: string,
  lease: FingerprintLockLease,
): Promise<void> {
  const canonical = join(paths.recordLocks, `${fingerprint}.lock`);
  const current = lockOwnerSchema.parse(JSON.parse(await readFile(canonical, "utf8")));
  if (current.token !== lease.token) throw new Error("Fingerprint lease ownership was lost");
  if (
    await stat(join(lease.ownerDirectory, "released"))
      .then(() => true)
      .catch(() => false)
  ) {
    throw new Error("Fingerprint lease was already released");
  }
  await writeLeaseHeartbeat(lease.ownerDirectory, lease.token);
  const revalidated = lockOwnerSchema.parse(JSON.parse(await readFile(canonical, "utf8")));
  if (revalidated.token !== lease.token)
    throw new Error("Fingerprint lease changed during renewal");
}

function parseIncident(text: string, path: string): DoctorIncident {
  const parsed = incidentSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new Error(`Invalid Doctor incident ${path}: ${parsed.error.message}`);
  return parsed.data;
}

function parseReceipt(text: string, path: string): DoctorDispatchReceipt {
  const parsed = receiptSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`Invalid Doctor dispatch receipt ${path}: ${parsed.error.message}`);
  return parsed.data;
}

function parseAttempt(text: string, path: string): DoctorDispatchAttempt {
  const parsed = attemptSchema.safeParse(JSON.parse(text));
  if (!parsed.success)
    throw new Error(`Invalid Doctor dispatch attempt ${path}: ${parsed.error.message}`);
  return parsed.data;
}

/** Redact any durable raw final output and prove that the raw artifact is gone. */
export async function recoverDoctorRawFinalOutput(
  attempt: DoctorDispatchAttempt,
): Promise<Result<void, DoctorSpoolError>> {
  const projected = await projectDoctorRawFinalOutput(
    attempt.rawFinalOutputPath,
    attempt.finalOutputPath,
  );
  return projected._tag === "ok"
    ? ok(undefined)
    : err(
        new DoctorSpoolError(
          "recover raw final output",
          attempt.rawFinalOutputPath,
          projected.error,
        ),
      );
}

interface DoctorDispatchRecords {
  readonly attempts: ReadonlyArray<DoctorDispatchAttempt>;
  readonly receipts: ReadonlyArray<DoctorDispatchReceipt>;
}

/** Active attempt without a terminal receipt. */
export interface ActiveDoctorDispatchAttempt {
  readonly attempt: DoctorDispatchAttempt;
  readonly path: string;
}

async function readDispatchRecords(paths: DoctorSpoolPaths): Promise<DoctorDispatchRecords> {
  const entries = await readdir(paths.dispatches, { withFileTypes: true });
  const attempts: DoctorDispatchAttempt[] = [];
  const receipts: DoctorDispatchReceipt[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const attemptPath = join(paths.dispatches, entry.name, "attempt.json");
    const receiptPath = join(paths.dispatches, entry.name, "receipt.json");
    try {
      attempts.push(parseAttempt(await readFile(attemptPath, "utf8"), attemptPath));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    try {
      receipts.push(parseReceipt(await readFile(receiptPath, "utf8"), receiptPath));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }
  return { attempts, receipts };
}

/**
 * Record an immutable incident, deduplicated by its stable fingerprint.
 *
 * @param spoolRoot - Gitignored Doctor spool root.
 * @param draft - Classified incident content.
 * @param now - Clock value captured by the CLI boundary.
 * @returns Whether the incident was created or already existed.
 */
export async function recordDoctorIncident(
  spoolRoot: string,
  draft: DoctorIncidentDraft,
  repoHead: string | null,
  now: Date,
): Promise<Result<RecordIncidentOutcome, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  const safeDraft = redactDoctorIncidentDraft(draft);
  const fingerprintDirectory = join(paths.incidents, safeDraft.fingerprint);
  try {
    await ensureDirectories(paths);
    const lock = await acquireDoctorFingerprintLock(paths, safeDraft.fingerprint);
    if (lock._tag === "err") return lock;
    try {
      await mkdir(fingerprintDirectory, { recursive: true });
      const [entries, dispatchRecords] = await Promise.all([
        readdir(fingerprintDirectory, { withFileTypes: true }),
        readDispatchRecords(paths),
      ]);
      const existing: Array<{ readonly incident: DoctorIncident; readonly path: string }> = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const existingPath = join(fingerprintDirectory, entry.name);
        existing.push({
          incident: parseIncident(await readFile(existingPath, "utf8"), existingPath),
          path: existingPath,
        });
      }
      existing.sort((left, right) =>
        right.incident.createdAt.localeCompare(left.incident.createdAt),
      );
      const latest = existing[0];
      if (
        latest &&
        !dispatchRecords.receipts.some(
          (receipt) =>
            receipt.incidentId === latest.incident.incidentId && receipt.status === "complete",
        ) &&
        !dispatchRecords.attempts.some(
          (attempt) =>
            attempt.incidentId === latest.incident.incidentId &&
            !dispatchRecords.receipts.some((receipt) => receipt.dispatchId === attempt.dispatchId),
        )
      ) {
        return ok({ _tag: "deduplicated", incident: latest.incident, path: latest.path });
      }
      const incident: DoctorIncident = {
        ...safeDraft,
        incidentId: `${now.toISOString().replaceAll(/[:.]/g, "-")}-${safeDraft.fingerprint.slice(0, 12)}-${randomUUID()}`,
        createdAt: now.toISOString(),
        repoHead,
      };
      const parsed = incidentSchema.parse(incident);
      const path = join(fingerprintDirectory, `${incident.incidentId}.json`);
      await assertDoctorFingerprintLock(paths, safeDraft.fingerprint, lock.value);
      await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
      return ok({ _tag: "created", incident, path });
    } finally {
      await releaseDoctorFingerprintLock(lock.value);
    }
  } catch (error) {
    return err(new DoctorSpoolError("record incident", fingerprintDirectory, error));
  }
}

/** Atomically enrich a recoverable pre-Git incident with its immutable commit. */
export async function attachDoctorIncidentRepoHead(
  spoolRoot: string,
  path: string,
  fingerprint: string,
  repoHead: string,
): Promise<Result<void, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    const lock = await acquireDoctorFingerprintLock(paths, fingerprint);
    if (lock._tag === "err") return lock;
    try {
      const current = parseIncident(await readFile(path, "utf8"), path);
      if (current.fingerprint !== fingerprint) throw new Error("Incident fingerprint changed");
      if (current.repoHead !== null && current.repoHead !== repoHead) {
        throw new Error("Incident repository HEAD is already immutable");
      }
      if (current.repoHead === null) {
        await assertDoctorFingerprintLock(paths, fingerprint, lock.value);
        await writeAtomicJson(path, incidentSchema.parse({ ...current, repoHead }));
      }
      return ok(undefined);
    } finally {
      await releaseDoctorFingerprintLock(lock.value);
    }
  } catch (error) {
    return err(new DoctorSpoolError("attach incident repository HEAD", path, error));
  }
}

async function readDispatchReceipts(
  paths: DoctorSpoolPaths,
): Promise<ReadonlyArray<DoctorDispatchReceipt>> {
  return (await readDispatchRecords(paths)).receipts;
}

/** Return strictly parsed attempts which do not yet have a terminal receipt. */
export async function listActiveDoctorDispatchAttempts(
  spoolRoot: string,
): Promise<Result<ReadonlyArray<ActiveDoctorDispatchAttempt>, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    await ensureDirectories(paths);
    const records = await readDispatchRecords(paths);
    const receiptIds = new Set(records.receipts.map((receipt) => receipt.dispatchId));
    const active: ActiveDoctorDispatchAttempt[] = [];
    for (const attempt of records.attempts) {
      if (receiptIds.has(attempt.dispatchId)) continue;
      active.push({
        attempt,
        path: join(paths.dispatches, attempt.dispatchId, "attempt.json"),
      });
    }
    active.sort((left, right) => left.attempt.startedAt.localeCompare(right.attempt.startedAt));
    return ok(active);
  } catch (error) {
    return err(new DoctorSpoolError("list active dispatch attempts", paths.dispatches, error));
  }
}

/**
 * Return immutable incidents which have not completed successfully.
 *
 * @param spoolRoot - Doctor spool root.
 * @returns Pending incidents ordered oldest first.
 */
export async function listPendingDoctorIncidents(
  spoolRoot: string,
): Promise<Result<ReadonlyArray<PendingDoctorIncident>, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    await ensureDirectories(paths);
    const [entries, receipts] = await Promise.all([
      readdir(paths.incidents, { withFileTypes: true }),
      readDispatchReceipts(paths),
    ]);
    const pending: PendingDoctorIncident[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fingerprintDirectory = join(paths.incidents, entry.name);
      const incidentEntries = await readdir(fingerprintDirectory, { withFileTypes: true });
      for (const incidentEntry of incidentEntries) {
        if (!incidentEntry.isFile() || !incidentEntry.name.endsWith(".json")) continue;
        const path = join(fingerprintDirectory, incidentEntry.name);
        const incident = parseIncident(await readFile(path, "utf8"), path);
        const attempts = receipts.filter((receipt) => receipt.incidentId === incident.incidentId);
        if (attempts.some((receipt) => receipt.status === "complete")) continue;
        pending.push({ incident, path, attempts });
      }
    }
    pending.sort((left, right) => left.incident.createdAt.localeCompare(right.incident.createdAt));
    return ok(pending);
  } catch (error) {
    return err(new DoctorSpoolError("list pending incidents", paths.root, error));
  }
}

/**
 * Create the immutable directory for one dispatch attempt.
 *
 * @param spoolRoot - Doctor spool root.
 * @param now - Dispatch start time.
 * @returns The dispatch identity and artifact paths.
 */
export async function createDoctorDispatchArtifacts(
  spoolRoot: string,
  now: Date,
): Promise<
  Result<
    {
      readonly dispatchId: string;
      readonly directory: string;
      readonly eventsPath: string;
      readonly finalOutputPath: string;
      readonly rawFinalOutputPath: string;
      readonly stderrPath: string;
      readonly attemptPath: string;
      readonly receiptPath: string;
    },
    DoctorSpoolError
  >
> {
  const paths = doctorSpoolPaths(spoolRoot);
  const dispatchId = `${now.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`;
  const directory = join(paths.dispatches, dispatchId);
  try {
    await ensureDirectories(paths);
    await mkdir(directory);
    return ok({
      dispatchId,
      directory,
      eventsPath: join(directory, "agent-events.jsonl"),
      finalOutputPath: join(directory, "final-output.md"),
      rawFinalOutputPath: join(tmpdir(), `jobsradar-doctor-${dispatchId}-raw-final-output.md`),
      stderrPath: join(directory, "agent-stderr.log"),
      attemptPath: join(directory, "attempt.json"),
      receiptPath: join(directory, "receipt.json"),
    });
  } catch (error) {
    return err(new DoctorSpoolError("create dispatch artifacts", directory, error));
  }
}

async function writeAtomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, path);
}

async function writeAtomicJsonExclusive(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/** Mark an incident as actively being repaired under its fingerprint lock. */
export async function writeDoctorDispatchAttempt(
  spoolRoot: string,
  path: string,
  attempt: DoctorDispatchAttempt,
): Promise<Result<void, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    await ensureDirectories(paths);
    const lock = await acquireDoctorFingerprintLock(paths, attempt.fingerprint);
    if (lock._tag === "err") return lock;
    try {
      await assertDoctorFingerprintLock(paths, attempt.fingerprint, lock.value);
      await writeAtomicJsonExclusive(path, attemptSchema.parse(attempt));
      return ok(undefined);
    } finally {
      await releaseDoctorFingerprintLock(lock.value);
    }
  } catch (error) {
    return err(new DoctorSpoolError("write dispatch attempt", path, error));
  }
}

/** Atomically attach the spawned supervisor PID/PGID to its active attempt. */
export async function updateDoctorDispatchProcessIdentity(
  spoolRoot: string,
  path: string,
  fingerprint: string,
  processToken: string,
  pid: number,
  pgid: number,
): Promise<Result<void, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    const lock = await acquireDoctorFingerprintLock(paths, fingerprint);
    if (lock._tag === "err") return lock;
    try {
      const current = parseAttempt(await readFile(path, "utf8"), path);
      if (current.processToken !== processToken) {
        throw new Error("Attempt process token changed before PID persistence");
      }
      if (
        (current.pid !== null && current.pid !== pid) ||
        (current.pgid !== null && current.pgid !== pgid)
      ) {
        throw new Error("Attempt already belongs to another process group");
      }
      await assertDoctorFingerprintLock(paths, fingerprint, lock.value);
      await writeAtomicJson(path, attemptSchema.parse({ ...current, pid, pgid }));
      return ok(undefined);
    } finally {
      await releaseDoctorFingerprintLock(lock.value);
    }
  } catch (error) {
    return err(new DoctorSpoolError("update dispatch process identity", path, error));
  }
}

/**
 * Atomically commit a terminal receipt and its policy transition.
 *
 * The receipt is authoritative; runtime-state.json is a replaceable projection
 * reconciled from the newest receipt after a crash.
 */
export async function finalizeDoctorDispatch(
  spoolRoot: string,
  path: string,
  receipt: DoctorDispatchReceipt,
): Promise<Result<DoctorDispatchReceipt, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  const safeReceipt: DoctorDispatchReceipt = {
    ...receipt,
    error: receipt.error === null ? null : redactSecrets(receipt.error),
  };
  try {
    await ensureDirectories(paths);
    const lock = await acquireDoctorFingerprintLock(paths, safeReceipt.fingerprint);
    if (lock._tag === "err") return lock;
    try {
      const parsed = receiptSchema.parse(safeReceipt);
      try {
        await assertDoctorFingerprintLock(paths, safeReceipt.fingerprint, lock.value);
        await writeAtomicJsonExclusive(path, parsed);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
        const existing = parseReceipt(await readFile(path, "utf8"), path);
        const projected = await writeDoctorRuntimeState(spoolRoot, existing.policyStateAfter);
        if (projected._tag === "err") return projected;
        return ok(existing);
      }
      const projected = await writeDoctorRuntimeState(spoolRoot, parsed.policyStateAfter);
      if (projected._tag === "err") return projected;
      return ok(parsed);
    } finally {
      await releaseDoctorFingerprintLock(lock.value);
    }
  } catch (error) {
    return err(new DoctorSpoolError("finalize dispatch", path, error));
  }
}

/** Read policy state, returning a safe initial value when no state exists. */
export async function readDoctorRuntimeState(
  spoolRoot: string,
  dateKey: string,
): Promise<Result<DoctorRuntimeState, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  try {
    await ensureDirectories(paths);
    let state: DoctorRuntimeState;
    try {
      const text = await readFile(paths.runtimeState, "utf8");
      state = runtimeStateSchema.parse(JSON.parse(text));
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        state = {
          schemaVersion: 1,
          dateKey,
          runsToday: 0,
          consecutiveFailures: 0,
          lastStartedAt: null,
          circuitOpenedAt: null,
        };
      } else {
        throw error;
      }
    }
    const receipts = await readDispatchReceipts(paths);
    const newestReceipt = [...receipts].sort((left, right) => {
      const timeOrder = right.finishedAt.localeCompare(left.finishedAt);
      return timeOrder === 0 ? right.dispatchId.localeCompare(left.dispatchId) : timeOrder;
    })[0];
    if (
      newestReceipt &&
      (state.lastStartedAt === null ||
        newestReceipt.policyStateAfter.lastStartedAt === state.lastStartedAt ||
        (newestReceipt.policyStateAfter.lastStartedAt !== null &&
          newestReceipt.policyStateAfter.lastStartedAt > state.lastStartedAt))
    ) {
      state = newestReceipt.policyStateAfter;
    }
    return ok(state.dateKey === dateKey ? state : { ...state, dateKey, runsToday: 0 });
  } catch (error) {
    return err(new DoctorSpoolError("read runtime state", paths.runtimeState, error));
  }
}

/** Atomically persist mutable dispatcher policy state. */
export async function writeDoctorRuntimeState(
  spoolRoot: string,
  state: DoctorRuntimeState,
): Promise<Result<void, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  const temporary = `${paths.runtimeState}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(paths.runtimeState), { recursive: true });
    const parsed = runtimeStateSchema.parse(state);
    await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, paths.runtimeState);
    return ok(undefined);
  } catch (error) {
    return err(new DoctorSpoolError("write runtime state", paths.runtimeState, error));
  }
}

/** Record a detached-launch failure as an immutable recoverable spool artifact. */
export async function recordDoctorLauncherFailure(
  spoolRoot: string,
  message: string,
  now: Date,
): Promise<Result<string, DoctorSpoolError>> {
  const paths = doctorSpoolPaths(spoolRoot);
  const path = join(
    paths.launcherFailures,
    `${now.toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}.json`,
  );
  try {
    await ensureDirectories(paths);
    await writeFile(
      path,
      `${JSON.stringify(
        launcherFailureSchema.parse({
          schemaVersion: 1,
          createdAt: now.toISOString(),
          message: redactSecrets(message),
        }),
        null,
        2,
      )}\n`,
      { flag: "wx" },
    );
    return ok(path);
  } catch (error) {
    return err(new DoctorSpoolError("record launcher failure", path, error));
  }
}

/** Read the current dispatcher lock age, or null when unlocked. */
export async function doctorLockAgeMs(
  spoolRoot: string,
  now: Date,
): Promise<Result<number | null, DoctorSpoolError>> {
  const path = doctorSpoolPaths(spoolRoot).lock;
  try {
    const metadata = await stat(path);
    return ok(Math.max(0, now.getTime() - metadata.mtimeMs));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ok(null);
    return err(new DoctorSpoolError("inspect dispatcher lock", path, error));
  }
}
