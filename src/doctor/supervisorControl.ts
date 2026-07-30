import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, ok, type Result } from "./result";

/** Durable identity for the independently supervised Doctor process group. */
export interface DoctorProcessIdentity {
  readonly token: string;
  readonly pid: number;
  readonly pgid: number;
  readonly controlDirectory: string;
}

interface SupervisorHeartbeat {
  readonly token: string;
  readonly pid: number;
  readonly pgid: number;
  readonly updatedAt: string;
}

export interface DoctorSupervisorChildResult {
  readonly schemaVersion: 1;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly closedAt: string;
}

export class DoctorSupervisorError extends Error {
  readonly _tag = "DoctorSupervisorError" as const;

  constructor(
    readonly operation: "identify" | "start" | "terminate" | "read_result",
    override readonly cause: unknown,
  ) {
    super(
      `Doctor supervisor ${operation} failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
  }
}

function parseChildResult(text: string): DoctorSupervisorChildResult {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("schemaVersion" in value) ||
    value.schemaVersion !== 1 ||
    !("exitCode" in value) ||
    !(
      value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isSafeInteger(value.exitCode))
    ) ||
    !("signal" in value) ||
    !(value.signal === null || typeof value.signal === "string") ||
    !("closedAt" in value) ||
    typeof value.closedAt !== "string" ||
    !Number.isFinite(new Date(value.closedAt).getTime())
  ) {
    throw new Error("Supervisor child result is invalid");
  }
  return value as DoctorSupervisorChildResult;
}

/** Read the direct Codex child's durable result after the supervisor reaps its whole group. */
export async function readDoctorSupervisorChildResult(
  controlDirectory: string,
): Promise<Result<DoctorSupervisorChildResult | null, DoctorSupervisorError>> {
  try {
    return ok(
      await readFile(join(controlDirectory, "child-result.json"), "utf8").then(parseChildResult),
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ok(null);
    return err(new DoctorSupervisorError("read_result", error));
  }
}

function parseHeartbeat(text: string): SupervisorHeartbeat {
  const value: unknown = JSON.parse(text);
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("token" in value) ||
    typeof value.token !== "string" ||
    !("pid" in value) ||
    typeof value.pid !== "number" ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    !("pgid" in value) ||
    typeof value.pgid !== "number" ||
    !Number.isSafeInteger(value.pgid) ||
    value.pgid <= 0 ||
    !("updatedAt" in value) ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(new Date(value.updatedAt).getTime())
  ) {
    throw new Error("Supervisor heartbeat is invalid");
  }
  return value as SupervisorHeartbeat;
}

/** Discover a live supervisor from its fresh, unguessable heartbeat. */
export async function discoverDoctorProcessIdentity(
  token: string,
  controlDirectory: string,
): Promise<Result<DoctorProcessIdentity | null, DoctorSupervisorError>> {
  const heartbeatPath = join(controlDirectory, "heartbeat.json");
  try {
    const [heartbeat, metadata] = await Promise.all([
      readFile(heartbeatPath, "utf8").then(parseHeartbeat),
      stat(heartbeatPath),
    ]);
    if (heartbeat.token !== token) {
      return err(
        new DoctorSupervisorError(
          "identify",
          new Error("Supervisor heartbeat token does not match the durable attempt"),
        ),
      );
    }
    if (
      Date.now() - metadata.mtimeMs > 2_000 ||
      Date.now() - new Date(heartbeat.updatedAt).getTime() > 2_000
    ) {
      try {
        process.kill(heartbeat.pid, 0);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ESRCH") return ok(null);
        throw error;
      }
      return err(
        new DoctorSupervisorError(
          "identify",
          new Error("Supervisor heartbeat is stale while its recorded PID is live"),
        ),
      );
    }
    return ok({
      token,
      pid: heartbeat.pid,
      pgid: heartbeat.pgid,
      controlDirectory,
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return ok(null);
    return err(new DoctorSupervisorError("identify", error));
  }
}

/** Prove that the heartbeat still owns the recorded PID and PGID. */
export async function verifyDoctorProcessIdentity(
  identity: DoctorProcessIdentity,
): Promise<Result<void, DoctorSupervisorError>> {
  const first = await discoverDoctorProcessIdentity(identity.token, identity.controlDirectory);
  if (first._tag === "err") return first;
  if (
    first.value === null ||
    first.value.pid !== identity.pid ||
    first.value.pgid !== identity.pgid
  ) {
    return err(
      new DoctorSupervisorError(
        "identify",
        new Error("Supervisor identity did not match the durable attempt"),
      ),
    );
  }
  const firstMetadata = await stat(join(identity.controlDirectory, "heartbeat.json")).catch(
    () => null,
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const second = await discoverDoctorProcessIdentity(identity.token, identity.controlDirectory);
  if (second._tag === "err") return second;
  const secondMetadata = await stat(join(identity.controlDirectory, "heartbeat.json")).catch(
    () => null,
  );
  if (
    second.value === null ||
    second.value.pid !== identity.pid ||
    second.value.pgid !== identity.pgid ||
    firstMetadata === null ||
    secondMetadata === null ||
    secondMetadata.mtimeMs <= firstMetadata.mtimeMs
  ) {
    return err(
      new DoctorSupervisorError(
        "identify",
        new Error("Supervisor heartbeat did not advance under the recorded identity"),
      ),
    );
  }
  return ok(undefined);
}

/** Authorize the durable supervisor to start the one fixed Codex command. */
export async function startDoctorSupervisor(
  identity: DoctorProcessIdentity,
): Promise<Result<void, DoctorSupervisorError>> {
  const verified = await verifyDoctorProcessIdentity(identity);
  if (verified._tag === "err") return verified;
  try {
    await mkdir(identity.controlDirectory, { recursive: true });
    await writeFile(join(identity.controlDirectory, "start"), `${identity.token}\n`, {
      flag: "wx",
    });
    return ok(undefined);
  } catch (error) {
    return err(new DoctorSupervisorError("start", error));
  }
}

/** Verify, TERM, then unconditionally KILL the recorded owned process group. */
export async function terminateVerifiedDoctorProcessGroup(
  identity: DoctorProcessIdentity,
  graceMs: number,
): Promise<Result<void, DoctorSupervisorError>> {
  const verified = await verifyDoctorProcessIdentity(identity);
  if (verified._tag === "err") return verified;
  try {
    try {
      process.kill(-identity.pgid, "SIGTERM");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, graceMs));
    try {
      process.kill(-identity.pgid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
    return ok(undefined);
  } catch (error) {
    return err(new DoctorSupervisorError("terminate", error));
  }
}

/**
 * Prove no process remains in a persisted group when its token heartbeat is gone.
 *
 * A live group without current ownership proof is never signaled: the PGID may
 * have been reused, so recovery must fail closed.
 */
export async function proveRecordedDoctorProcessGroupAbsent(
  pgid: number,
): Promise<Result<void, DoctorSupervisorError>> {
  try {
    try {
      process.kill(-pgid, 0);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ESRCH") return ok(undefined);
      throw error;
    }
    return err(
      new DoctorSupervisorError(
        "identify",
        new Error(
          `Recorded Doctor PGID ${pgid} is still live without a current token heartbeat; refusing to signal or dispatch`,
        ),
      ),
    );
  } catch (error) {
    return err(new DoctorSupervisorError("identify", error));
  }
}
