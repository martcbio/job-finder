import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFile, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { projectDoctorRawFinalOutput } from "./finalProjection";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";
import {
  type DoctorProcessIdentity,
  readDoctorSupervisorChildResult,
  startDoctorSupervisor,
  verifyDoctorProcessIdentity,
} from "./supervisorControl";

/** Input for one bounded local agent process. */
export interface AgentProcessInput {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly prompt: string;
  readonly timeoutMs: number;
  readonly eventsPath: string;
  readonly finalOutputPath: string;
  readonly rawFinalOutputPath: string;
  readonly stderrPath: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly terminationGraceMs?: number;
  readonly processToken?: string;
  readonly supervisorControlDirectory?: string;
  readonly onSpawn?: (identity: DoctorProcessIdentity) => Promise<Result<void, Error>>;
}

/** Observable terminal result of one local agent process. */
export interface AgentProcessReceipt {
  readonly status: "complete" | "failed" | "timed_out";
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly error: string | null;
}

/** Failure to start or observe the local agent process. */
export class AgentProcessError extends Error {
  readonly _tag = "AgentProcessError" as const;

  constructor(
    readonly operation: "open_artifacts" | "spawn" | "write_prompt" | "observe",
    override readonly cause: unknown,
  ) {
    super(
      `Doctor agent ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

function outputExists(path: string): Promise<boolean> {
  return stat(path)
    .then((metadata) => metadata.isFile() && metadata.size > 0)
    .catch(() => false);
}

async function atomicallyReplacePrivateFile(path: string, contents: string): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}-${process.pid}-events.tmp`);
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
}

function terminateProcessGroup(pid: number | undefined, graceMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      killProcessGroup(pid, "SIGTERM");
    } catch (error) {
      reject(error);
      return;
    }
    setTimeout(() => {
      try {
        // The leader may already have exited while descendants still own the group.
        killProcessGroup(pid, "SIGKILL");
        resolve();
      } catch (error) {
        reject(error);
      }
    }, graceMs);
  });
}

/**
 * Run exactly one local child process with real file seams and a hard timeout.
 *
 * @param input - Process command, prompt, bounds, and artifact paths.
 * @returns A typed process receipt or a boundary failure.
 */
export async function runAgentProcess(
  input: AgentProcessInput,
): Promise<Result<AgentProcessReceipt, AgentProcessError>> {
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let pendingEventText = "";
  let eventWrite = Promise.resolve();
  const terminationGraceMs = input.terminationGraceMs ?? 5_000;
  const processToken = input.processToken ?? randomUUID();
  const supervisorControlDirectory =
    input.supervisorControlDirectory ?? join(dirname(input.eventsPath), "supervisor-control");

  try {
    await writeFile(input.eventsPath, "", { flag: "wx", mode: 0o600 });
  } catch (error) {
    return err(new AgentProcessError("open_artifacts", error));
  }

  const outcome = await new Promise<Result<AgentProcessReceipt, AgentProcessError>>((resolve) => {
    let timedOut = false;
    let promptWriteFailed = false;
    let settled = false;
    let termination: Promise<void> | null = null;
    let child: ReturnType<typeof spawn>;
    if (process.platform === "win32") {
      resolve(err(new AgentProcessError("spawn", new Error("Owned process groups require POSIX"))));
      return;
    }
    try {
      const supervisorConfig = Buffer.from(
        JSON.stringify({
          token: processToken,
          controlDirectory: supervisorControlDirectory,
          executable: input.executable,
          args: input.args,
          cwd: input.cwd,
          timeoutMs: input.timeoutMs,
          terminationGraceMs,
          environment: {
            ...input.environment,
            JOBSRADAR_DOCTOR_PROCESS_TOKEN: processToken,
          },
        }),
      ).toString("base64url");
      child = spawn(process.execPath, [join(import.meta.dir, "processSupervisor.ts")], {
        cwd: input.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...input.environment,
          JOBSRADAR_DOCTOR_SUPERVISOR_CONFIG: supervisorConfig,
        },
        detached: true,
      });
    } catch (error) {
      resolve(err(new AgentProcessError("spawn", error)));
      return;
    }

    const beginTermination = (): Promise<void> => {
      termination ??= terminateProcessGroup(child.pid, terminationGraceMs);
      return termination;
    };
    const finishPromptError = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      void beginTermination().then(
        () => resolve(err(new AgentProcessError("write_prompt", error))),
        (terminationError) =>
          resolve(
            err(
              new AgentProcessError(
                "write_prompt",
                new AggregateError(
                  [error, terminationError],
                  "Prompt write and termination failed",
                ),
              ),
            ),
          ),
      );
    };
    const timeout = setTimeout(
      () => {
        timedOut = true;
        void beginTermination().catch((terminationError) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          resolve(err(new AgentProcessError("observe", terminationError)));
        });
      },
      input.timeoutMs + terminationGraceMs + 1_000,
    );
    timeout.unref();

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      resolve(err(new AgentProcessError("spawn", error)));
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (chunk.includes("JOBSRADAR_DOCTOR_PROMPT_WRITE_FAILED")) {
        promptWriteFailed = true;
      }
      if (chunk.includes("JOBSRADAR_DOCTOR_TIMEOUT")) timedOut = true;
      const remaining = 1_000_000 - stderrBytes;
      if (remaining <= 0) return;
      stderrChunks.push(chunk.subarray(0, remaining));
      stderrBytes += Math.min(chunk.length, remaining);
    });
    child.stdout?.on("data", (chunk: Buffer) => {
      const remaining = 10_000_000 - stdoutBytes;
      if (remaining <= 0) return;
      const accepted = chunk.subarray(0, remaining);
      stdoutChunks.push(accepted);
      stdoutBytes += accepted.length;
      const combined = pendingEventText + accepted.toString("utf8");
      const lastNewline = combined.lastIndexOf("\n");
      if (lastNewline < 0) {
        pendingEventText = combined;
        return;
      }
      const completeLines = combined.slice(0, lastNewline + 1);
      pendingEventText = combined.slice(lastNewline + 1);
      eventWrite = eventWrite.then(() =>
        appendFile(input.eventsPath, redactSecrets(completeLines), { encoding: "utf8" }),
      );
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      void (async () => {
        try {
          if (termination) await termination;
          const childResult = await readDoctorSupervisorChildResult(supervisorControlDirectory);
          if (childResult._tag === "err") throw childResult.error;
          const effectiveExitCode = childResult.value?.exitCode ?? exitCode;
          const effectiveSignal = childResult.value?.signal ?? signal;
          const safeStderr = redactSecrets(Buffer.concat(stderrChunks).toString("utf8"));
          const rawEvents = Buffer.concat(stdoutChunks).toString("utf8");
          const safeEvents = `${redactSecrets(rawEvents)}${
            stdoutBytes >= 10_000_000 ? '\n{"type":"doctor_output_truncated"}\n' : ""
          }`;
          await eventWrite;
          const streamedEvents = await readFile(input.eventsPath, "utf8");
          if (streamedEvents !== safeEvents) {
            await atomicallyReplacePrivateFile(input.eventsPath, safeEvents);
          }
          await writeFile(input.stderrPath, safeStderr, { flag: "wx", mode: 0o600 });
          if (promptWriteFailed) {
            resolve(
              err(
                new AgentProcessError(
                  "write_prompt",
                  new Error("Doctor supervisor could not write the prompt to Codex"),
                ),
              ),
            );
            return;
          }
          resolve(
            ok({
              status: timedOut ? "timed_out" : effectiveExitCode === 0 ? "complete" : "failed",
              exitCode: effectiveExitCode,
              signal: effectiveSignal,
              error: timedOut ? `Doctor agent exceeded ${input.timeoutMs}ms` : null,
            }),
          );
        } catch (error) {
          resolve(err(new AgentProcessError("observe", error)));
        }
      })();
    });

    void (async () => {
      if (child.pid === undefined) throw new Error("Doctor supervisor has no PID");
      const identity: DoctorProcessIdentity = {
        token: processToken,
        pid: child.pid,
        pgid: child.pid,
        controlDirectory: supervisorControlDirectory,
      };
      let verified = await verifyDoctorProcessIdentity(identity);
      for (let attempt = 0; verified._tag === "err" && attempt < 200; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        verified = await verifyDoctorProcessIdentity(identity);
      }
      if (verified._tag === "err") throw verified.error;
      if (input.onSpawn) {
        const persisted = await input.onSpawn(identity);
        if (persisted._tag === "err") throw persisted.error;
      }
      const started = await startDoctorSupervisor(identity);
      if (started._tag === "err") throw started.error;
      await new Promise((resolve) => setTimeout(resolve, 25));
      const stdin = child.stdin;
      if (stdin === null) throw new Error("Agent stdin is unavailable");
      stdin.once("error", (error) => {
        finishPromptError(error);
      });
      stdin.end(input.prompt);
    })().catch(finishPromptError);
  });

  if (outcome._tag === "err") {
    await Promise.all([
      writeFile(input.stderrPath, redactSecrets(outcome.error.message), { flag: "wx" }).catch(
        () => undefined,
      ),
    ]);
    const projection = await projectDoctorRawFinalOutput(
      input.rawFinalOutputPath,
      input.finalOutputPath,
    );
    if (projection._tag === "err") return err(new AgentProcessError("observe", projection.error));
    return outcome;
  }
  let finalOutcome: Result<AgentProcessReceipt, AgentProcessError> = outcome;
  const projection = await projectDoctorRawFinalOutput(
    input.rawFinalOutputPath,
    input.finalOutputPath,
  );
  if (projection._tag === "err")
    finalOutcome = err(new AgentProcessError("observe", projection.error));
  if (finalOutcome._tag === "err") return finalOutcome;
  if (finalOutcome.value.status === "complete" && !(await outputExists(input.finalOutputPath))) {
    const stderr = await readFile(input.stderrPath, "utf8").catch(() => "");
    return ok({
      ...finalOutcome.value,
      status: "failed",
      error: `Doctor agent exited 0 without final output${stderr ? `: ${stderr.trim()}` : ""}`,
    });
  }
  return finalOutcome;
}
