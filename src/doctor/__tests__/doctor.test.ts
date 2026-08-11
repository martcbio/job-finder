import { afterEach, describe, expect, test } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchDoctor } from "../../../scripts/jobsradar.ts";
import type { JobIngestResult } from "../../pipeline/jobIngest";
import { runAgentProcess } from "../agentProcess";
import {
  acquireDoctorDispatcherLock,
  type DoctorDispatcherConfig,
  parseDoctorDispatcherConfig,
  releaseDoctorDispatcherLock,
  runPendingDoctor,
} from "../dispatcher";
import {
  archiveAndRemoveDoctorWorktree,
  createIsolatedDoctorWorktree,
  doctorAgentEnvironment,
  resolveRepoHead,
} from "../gitWorktree";
import { classifyIngestResult, classifyIngestThrow } from "../incident";
import { redactSecrets } from "../redaction";
import { ok } from "../result";
import {
  acquireDoctorFingerprintLock,
  attachDoctorIncidentRepoHead,
  doctorSpoolPaths,
  listActiveDoctorDispatchAttempts,
  listPendingDoctorIncidents,
  readDoctorRuntimeState,
  recordDoctorIncident,
  recoverDoctorRawFinalOutput,
  releaseDoctorFingerprintLock,
} from "../spool";

const temporaryDirectories: string[] = [];
const TEST_GIT_EXECUTABLE = "/usr/bin/git";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function ingestResult(errors: string[]): JobIngestResult {
  return {
    status: "failed",
    startedAt: "2026-07-30T08:00:00.000Z",
    finishedAt: "2026-07-30T08:00:01.000Z",
    elapsedMs: 1_000,
    options: {
      sourceIds: ["lab-ats"],
      marketDir: "/market",
      jobserveQueries: [],
      jobserveMaxPages: 1,
      jobserveImportLimitPerQuery: 1,
      timeoutMs: 1_000,
    },
    sources: [
      {
        id: "lab-ats",
        label: "Lab ATS",
        status: "failed",
        runId: null,
        discovered: 0,
        imported: 0,
        evidencePath: null,
        errors,
        elapsedMs: 1_000,
      },
    ],
  };
}

function repairIncident(message: string) {
  const classified = classifyIngestThrow(new Error(message));
  if (classified._tag !== "repair") throw new Error("Expected a repair incident");
  return classified.incident;
}

function config(root: string, executable: string): DoctorDispatcherConfig {
  return {
    repoRoot: process.cwd(),
    spoolRoot: join(root, "logs", "doctor"),
    agentExecutable: executable,
    gitExecutable: TEST_GIT_EXECUTABLE,
    timeoutMs: 5_000,
    cooldownMs: 60_000,
    maxRunsPerDay: 2,
    circuitFailureThreshold: 3,
    circuitOpenMs: 86_400_000,
  };
}

describe("Doctor incident classification and spool", () => {
  test("does not dispatch pure external transient failures", () => {
    expect(classifyIngestResult(ingestResult(["ATS request timed out after 20000ms"]))).toEqual({
      _tag: "non_repair",
      reason: "external_transient",
      summary: "jobsradar ingest returned failed",
    });
    expect(classifyIngestThrow(new Error("HTTP 429 rate limit"))._tag).toBe("non_repair");
  });

  test("repairs unknown/internal evidence and deduplicates its immutable fingerprint", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-spool-"));
    temporaryDirectories.push(root);
    const incident = repairIncident(
      "TypeError: parser token=supersecret returned an impossible shape",
    );
    const [first, second] = await Promise.all([
      recordDoctorIncident(
        join(root, "logs", "doctor"),
        incident,
        "a".repeat(40),
        new Date("2026-07-30T09:00:00Z"),
      ),
      recordDoctorIncident(
        join(root, "logs", "doctor"),
        incident,
        "a".repeat(40),
        new Date("2026-07-30T10:00:00Z"),
      ),
    ]);
    expect(first._tag).toBe("ok");
    expect(second._tag).toBe("ok");
    if (first._tag === "err" || second._tag === "err") return;
    expect([first.value._tag, second.value._tag].sort()).toEqual(["created", "deduplicated"]);
    expect(second.value.incident.createdAt).toBe(first.value.incident.createdAt);
    const files = await readdir(join(root, "logs", "doctor", "incidents", incident.fingerprint));
    expect(files).toHaveLength(1);
    expect(await readFile(first.value.path, "utf8")).not.toContain("supersecret");
  });

  test("persists a recoverable incident before Git HEAD exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-pre-git-"));
    temporaryDirectories.push(root);
    const spoolRoot = join(root, "logs", "doctor");
    const incident = repairIncident("TypeError: Git unavailable fixture");
    const recorded = await recordDoctorIncident(
      spoolRoot,
      incident,
      null,
      new Date("2026-07-30T09:00:00Z"),
    );
    expect(recorded._tag).toBe("ok");
    if (recorded._tag === "err") return;
    expect(recorded.value.incident.repoHead).toBeNull();
    const attached = await attachDoctorIncidentRepoHead(
      spoolRoot,
      recorded.value.path,
      incident.fingerprint,
      "a".repeat(40),
    );
    expect(attached._tag).toBe("ok");
    const pending = await listPendingDoctorIncidents(spoolRoot);
    expect(pending._tag === "ok" ? pending.value[0]?.incident.repoHead : null).toBe("a".repeat(40));
  });
});

test("dispatcher invokes one explicit bounded agent process and preserves artifacts", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-agent-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
count=0
if [ -f "\${0}.count" ]; then IFS= read -r count < "\${0}.count"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "\${0}.count"
final=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then shift; final="$1"; fi
  shift
done
: > "\${0}.prompt"
while IFS= read -r line; do printf '%s\\n' "$line" >> "\${0}.prompt"; done
printf '%s\\n' '{"type":"fake-agent","token":"sk-proj-stdoutsecret"}'
printf '%s\\n' 'token=super-secret-value' >&2
printf '%s\\n' 'fake diagnosis token=final-secret' > "$final"
`,
  );
  await chmod(fakeAgent, 0o755);
  const spoolRoot = join(root, "logs", "doctor");
  const incident = repairIncident("TypeError: local parser failed");
  const recorded = await recordDoctorIncident(
    spoolRoot,
    incident,
    "a".repeat(40),
    new Date("2026-07-30T09:00:00Z"),
  );
  expect(recorded._tag).toBe("ok");

  const outcome = await runPendingDoctor(config(root, fakeAgent), {
    clock: { now: () => new Date("2026-07-30T09:05:00Z") },
    agent: { run: runAgentProcess },
    worktree: { create: async () => ok(root) },
  });
  expect(outcome._tag).toBe("ok");
  if (outcome._tag === "err" || outcome.value._tag !== "dispatched") return;
  expect(outcome.value.receipt.status).toBe("complete");
  expect(outcome.value.receipt.command).toEqual([
    fakeAgent,
    "exec",
    "--json",
    "--sandbox",
    "workspace-write",
    "-C",
    root,
    "--output-last-message",
    expect.any(String),
    "-",
  ]);
  expect(outcome.value.receipt.command).not.toContain("--model");
  expect(outcome.value.receipt.command[9]).not.toBe(outcome.value.receipt.finalOutputPath);
  const rawFinalPath = outcome.value.receipt.command[9];
  expect(typeof rawFinalPath).toBe("string");
  expect(await readFile(`${fakeAgent}.count`, "utf8")).toBe("1\n");
  expect(await readFile(`${fakeAgent}.prompt`, "utf8")).toContain("Do not deploy");
  expect(await readFile(outcome.value.receipt.eventsPath, "utf8")).toContain("fake-agent");
  expect(await readFile(outcome.value.receipt.eventsPath, "utf8")).not.toContain("stdoutsecret");
  expect(await readFile(outcome.value.receipt.finalOutputPath, "utf8")).toBe(
    "fake diagnosis token=[REDACTED]\n",
  );
  if (typeof rawFinalPath === "string") {
    expect(await Bun.file(rawFinalPath).exists()).toBe(false);
  }
  expect(await readFile(outcome.value.receipt.stderrPath, "utf8")).toBe("token=[REDACTED]\n");
  expect(outcome.value.receipt.worktreePath).toBe(root);
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag === "ok" ? pending.value : []).toHaveLength(0);

  const recurrence = await recordDoctorIncident(
    spoolRoot,
    incident,
    "a".repeat(40),
    new Date("2026-07-30T10:00:00Z"),
  );
  expect(recurrence._tag === "ok" ? recurrence.value._tag : "error").toBe("created");
  const reopened = await listPendingDoctorIncidents(spoolRoot);
  expect(reopened._tag === "ok" ? reopened.value : []).toHaveLength(1);
});

test("recurrence observed during an active repair remains pending after success", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-recurrence-race-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "logs", "doctor");
  const incident = repairIncident("TypeError: concurrent local parser failure");
  const recorded = await recordDoctorIncident(
    spoolRoot,
    incident,
    "a".repeat(40),
    new Date("2026-07-30T09:00:00Z"),
  );
  expect(recorded._tag).toBe("ok");
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let releaseAgent: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseAgent = resolve;
  });
  const dispatch = runPendingDoctor(config(root, "/fake/codex"), {
    clock: { now: () => new Date("2026-07-30T09:05:00Z") },
    worktree: { create: async () => ok(root) },
    agent: {
      run: async () => {
        signalStarted?.();
        await release;
        return ok({ status: "complete", exitCode: 0, signal: null, error: null });
      },
    },
  });
  await started;
  const recurrence = await recordDoctorIncident(
    spoolRoot,
    incident,
    "a".repeat(40),
    new Date("2026-07-30T09:06:00Z"),
  );
  expect(recurrence._tag === "ok" ? recurrence.value._tag : "error").toBe("created");
  releaseAgent?.();
  const outcome = await dispatch;
  expect(outcome._tag === "ok" ? outcome.value._tag : "error").toBe("dispatched");
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag).toBe("ok");
  if (pending._tag === "err") return;
  expect(pending.value).toHaveLength(1);
  expect(pending.value[0]?.incident.incidentId).toBe(
    recurrence._tag === "ok" ? recurrence.value.incident.incidentId : "",
  );
});

test("dispatcher revalidates canonical ownership before launching the agent", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-lease-loss-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "logs", "doctor");
  await recordDoctorIncident(
    spoolRoot,
    repairIncident("TypeError: lease loss fixture"),
    "a".repeat(40),
    new Date("2026-07-30T09:00:00Z"),
  );
  let agentCalled = false;
  const outcome = await runPendingDoctor(config(root, "/fake/codex"), {
    clock: { now: () => new Date("2026-07-30T09:05:00Z") },
    worktree: {
      create: async () => {
        const lockPath = doctorSpoolPaths(spoolRoot).lock;
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        await writeFile(
          lockPath,
          `${JSON.stringify({
            ...owner,
            token: "33333333-3333-4333-8333-333333333333",
          })}\n`,
        );
        return ok(root);
      },
    },
    agent: {
      run: async () => {
        agentCalled = true;
        return ok({ status: "complete", exitCode: 0, signal: null, error: null });
      },
    },
  });
  expect(outcome._tag).toBe("err");
  expect(agentCalled).toBe(false);
});

test("dispatcher refuses a terminal commit after losing canonical ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-commit-lease-loss-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "logs", "doctor");
  await recordDoctorIncident(
    spoolRoot,
    repairIncident("TypeError: commit lease loss fixture"),
    "a".repeat(40),
    new Date("2026-07-30T09:00:00Z"),
  );
  const outcome = await runPendingDoctor(config(root, "/fake/codex"), {
    clock: { now: () => new Date("2026-07-30T09:05:00Z") },
    worktree: { create: async () => ok(root) },
    agent: {
      run: async () => {
        const lockPath = doctorSpoolPaths(spoolRoot).lock;
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        await writeFile(
          lockPath,
          `${JSON.stringify({
            ...owner,
            token: "55555555-5555-4555-8555-555555555555",
          })}\n`,
        );
        return ok({ status: "complete", exitCode: 0, signal: null, error: null });
      },
    },
  });
  expect(outcome._tag).toBe("err");
  const active = await listActiveDoctorDispatchAttempts(spoolRoot);
  expect(active._tag === "ok" ? active.value : []).toHaveLength(1);
});

test("terminal receipt redacts errors and reconciles stale policy state", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-finalization-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "logs", "doctor");
  const incident = repairIncident("TypeError: finalization state failure");
  await recordDoctorIncident(spoolRoot, incident, "a".repeat(40), new Date("2026-07-30T09:00:00Z"));
  const startedAt = "2026-07-30T09:05:00.000Z";
  const outcome = await runPendingDoctor(config(root, "/fake/codex"), {
    clock: { now: () => new Date(startedAt) },
    worktree: { create: async () => ok(root) },
    agent: {
      run: async () =>
        ok({
          status: "complete",
          exitCode: 0,
          signal: null,
          error: "api_key=receipt-secret",
        }),
    },
  });
  expect(outcome._tag === "ok" ? outcome.value._tag : "error").toBe("dispatched");
  if (outcome._tag === "err" || outcome.value._tag !== "dispatched") return;
  expect(outcome.value.receipt.error).toBe("api_key=[REDACTED]");
  const receiptText = await readFile(
    join(spoolRoot, "dispatches", outcome.value.receipt.dispatchId, "receipt.json"),
    "utf8",
  );
  expect(receiptText).not.toContain("receipt-secret");
  await writeFile(
    doctorSpoolPaths(spoolRoot).runtimeState,
    `${JSON.stringify({
      schemaVersion: 1,
      dateKey: "2026-07-30",
      runsToday: 1,
      consecutiveFailures: 9,
      lastStartedAt: startedAt,
      circuitOpenedAt: startedAt,
    })}\n`,
  );
  const reconciled = await readDoctorRuntimeState(spoolRoot, "2026-07-30");
  expect(reconciled._tag).toBe("ok");
  if (reconciled._tag === "err") return;
  expect(reconciled.value.consecutiveFailures).toBe(0);
  expect(reconciled.value.circuitOpenedAt).toBeNull();
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag === "ok" ? pending.value : []).toHaveLength(0);
});

test("dispatcher integer configuration rejects partial numbers", () => {
  const parsed = parseDoctorDispatcherConfig(process.cwd(), {
    JOBSRADAR_DOCTOR_CODEX_PATH: "/Users/mcb/.local/bin/codex",
    JOBSRADAR_DOCTOR_GIT_PATH: "/opt/homebrew/bin/git",
    JOBSRADAR_DOCTOR_TIMEOUT_MS: "12oops",
  });
  expect(parsed._tag).toBe("err");
});

test("redaction strips secret shapes and the agent environment is allowlisted", () => {
  expect(
    redactSecrets(
      "api_key=topsecret Bearer abc.def.ghi sk-proj-abcdefghij https://user:pass@example.test postgres://dbuser:dbpass@db.test FOO_SECRET=hidden DATABASE_URL=postgresql://u:p@db.test",
    ),
  ).toBe(
    "api_key=[REDACTED] Bearer [REDACTED] [REDACTED_TOKEN] https://[REDACTED]@example.test postgres://[REDACTED]@db.test FOO_SECRET=[REDACTED] DATABASE_URL=[REDACTED]",
  );
  expect(
    doctorAgentEnvironment({
      HOME: "/home/test",
      PATH: "/bin",
      OPENAI_API_KEY: "must-not-pass",
      DATABASE_URL: "must-not-pass",
    }),
  ).toEqual({ HOME: "/home/test", PATH: "/bin" });
});

async function runCommand(command: ReadonlyArray<string>, cwd: string): Promise<void> {
  const child = Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${stderr}`);
}

test("isolated worktree uses the incident HEAD instead of dirty user files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-worktree-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = TEST_GIT_EXECUTABLE;
  await runCommand([git, "init"], repo);
  await runCommand([git, "config", "user.email", "doctor@example.test"], repo);
  await runCommand([git, "config", "user.name", "Doctor Test"], repo);
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await runCommand([git, "add", "tracked.txt"], repo);
  await runCommand([git, "commit", "-m", "fixture"], repo);
  const head = await resolveRepoHead(repo, git, process.env);
  expect(head._tag).toBe("ok");
  if (head._tag === "err") return;
  await writeFile(join(repo, "tracked.txt"), "dirty user edit\n");
  const isolated = await createIsolatedDoctorWorktree(
    repo,
    "dispatch-test",
    head.value,
    git,
    process.env,
  );
  expect(isolated._tag).toBe("ok");
  if (isolated._tag === "err") return;
  expect(await readFile(join(isolated.value, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(await readFile(join(repo, "tracked.txt"), "utf8")).toBe("dirty user edit\n");
  expect((await stat(isolated.value)).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, ".jobsradar-doctor-worktrees"))).mode & 0o777).toBe(0o700);
});

test("terminal worktree changes are archived before the worktree is removed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-worktree-archive-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const dispatchDirectory = join(root, "dispatch");
  await mkdir(repo);
  await mkdir(dispatchDirectory);
  const git = TEST_GIT_EXECUTABLE;
  await runCommand([git, "init"], repo);
  await runCommand([git, "config", "user.email", "doctor@example.test"], repo);
  await runCommand([git, "config", "user.name", "Doctor Test"], repo);
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await runCommand([git, "add", "tracked.txt"], repo);
  await runCommand([git, "commit", "-m", "fixture"], repo);
  const head = await resolveRepoHead(repo, git, process.env);
  expect(head._tag).toBe("ok");
  if (head._tag === "err") return;
  const isolated = await createIsolatedDoctorWorktree(
    repo,
    "dispatch-archive",
    head.value,
    git,
    process.env,
  );
  expect(isolated._tag).toBe("ok");
  if (isolated._tag === "err") return;
  await writeFile(join(isolated.value, "tracked.txt"), "patched\n");
  await writeFile(join(isolated.value, "new-test.txt"), "new evidence\n");

  const archived = await archiveAndRemoveDoctorWorktree(
    repo,
    isolated.value,
    head.value,
    dispatchDirectory,
    git,
    process.env,
  );

  expect(archived._tag).toBe("ok");
  expect(
    await readFile(join(dispatchDirectory, "worktree-archive", "tracked.patch"), "utf8"),
  ).toContain("+patched");
  expect(
    await readFile(
      join(dispatchDirectory, "worktree-archive", "untracked", "new-test.txt"),
      "utf8",
    ),
  ).toBe("new evidence\n");
  expect(await Bun.file(isolated.value).exists()).toBe(false);
  const retried = await archiveAndRemoveDoctorWorktree(
    repo,
    isolated.value,
    head.value,
    dispatchDirectory,
    git,
    process.env,
  );
  expect(retried._tag).toBe("ok");
});

test("worktree archive refuses symlinks instead of copying host files", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-worktree-symlink-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  const dispatchDirectory = join(root, "dispatch");
  const outside = join(root, "outside-secret");
  await mkdir(repo);
  await mkdir(dispatchDirectory);
  await writeFile(outside, "must-not-copy\n");
  const git = TEST_GIT_EXECUTABLE;
  await runCommand([git, "init"], repo);
  await runCommand([git, "config", "user.email", "doctor@example.test"], repo);
  await runCommand([git, "config", "user.name", "Doctor Test"], repo);
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await runCommand([git, "add", "tracked.txt"], repo);
  await runCommand([git, "commit", "-m", "fixture"], repo);
  const head = await resolveRepoHead(repo, git, process.env);
  expect(head._tag).toBe("ok");
  if (head._tag === "err") return;
  const isolated = await createIsolatedDoctorWorktree(
    repo,
    "dispatch-symlink",
    head.value,
    git,
    process.env,
  );
  expect(isolated._tag).toBe("ok");
  if (isolated._tag === "err") return;
  await symlink(outside, join(isolated.value, "host-secret"));

  const archived = await archiveAndRemoveDoctorWorktree(
    repo,
    isolated.value,
    head.value,
    dispatchDirectory,
    git,
    process.env,
  );

  expect(archived._tag).toBe("err");
  expect(archived._tag === "err" ? archived.error.message : "").toContain(
    "non-regular untracked file",
  );
  expect(await Bun.file(join(dispatchDirectory, "worktree-archive")).exists()).toBe(false);
  expect(await stat(isolated.value).then(() => true)).toBe(true);
});

test("git worktree creation is hard-bounded", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-worktree-timeout-"));
  temporaryDirectories.push(root);
  const fakeGit = join(root, "git");
  await writeFile(fakeGit, "#!/bin/sh\n/bin/sleep 2\n");
  await chmod(fakeGit, 0o755);
  const started = Date.now();
  const outcome = await createIsolatedDoctorWorktree(
    root,
    "dispatch-timeout",
    "a".repeat(40),
    fakeGit,
    { PATH: "/bin:/usr/bin" },
    50,
  );
  expect(outcome._tag).toBe("err");
  expect(Date.now() - started).toBeLessThan(1_000);
});

test("Doctor launchd template renders a periodic read-only status command", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-launchd-"));
  temporaryDirectories.push(root);
  const destination = join(root, "doctor.plist");
  const child = Bun.spawn(
    [
      process.execPath,
      "scripts/render-jobsradar-launchd.ts",
      "launchd/com.mcb.jobsradar.doctor.plist.template",
      destination,
      process.cwd(),
      "/Users/mcb/.local/bin/codex",
      "/opt/homebrew/bin/git",
      "/Users/mcb/.local/bin/bun",
    ],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  expect(await child.exited).toBe(0);
  const rendered = await readFile(destination, "utf8");
  expect(rendered).toContain("<string>/Users/mcb/.local/bin/codex</string>");
  expect(rendered).toContain("<string>/opt/homebrew/bin/git</string>");
  expect(rendered).toContain("<string>/Users/mcb/.local/bin/bun</string>");
  expect(rendered).toContain("<integer>900</integer>");
  expect(rendered).toContain("<string>status</string>");
  expect(rendered).toContain("<string>--json</string>");
  expect(rendered).not.toContain("<string>run-pending</string>");
  expect(rendered).not.toContain("<string>--automatic</string>");
  expect(rendered).not.toContain("__");
});

test("jobsradar rejects partially numeric integer flags before ingest", async () => {
  const child = Bun.spawn(
    [process.execPath, "scripts/jobsradar.ts", "ingest", "--timeout-ms", "12oops"],
    { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).toBe(2);
  expect(stderr).toContain("--timeout-ms requires a positive integer");
});

test("Doctor status does not resolve Codex or Git executables", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-status-"));
  temporaryDirectories.push(root);
  const child = Bun.spawn([process.execPath, "scripts/jobsradar-doctor.ts", "status", "--json"], {
    cwd: process.cwd(),
    env: {
      JOBSRADAR_DOCTOR_SPOOL: join(root, "spool"),
      JOBSRADAR_DOCTOR_CODEX_PATH: "./malformed-relative-codex",
      JOBSRADAR_DOCTOR_GIT_PATH: "relative/git",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  expect(exitCode).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ pendingCount: 0 });
  expect(await readdir(root)).toEqual([]);
});

test("launcher persists a consumable incident before Git resolution fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-launcher-pre-git-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "spool");
  const dispatched = await dispatchDoctor(
    classifyIngestThrow(new TypeError("launcher pre-Git fixture")),
    {
      repoRoot: process.cwd(),
      spoolRoot,
      environment: {
        JOBSRADAR_DOCTOR_SPOOL: spoolRoot,
        JOBSRADAR_DOCTOR_GIT_PATH: "/definitely/missing/git",
        JOBSRADAR_DOCTOR_CODEX_PATH: "/definitely/missing/codex",
      },
    },
  );
  expect(dispatched._tag).toBe("err");
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag === "ok" ? pending.value : []).toHaveLength(1);
  expect(pending._tag === "ok" ? pending.value[0]?.incident.repoHead : "missing").toBeNull();
});

test("ingest records repair work without resolving or launching Codex", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-explicit-only-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "spool");
  const dispatched = await dispatchDoctor(
    classifyIngestThrow(new TypeError("manual Doctor fixture")),
    {
      repoRoot: process.cwd(),
      spoolRoot,
      environment: {
        PATH: process.env.PATH,
        JOBSRADAR_DOCTOR_GIT_PATH: TEST_GIT_EXECUTABLE,
        JOBSRADAR_DOCTOR_CODEX_PATH: "/definitely/missing/codex",
      },
    },
  );
  expect(dispatched).toEqual({ _tag: "ok", value: "recorded" });
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag === "ok" ? pending.value : []).toHaveLength(1);
  expect(await Bun.file(join(spoolRoot, "dispatches")).exists()).toBe(false);
});

test("agent timeout terminates the owned process group", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-process-group-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
(trap '' TERM; /bin/sleep 0.5; printf '%s\\n' alive > "\${0}.marker") &
wait
`,
  );
  await chmod(fakeAgent, 0o755);
  const outcome = await runAgentProcess({
    executable: fakeAgent,
    args: [],
    cwd: root,
    prompt: "",
    timeoutMs: 50,
    eventsPath: join(root, "events.jsonl"),
    finalOutputPath: join(root, "final.md"),
    rawFinalOutputPath: join(root, "raw-final.md"),
    stderrPath: join(root, "stderr.log"),
    environment: { PATH: "/bin:/usr/bin" },
    terminationGraceMs: 50,
  });
  expect(outcome._tag === "ok" ? outcome.value.status : "error").toBe("timed_out");
  await Bun.sleep(600);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(false);
});

test("supervisor reaps surviving descendants after the direct child exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-child-close-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  const rawFinalOutputPath = join(root, "raw-final.md");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
printf '%s\\n' complete > "${rawFinalOutputPath}"
(trap '' TERM; /bin/sleep 0.5; printf '%s\\n' alive > "\${0}.marker") &
exit 0
`,
  );
  await chmod(fakeAgent, 0o755);
  const outcome = await runAgentProcess({
    executable: fakeAgent,
    args: [],
    cwd: root,
    prompt: "",
    timeoutMs: 2_000,
    eventsPath: join(root, "events.jsonl"),
    finalOutputPath: join(root, "final.md"),
    rawFinalOutputPath,
    stderrPath: join(root, "stderr.log"),
    environment: { PATH: "/bin:/usr/bin" },
    terminationGraceMs: 50,
  });
  expect(outcome._tag === "ok" ? outcome.value.status : "error").toBe("complete");
  await Bun.sleep(600);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(false);
});

test("prompt-write failure kills descendants and removes raw final output", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-prompt-failure-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
exec 0<&-
(trap '' TERM; /bin/sleep 0.5; printf '%s\\n' alive > "\${0}.marker") &
/bin/sleep 1
`,
  );
  await chmod(fakeAgent, 0o755);
  const rawFinalOutputPath = join(root, "raw-final.md");
  await writeFile(rawFinalOutputPath, "token=raw-secret\n");
  const outcome = await runAgentProcess({
    executable: fakeAgent,
    args: [],
    cwd: root,
    prompt: "x".repeat(1_000_000),
    timeoutMs: 2_000,
    eventsPath: join(root, "events.jsonl"),
    finalOutputPath: join(root, "final.md"),
    rawFinalOutputPath,
    stderrPath: join(root, "stderr.log"),
    environment: { PATH: "/bin:/usr/bin" },
    terminationGraceMs: 50,
  });
  expect(outcome._tag).toBe("err");
  expect(outcome._tag === "err" ? outcome.error.operation : "").toBe("write_prompt");
  await Bun.sleep(600);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(false);
  expect(await Bun.file(rawFinalOutputPath).exists()).toBe(false);
});

test("raw final output survives until its atomic redacted projection verifies", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-final-projection-failure-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  const rawFinalOutputPath = join(root, "raw-final.md");
  const finalOutputPath = join(root, "final.md");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
printf '%s\\n' 'token=raw-secret' > "${rawFinalOutputPath}"
`,
  );
  await chmod(fakeAgent, 0o755);
  await mkdir(finalOutputPath);
  const outcome = await runAgentProcess({
    executable: fakeAgent,
    args: [],
    cwd: root,
    prompt: "",
    timeoutMs: 2_000,
    eventsPath: join(root, "events.jsonl"),
    finalOutputPath,
    rawFinalOutputPath,
    stderrPath: join(root, "stderr.log"),
    environment: { PATH: "/bin:/usr/bin" },
    terminationGraceMs: 50,
  });
  expect(outcome._tag).toBe("err");
  expect(outcome._tag === "err" ? outcome.error.operation : "").toBe("observe");
  expect(await Bun.file(rawFinalOutputPath).exists()).toBe(true);
});

test("abandoned recovery atomically replaces a partial final projection", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-partial-final-"));
  temporaryDirectories.push(root);
  const rawFinalOutputPath = join(root, "raw.md");
  const finalOutputPath = join(root, "final.md");
  await writeFile(rawFinalOutputPath, "token=recovery-secret\ncomplete\n");
  await writeFile(finalOutputPath, "part");
  const recovered = await recoverDoctorRawFinalOutput({
    schemaVersion: 1,
    dispatchId: "dispatch",
    incidentId: "incident",
    fingerprint: "a".repeat(64),
    startedAt: "2026-07-30T09:00:00.000Z",
    worktreePath: root,
    command: ["/fake/codex"],
    eventsPath: join(root, "events"),
    finalOutputPath,
    rawFinalOutputPath,
    stderrPath: join(root, "stderr"),
    processToken: "44444444-4444-4444-8444-444444444444",
    supervisorControlDirectory: join(root, "control"),
    pid: null,
    pgid: null,
    policyStateReserved: {
      schemaVersion: 1,
      dateKey: "2026-07-30",
      runsToday: 1,
      consecutiveFailures: 0,
      lastStartedAt: "2026-07-30T09:00:00.000Z",
      circuitOpenedAt: null,
    },
  });
  expect(recovered._tag).toBe("ok");
  expect(await readFile(finalOutputPath, "utf8")).toBe("token=[REDACTED]\ncomplete\n");
  expect(await Bun.file(rawFinalOutputPath).exists()).toBe(false);
});

test("dispatcher lease takeover is exclusive and a former owner cannot release its successor", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-dispatcher-lock-"));
  temporaryDirectories.push(root);
  const lockConfig = { ...config(root, "/fake/codex"), timeoutMs: 50 };
  const first = await acquireDoctorDispatcherLock(lockConfig, new Date("2026-07-30T09:00:00Z"));
  expect(first._tag).toBe("ok");
  if (first._tag === "err" || first.value === "busy") return;
  const staleTakeover = join(first.value.ownerDirectory, "takeover");
  await mkdir(staleTakeover);
  await writeFile(
    join(staleTakeover, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "11111111-1111-4111-8111-111111111111",
      pid: 2_147_483_647,
      acquiredAt: "2026-07-30T09:00:00.000Z",
    })}\n`,
  );
  const takeoverTime = new Date("2026-07-30T09:02:00Z");
  const liveContender = await acquireDoctorDispatcherLock(lockConfig, takeoverTime);
  expect(liveContender._tag === "ok" ? liveContender.value : "error").toBe("busy");
  await releaseDoctorDispatcherLock(first.value);
  const [left, right] = await Promise.all([
    acquireDoctorDispatcherLock(lockConfig, takeoverTime),
    acquireDoctorDispatcherLock(lockConfig, takeoverTime),
  ]);
  const successors = [left, right].filter(
    (result) => result._tag === "ok" && result.value !== "busy",
  );
  expect(successors).toHaveLength(1);
  const successorResult = successors[0];
  if (!successorResult || successorResult._tag === "err" || successorResult.value === "busy")
    return;
  const canonical = JSON.parse(
    await readFile(doctorSpoolPaths(lockConfig.spoolRoot).lock, "utf8"),
  ) as { token: string };
  expect(canonical.token).toBe(successorResult.value.token);
  const contender = await acquireDoctorDispatcherLock(lockConfig, takeoverTime);
  expect(contender._tag === "ok" ? contender.value : "error").toBe("busy");
  await releaseDoctorDispatcherLock(successorResult.value);
});

test("fingerprint lease release cannot remove a successor lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-fingerprint-lock-"));
  temporaryDirectories.push(root);
  const paths = doctorSpoolPaths(join(root, "logs", "doctor"));
  const fingerprint = "a".repeat(64);
  const first = await acquireDoctorFingerprintLock(paths, fingerprint);
  expect(first._tag).toBe("ok");
  if (first._tag === "err") return;
  await releaseDoctorFingerprintLock(first.value);
  const staleTakeover = join(first.value.ownerDirectory, "takeover");
  await mkdir(staleTakeover);
  await writeFile(
    join(staleTakeover, "owner.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      token: "22222222-2222-4222-8222-222222222222",
      pid: 2_147_483_647,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    })}\n`,
  );
  const second = await acquireDoctorFingerprintLock(paths, fingerprint);
  expect(second._tag).toBe("ok");
  if (second._tag === "err") return;
  await releaseDoctorFingerprintLock(first.value);
  const canonical = JSON.parse(
    await readFile(join(paths.recordLocks, `${fingerprint}.lock`), "utf8"),
  ) as { token: string };
  expect(canonical.token).toBe(second.value.token);
  await releaseDoctorFingerprintLock(second.value);
});

test("an absent dispatcher lock still reconciles and receipts an active attempt", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-orphan-recovery-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = TEST_GIT_EXECUTABLE;
  await runCommand([git, "init"], repo);
  await runCommand([git, "config", "user.email", "doctor@example.test"], repo);
  await runCommand([git, "config", "user.name", "Doctor Test"], repo);
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await runCommand([git, "add", "tracked.txt"], repo);
  await runCommand([git, "commit", "-m", "fixture"], repo);
  const head = await resolveRepoHead(repo, git, process.env);
  expect(head._tag).toBe("ok");
  if (head._tag === "err") return;
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
trap '' TERM
raw=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--output-last-message" ]; then
    shift
    raw="$1"
  fi
  shift
done
printf '%s\\n' 'token=abandoned-secret' > "$raw"
printf '%s\\n' started > "${fakeAgent}.started"
(trap '' TERM; /bin/sleep 0.6; printf '%s\\n' alive > "${fakeAgent}.marker") &
wait
`,
  );
  await chmod(fakeAgent, 0o755);
  const spoolRoot = join(root, "logs", "doctor");
  await recordDoctorIncident(
    spoolRoot,
    repairIncident("TypeError: orphan recovery fixture"),
    head.value,
    new Date(),
  );
  const runner = join(root, "dispatcher-runner.ts");
  const dispatcherModule = join(process.cwd(), "src", "doctor", "dispatcher.ts");
  await writeFile(
    runner,
    `import { runPendingDoctor } from ${JSON.stringify(dispatcherModule)};
await runPendingDoctor(${JSON.stringify({
      repoRoot: repo,
      spoolRoot,
      agentExecutable: fakeAgent,
      gitExecutable: git,
      timeoutMs: 5_000,
      cooldownMs: 1,
      maxRunsPerDay: 1,
      circuitFailureThreshold: 3,
      circuitOpenMs: 86_400_000,
    })});
`,
  );
  const child = Bun.spawn([process.execPath, runner], {
    cwd: repo,
    stdout: "ignore",
    stderr: "ignore",
  });
  let active = await listActiveDoctorDispatchAttempts(spoolRoot);
  for (
    let attempt = 0;
    attempt < 300 &&
    (active._tag === "err" ||
      active.value[0]?.attempt.pid === null ||
      active.value[0]?.attempt.pid === undefined);
    attempt++
  ) {
    await Bun.sleep(10);
    active = await listActiveDoctorDispatchAttempts(spoolRoot);
  }
  expect(active._tag).toBe("ok");
  expect(active._tag === "ok" ? active.value[0]?.attempt.pid : null).toBeNumber();
  for (
    let attempt = 0;
    attempt < 300 && !(await Bun.file(`${fakeAgent}.started`).exists());
    attempt++
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(`${fakeAgent}.started`).exists()).toBe(true);
  if (active._tag === "err" || !active.value[0]) return;
  const abandonedAttempt = active.value[0].attempt;
  process.kill(child.pid, "SIGKILL");
  await child.exited;
  const lockPath = doctorSpoolPaths(spoolRoot).lock;
  await unlink(lockPath);
  const recovered = await runPendingDoctor(
    {
      ...config(root, fakeAgent),
      repoRoot: repo,
      spoolRoot,
      timeoutMs: 50,
      cooldownMs: 1,
      maxRunsPerDay: 1,
    },
    { clock: { now: () => new Date("2026-07-30T09:02:00.000Z") } },
  );
  expect(recovered._tag).toBe("ok");
  expect(recovered._tag === "ok" ? recovered.value._tag : "error").toBe("deferred");
  await Bun.sleep(700);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(false);
  expect(await Bun.file(abandonedAttempt.rawFinalOutputPath).exists()).toBe(false);
  expect(await readFile(abandonedAttempt.finalOutputPath, "utf8")).toBe("token=[REDACTED]\n");
  const remainingActive = await listActiveDoctorDispatchAttempts(spoolRoot);
  expect(remainingActive._tag === "ok" ? remainingActive.value : []).toHaveLength(0);
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag === "ok" ? pending.value[0]?.attempts[0]?.status : null).toBe("failed");
});

test("recovery never signals a live PGID after its token heartbeat owner exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-unverified-pgid-"));
  temporaryDirectories.push(root);
  const repo = join(root, "repo");
  await mkdir(repo);
  const git = TEST_GIT_EXECUTABLE;
  await runCommand([git, "init"], repo);
  await runCommand([git, "config", "user.email", "doctor@example.test"], repo);
  await runCommand([git, "config", "user.name", "Doctor Test"], repo);
  await writeFile(join(repo, "tracked.txt"), "committed\n");
  await runCommand([git, "add", "tracked.txt"], repo);
  await runCommand([git, "commit", "-m", "fixture"], repo);
  const head = await resolveRepoHead(repo, git, process.env);
  expect(head._tag).toBe("ok");
  if (head._tag === "err") return;
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
trap '' TERM
printf '%s\\n' started > "${fakeAgent}.started"
(trap '' TERM; /bin/sleep 4; printf '%s\\n' alive > "${fakeAgent}.marker") &
wait
`,
  );
  await chmod(fakeAgent, 0o755);
  const spoolRoot = join(root, "logs", "doctor");
  await recordDoctorIncident(
    spoolRoot,
    repairIncident("TypeError: unverified pgid fixture"),
    head.value,
    new Date(),
  );
  const runner = join(root, "dispatcher-runner.ts");
  const dispatcherModule = join(process.cwd(), "src", "doctor", "dispatcher.ts");
  await writeFile(
    runner,
    `import { runPendingDoctor } from ${JSON.stringify(dispatcherModule)};
await runPendingDoctor(${JSON.stringify({
      repoRoot: repo,
      spoolRoot,
      agentExecutable: fakeAgent,
      gitExecutable: git,
      timeoutMs: 5_000,
      cooldownMs: 1,
      maxRunsPerDay: 2,
      circuitFailureThreshold: 3,
      circuitOpenMs: 86_400_000,
    })});
`,
  );
  const dispatcher = Bun.spawn([process.execPath, runner], {
    cwd: repo,
    stdout: "ignore",
    stderr: "ignore",
  });
  let active = await listActiveDoctorDispatchAttempts(spoolRoot);
  for (
    let attempt = 0;
    attempt < 300 &&
    (active._tag === "err" ||
      active.value[0]?.attempt.pid === null ||
      active.value[0]?.attempt.pid === undefined ||
      !(await Bun.file(`${fakeAgent}.started`).exists()));
    attempt++
  ) {
    await Bun.sleep(10);
    active = await listActiveDoctorDispatchAttempts(spoolRoot);
  }
  expect(active._tag).toBe("ok");
  if (active._tag === "err" || !active.value[0]) return;
  const abandonedAttempt = active.value[0].attempt;
  const supervisorPid = abandonedAttempt.pid;
  if (supervisorPid === null) return;
  process.kill(dispatcher.pid, "SIGKILL");
  await dispatcher.exited;
  process.kill(supervisorPid, "SIGKILL");
  await Bun.sleep(2_200);
  const lockPath = doctorSpoolPaths(spoolRoot).lock;
  const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
    schemaVersion: 1;
    token: string;
    pid: number;
    acquiredAt: string;
  };
  await writeFile(
    lockPath,
    `${JSON.stringify({ ...owner, acquiredAt: "2026-07-30T09:00:00.000Z" })}\n`,
  );
  const staleHeartbeat = new Date("2026-07-30T09:00:00.000Z");
  await utimes(
    join(doctorSpoolPaths(spoolRoot).lockOwners, owner.token, "heartbeat"),
    staleHeartbeat,
    staleHeartbeat,
  );
  const recovered = await runPendingDoctor(
    {
      ...config(root, fakeAgent),
      repoRoot: repo,
      spoolRoot,
      timeoutMs: 50,
      cooldownMs: 1,
      maxRunsPerDay: 2,
    },
    { clock: { now: () => new Date("2026-07-30T09:02:00.000Z") } },
  );
  expect(recovered._tag).toBe("err");
  expect(recovered._tag === "err" ? recovered.error.message : "").toContain(
    "refusing to signal or dispatch",
  );
  await Bun.sleep(2_000);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(true);
  const remainingActive = await listActiveDoctorDispatchAttempts(spoolRoot);
  expect(remainingActive._tag === "ok" ? remainingActive.value : []).toHaveLength(1);
}, 10_000);

test("durable supervisor enforces timeout after its dispatcher is killed", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-supervisor-timeout-"));
  temporaryDirectories.push(root);
  const fakeAgent = join(root, "fake-codex");
  await writeFile(
    fakeAgent,
    `#!/bin/sh
trap '' TERM
printf '%s\\n' started > "${fakeAgent}.started"
(trap '' TERM; /bin/sleep 2; printf '%s\\n' alive > "${fakeAgent}.marker") &
wait
`,
  );
  await chmod(fakeAgent, 0o755);
  const runner = join(root, "agent-runner.ts");
  const agentModule = join(process.cwd(), "src", "doctor", "agentProcess.ts");
  await writeFile(
    runner,
    `import { runAgentProcess } from ${JSON.stringify(agentModule)};
await runAgentProcess({
  executable: ${JSON.stringify(fakeAgent)},
  args: [],
  cwd: ${JSON.stringify(root)},
  prompt: "",
  timeoutMs: 1_000,
  terminationGraceMs: 50,
  eventsPath: ${JSON.stringify(join(root, "events.jsonl"))},
  finalOutputPath: ${JSON.stringify(join(root, "final.md"))},
  rawFinalOutputPath: ${JSON.stringify(join(root, "raw.md"))},
  stderrPath: ${JSON.stringify(join(root, "stderr.log"))},
  environment: { PATH: "/bin:/usr/bin" },
});
`,
  );
  const dispatcher = Bun.spawn([process.execPath, runner], {
    cwd: root,
    stdout: "ignore",
    stderr: "ignore",
  });
  for (
    let attempt = 0;
    attempt < 300 && !(await Bun.file(`${fakeAgent}.started`).exists());
    attempt++
  ) {
    await Bun.sleep(10);
  }
  expect(await Bun.file(`${fakeAgent}.started`).exists()).toBe(true);
  process.kill(dispatcher.pid, "SIGKILL");
  await dispatcher.exited;
  await Bun.sleep(2_200);
  expect(await Bun.file(`${fakeAgent}.marker`).exists()).toBe(false);
});

test("durable supervisor rejects malformed configuration with Zod", async () => {
  const supervisor = join(process.cwd(), "src", "doctor", "processSupervisor.ts");
  const child = Bun.spawn([process.execPath, supervisor], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      JOBSRADAR_DOCTOR_SUPERVISOR_CONFIG: Buffer.from(
        JSON.stringify({ token: "not-a-uuid" }),
      ).toString("base64url"),
    },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("ZodError");
});

test("durable incident JSON is fully parsed rather than discriminator-checked", async () => {
  const root = await mkdtemp(join(tmpdir(), "jobsradar-doctor-zod-"));
  temporaryDirectories.push(root);
  const spoolRoot = join(root, "logs", "doctor");
  const incident = repairIncident("TypeError: invalid local state");
  const recorded = await recordDoctorIncident(
    spoolRoot,
    incident,
    "a".repeat(40),
    new Date("2026-07-30T09:00:00Z"),
  );
  expect(recorded._tag).toBe("ok");
  if (recorded._tag === "err") return;
  const corrupt = {
    ...recorded.value.incident,
    evidence: undefined,
  };
  await writeFile(recorded.value.path, `${JSON.stringify(corrupt)}\n`);
  const pending = await listPendingDoctorIncidents(spoolRoot);
  expect(pending._tag).toBe("err");
});
