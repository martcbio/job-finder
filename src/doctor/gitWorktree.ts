import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";

/** Expected failure resolving Git state or creating an isolated worktree. */
export class DoctorGitError extends Error {
  readonly _tag = "DoctorGitError" as const;

  constructor(
    readonly operation: "resolve_head" | "create_worktree" | "cleanup_worktree" | "resolve_codex",
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

function killDetachedProcessGroup(pid: number, signal: NodeJS.Signals): Error | null {
  try {
    process.kill(process.platform === "win32" ? pid : -pid, signal);
    return null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return null;
    return error instanceof Error ? error : new Error(String(error));
  }
}

async function runCapture(
  executable: string,
  args: ReadonlyArray<string>,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
  trimOutput = true,
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
        const terminateError = killDetachedProcessGroup(pid, "SIGTERM");
        if (terminateError) {
          finish(
            err(
              new Error(
                `${executable} exceeded ${timeoutMs}ms and SIGTERM failed: ${redactSecrets(
                  terminateError.message,
                )}`,
              ),
            ),
          );
          return;
        }
        setTimeout(() => {
          const killError = killDetachedProcessGroup(pid, "SIGKILL");
          if (killError) {
            finish(
              err(
                new Error(
                  `${executable} exceeded ${timeoutMs}ms and SIGKILL failed: ${redactSecrets(
                    killError.message,
                  )}`,
                ),
              ),
            );
            return;
          }
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
        const output = Buffer.concat(stdout).toString("utf8");
        finish(ok(trimOutput ? output.trim() : output));
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
    await mkdir(worktreesRoot, { recursive: true, mode: 0o700 });
    await chmod(worktreesRoot, 0o700);
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
  if (result._tag === "err") return err(new DoctorGitError("create_worktree", result.error));
  try {
    await chmod(worktreePath, 0o700);
    return ok(worktreePath);
  } catch (error) {
    await runCapture(
      gitExecutable,
      ["worktree", "remove", "--force", worktreePath],
      repoRoot,
      environment,
    );
    await runCapture(gitExecutable, ["worktree", "prune"], repoRoot, environment);
    return err(new DoctorGitError("create_worktree", error));
  }
}

/** Archive every worktree change into the dispatch spool, then remove and prune it. */
export async function archiveAndRemoveDoctorWorktree(
  repoRoot: string,
  worktreePath: string,
  repoHead: string,
  dispatchDirectory: string,
  gitExecutable: string,
  environment: NodeJS.ProcessEnv,
): Promise<Result<void, DoctorGitError>> {
  const archiveDirectory = join(dispatchDirectory, "worktree-archive");
  const expectedManifest = {
    schemaVersion: 1,
    repoHead,
    worktreePath: resolve(worktreePath),
  } as const;
  const archiveIsComplete = async (): Promise<boolean> => {
    try {
      const value: unknown = JSON.parse(
        await readFile(join(archiveDirectory, "manifest.json"), "utf8"),
      );
      return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        "schemaVersion" in value &&
        value.schemaVersion === expectedManifest.schemaVersion &&
        "repoHead" in value &&
        value.repoHead === expectedManifest.repoHead &&
        "worktreePath" in value &&
        value.worktreePath === expectedManifest.worktreePath
      );
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
      throw error;
    }
  };
  try {
    if (!(await archiveIsComplete())) {
      const stagingDirectory = `${archiveDirectory}.staging-${randomUUID()}`;
      try {
        await mkdir(stagingDirectory, { mode: 0o700 });
        const tracked = await runCapture(
          gitExecutable,
          ["diff", "--binary", repoHead],
          worktreePath,
          environment,
          30_000,
          false,
        );
        if (tracked._tag === "err") throw tracked.error;
        await writeFile(join(stagingDirectory, "tracked.patch"), tracked.value, {
          flag: "wx",
          mode: 0o600,
        });

        const untracked = await runCapture(
          gitExecutable,
          ["ls-files", "--others", "--exclude-standard", "-z"],
          worktreePath,
          environment,
          30_000,
          false,
        );
        if (untracked._tag === "err") throw untracked.error;
        const worktreeRoot = resolve(worktreePath);
        for (const relativePath of untracked.value.split("\u0000").filter(Boolean)) {
          const source = resolve(worktreeRoot, relativePath);
          if (!source.startsWith(`${worktreeRoot}/`)) {
            throw new Error(`Git returned an unsafe untracked path: ${relativePath}`);
          }
          const metadata = await lstat(source);
          if (!metadata.isFile()) {
            throw new Error(`Refusing to archive a non-regular untracked file: ${relativePath}`);
          }
          const destination = join(stagingDirectory, "untracked", relativePath);
          await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
          await copyFile(source, destination, constants.COPYFILE_EXCL);
        }
        await writeFile(
          join(stagingDirectory, "manifest.json"),
          `${JSON.stringify(expectedManifest)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        try {
          await rename(stagingDirectory, archiveDirectory);
        } catch (error) {
          if (
            !(error instanceof Error && "code" in error && error.code === "EEXIST") ||
            !(await archiveIsComplete())
          ) {
            throw error;
          }
          await rm(stagingDirectory, { recursive: true, force: true });
        }
        if (!(await archiveIsComplete())) {
          throw new Error("Published worktree archive did not verify");
        }
      } catch (error) {
        await rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
    }

    const worktreeExists = await stat(worktreePath)
      .then(() => true)
      .catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      });
    if (worktreeExists) {
      const removed = await runCapture(
        gitExecutable,
        ["worktree", "remove", "--force", worktreePath],
        repoRoot,
        environment,
      );
      if (removed._tag === "err") {
        return err(new DoctorGitError("cleanup_worktree", removed.error));
      }
    }
    const pruned = await runCapture(gitExecutable, ["worktree", "prune"], repoRoot, environment);
    return pruned._tag === "err"
      ? err(new DoctorGitError("cleanup_worktree", pruned.error))
      : ok(undefined);
  } catch (error) {
    return err(new DoctorGitError("cleanup_worktree", error));
  }
}

/** Minimal environment passed to the local Codex child. */
export function doctorAgentEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return minimalProcessEnvironment(environment);
}
