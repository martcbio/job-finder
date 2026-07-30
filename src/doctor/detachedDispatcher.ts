import { spawn } from "node:child_process";
import { doctorAgentEnvironment } from "./gitWorktree";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";
import { recordDoctorLauncherFailure } from "./spool";

/** Detached dispatcher launch configuration. */
export interface DetachedDispatcherConfig {
  readonly repoRoot: string;
  readonly spoolRoot: string;
  readonly bunExecutable: string;
  readonly dispatcherScript: string;
  readonly codexExecutable: string;
  readonly gitExecutable: string;
}

/** Expected failure to prove or launch a detached dispatcher. */
export class DetachedDispatcherError extends Error {
  readonly _tag = "DetachedDispatcherError" as const;

  constructor(
    readonly reason: "unsupported_platform" | "spawn_failed" | "failure_spool_failed",
    override readonly cause: unknown,
    readonly failureArtifact: string | null,
  ) {
    super(
      `Doctor detached dispatch ${reason}: ${redactSecrets(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
  }
}

async function failure(
  config: DetachedDispatcherConfig,
  reason: DetachedDispatcherError["reason"],
  cause: unknown,
  now: Date,
): Promise<Result<never, DetachedDispatcherError>> {
  const recorded = await recordDoctorLauncherFailure(
    config.spoolRoot,
    `${reason}: ${redactSecrets(cause instanceof Error ? cause.message : String(cause))}`,
    now,
  );
  if (recorded._tag === "err") {
    return err(new DetachedDispatcherError("failure_spool_failed", recorded.error, null));
  }
  return err(new DetachedDispatcherError(reason, cause, recorded.value));
}

/**
 * Launch a separate unreferenced dispatcher process after deterministic ingest exits.
 *
 * Node documents `detached + unref + ignored stdio` as independently survivable on
 * supported desktop Unix and Windows. Unknown platforms fail to the recoverable spool.
 */
export async function launchDetachedDoctorDispatcher(
  config: DetachedDispatcherConfig,
  now: Date,
): Promise<Result<{ readonly pid: number }, DetachedDispatcherError>> {
  if (
    process.platform !== "darwin" &&
    process.platform !== "linux" &&
    process.platform !== "win32"
  ) {
    return failure(
      config,
      "unsupported_platform",
      new Error(`Detached dispatch is not proven on ${process.platform}`),
      now,
    );
  }
  try {
    const policyEnvironment = Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => {
        return key.startsWith("JOBSRADAR_DOCTOR_") && value !== undefined;
      }),
    );
    const child = spawn(
      config.bunExecutable,
      [config.dispatcherScript, "run-pending", "--automatic"],
      {
        cwd: config.repoRoot,
        detached: true,
        stdio: "ignore",
        env: {
          ...doctorAgentEnvironment(process.env),
          ...policyEnvironment,
          JOBSRADAR_DOCTOR_SPOOL: config.spoolRoot,
          JOBSRADAR_DOCTOR_CODEX_PATH: config.codexExecutable,
          JOBSRADAR_DOCTOR_GIT_PATH: config.gitExecutable,
        },
      },
    );
    const pid = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", () => {
        if (child.pid === undefined) {
          reject(new Error("Detached child has no pid"));
          return;
        }
        resolve(child.pid);
      });
    });
    child.unref();
    return ok({ pid });
  } catch (error) {
    return failure(config, "spawn_failed", error, now);
  }
}
