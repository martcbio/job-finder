import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

interface SupervisorConfig {
  readonly token: string;
  readonly controlDirectory: string;
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs: number;
  readonly environment: NodeJS.ProcessEnv;
}

const supervisorConfigSchema: z.ZodType<SupervisorConfig> = z
  .object({
    token: z.string().uuid(),
    controlDirectory: z.string().min(1),
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    timeoutMs: z.number().int().positive(),
    terminationGraceMs: z.number().int().nonnegative(),
    environment: z.record(z.string(), z.string()),
  })
  .strict();

const encoded = process.env.JOBSRADAR_DOCTOR_SUPERVISOR_CONFIG;
if (!encoded) throw new Error("JOBSRADAR_DOCTOR_SUPERVISOR_CONFIG is required");
const config = supervisorConfigSchema.parse(
  JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")),
);
delete process.env.JOBSRADAR_DOCTOR_SUPERVISOR_CONFIG;
process.stdout.on("error", () => undefined);
process.stderr.on("error", () => undefined);

await rm(config.controlDirectory, { recursive: true, force: true });
await mkdir(config.controlDirectory, { recursive: true, mode: 0o700 });
const heartbeatPath = join(config.controlDirectory, "heartbeat.json");
const writeHeartbeat = async (): Promise<void> => {
  const temporary = `${heartbeatPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(
    temporary,
    `${JSON.stringify({
      token: config.token,
      pid: process.pid,
      pgid: process.pid,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );
  await rename(temporary, heartbeatPath);
};
await writeHeartbeat();
process.on("SIGTERM", () => {
  // Hold the verified process-group identity until the unconditional SIGKILL.
});
setInterval(() => {
  void writeHeartbeat().catch(() => undefined);
}, 100);

const startPath = join(config.controlDirectory, "start");
while (true) {
  const startToken = await readFile(startPath, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (startToken?.trim() === config.token) break;
  await new Promise((resolve) => setTimeout(resolve, 10));
}

const child = spawn(config.executable, [...config.args], {
  cwd: config.cwd,
  env: config.environment,
  stdio: ["pipe", "inherit", "inherit"],
});
let terminationStarted = false;
const terminateOwnedGroup = (graceMs = config.terminationGraceMs): void => {
  if (terminationStarted) return;
  terminationStarted = true;
  try {
    process.kill(-process.pid, "SIGTERM");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
  }
  setTimeout(() => {
    try {
      process.kill(-process.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }, graceMs);
};
const timeout = setTimeout(() => {
  terminateOwnedGroup();
  process.stderr.write("JOBSRADAR_DOCTOR_TIMEOUT\n");
}, config.timeoutMs);
child.stdin?.once("error", () => {
  terminateOwnedGroup();
  process.stderr.write("JOBSRADAR_DOCTOR_PROMPT_WRITE_FAILED\n");
});
if (child.stdin) process.stdin.pipe(child.stdin);
let spawnFailure = false;
child.once("error", (error) => {
  clearTimeout(timeout);
  process.stderr.write(`${error.message}\n`);
  spawnFailure = true;
});
child.once("close", async (code, signal) => {
  clearTimeout(timeout);
  try {
    const resultPath = join(config.controlDirectory, "child-result.json");
    const temporary = `${resultPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({
        schemaVersion: 1,
        exitCode: spawnFailure ? 127 : code,
        signal,
        closedAt: new Date().toISOString(),
      })}\n`,
    );
    await rename(temporary, resultPath);
  } finally {
    // The direct child closing does not prove that its descendants exited.
    terminateOwnedGroup(Math.min(config.terminationGraceMs, 250));
  }
});
