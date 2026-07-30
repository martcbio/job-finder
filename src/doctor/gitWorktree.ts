import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";

/** Expected failure resolving Git state or creating an isolated worktree. */
export class DoctorGitError extends Error {
  readonly _tag = "DoctorGitError" as const;

  constructor(
    readonly operation: "resolve_head" | "create_worktree" | "resolve_codex",
    override readonly cause: unknown,
  ) {
    super(
      `Doctor Git ${operation} failed: ${redactSecrets(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
  }
}

function minimalProcessEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "PATH",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "USER",
    "LOGNAME",
    "SHELL",
    "CODEX_HOME",
  ] as const;
  const output: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = environment[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}

async function runCapture(
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<Result<string, Error>> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const child = spawn(executable, [...args], {
      cwd,
      env: minimalProcessEnvironment(environment),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
    const finish = (result: Result<string, Error>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) {
        const pid = child.pid;
        try {
          process.kill(process.platform === "win32" ? pid : -pid, "SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
          } catch {}
          finish(err(new Error(`${executable} exceeded ${timeoutMs}ms`)));
        }, 250).unref();
        return;
      }
      finish(err(new Error(`${executable} exceeded ${timeoutMs}ms`)));
    }, timeoutMs);
    timeout.unref();
    child.once("error", (error) => finish(err(error)));
    child.once("close", (code) => {
      if (timedOut) return;
      if (code === 0) {
        finish(ok(Buffer.concat(stdout).toString("utf8").trim()));
        return;
      }
      finish(
        err(
          new Error(
            `${executable} exited ${code}: ${redactSecrets(
              Buffer.concat(stderr).toString("utf8").trim(),
            )}`,
          ),
        ),
      );
    });
  });
}

/** Resolve the immutable Git commit associated with a repair incident. */
export async function resolveRepoHead(
  repoRoot: string,
  gitExecutable: string,
  environment: NodeJS.ProcessEnv,
): Promise<Result<string, DoctorGitError>> {
  const result = await runCapture(
    gitExecutable,
    ["rev-parse", "--verify", "HEAD"],
    repoRoot,
    environment,
  );
  if (result._tag === "err") return err(new DoctorGitError("resolve_head", result.error));
  return /^[0-9a-f]{40}$/i.test(result.value)
    ? ok(result.value)
    : err(new DoctorGitError("resolve_head", new Error("Git returned an invalid HEAD")));
}

/** Resolve an absolute executable Codex path without a provider/model fallback. */
export async function resolveCodexExecutable(
  environment: NodeJS.ProcessEnv,
): Promise<Result<string, DoctorGitError>> {
  const configured = environment.JOBSRADAR_DOCTOR_CODEX_PATH;
  const candidates =
    configured !== undefined
      ? [configured]
      : (environment.PATH ?? "")
          .split(":")
          .filter((entry) => entry.length > 0)
          .map((entry) => join(entry, "codex"));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return ok(candidate);
    } catch {
      // Try the next explicit local path.
    }
  }
  return err(
    new DoctorGitError(
      "resolve_codex",
      new Error("No absolute executable Codex path is available"),
    ),
  );
}

/** Resolve an absolute executable Git path for HEAD and worktree operations. */
export async function resolveGitExecutable(
  environment: NodeJS.ProcessEnv,
): Promise<Result<string, DoctorGitError>> {
  const configured = environment.JOBSRADAR_DOCTOR_GIT_PATH;
  const candidates =
    configured !== undefined ? [configured] : ["/opt/homebrew/bin/git", "/usr/bin/git"];
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      await access(candidate, constants.X_OK);
      return ok(candidate);
    } catch {
      // Try the next explicit local installation path.
    }
  }
  return err(
    new DoctorGitError("resolve_head", new Error("No absolute executable Git path is available")),
  );
}

/** Create a persistent isolated worktree at the incident commit. */
export async function createIsolatedDoctorWorktree(
  repoRoot: string,
  dispatchId: string,
  repoHead: string,
  gitExecutable: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<Result<string, DoctorGitError>> {
  const worktreesRoot = join(dirname(repoRoot), ".jobsradar-doctor-worktrees");
  const worktreePath = join(worktreesRoot, dispatchId);
  try {
    await mkdir(worktreesRoot, { recursive: true });
  } catch (error) {
    return err(new DoctorGitError("create_worktree", error));
  }
  const result = await runCapture(
    gitExecutable,
    ["worktree", "add", "--detach", worktreePath, repoHead],
    repoRoot,
    environment,
    timeoutMs,
  );
  return result._tag === "err"
    ? err(new DoctorGitError("create_worktree", result.error))
    : ok(worktreePath);
}

/** Minimal environment passed to the local Codex child. */
export function doctorAgentEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return minimalProcessEnvironment(environment);
}
