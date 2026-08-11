import { fileURLToPath } from "node:url";
import {
  parseDoctorDispatcherConfig,
  readDoctorStatus,
  runPendingDoctor,
  type DoctorDispatchOutcome,
} from "../src/doctor/dispatcher";
import { resolveCodexExecutable, resolveGitExecutable } from "../src/doctor/gitWorktree";

interface CliOptions {
  readonly command: "run-pending" | "status";
  readonly json: boolean;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run jobsradar:doctor -- run-pending [--json]",
    "  bun run jobsradar:doctor -- status [--json]",
    "",
    "run-pending invokes at most one bounded local Codex Doctor.",
    "status is read-only and never invokes a model.",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions | Error {
  let command: CliOptions["command"] = "status";
  let json = false;
  for (const argument of argv) {
    if (argument === "run-pending" || argument === "status") {
      command = argument;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--help" || argument === "-h") {
      return new Error(usage());
    } else {
      return new Error(`Unknown argument: ${argument}\n\n${usage()}`);
    }
  }
  return { command, json };
}

function renderOutcome(outcome: DoctorDispatchOutcome): string {
  switch (outcome._tag) {
    case "no_pending":
      return "jobsradar doctor: no pending incidents";
    case "busy":
      return "jobsradar doctor: dispatcher already running";
    case "deferred":
      return `jobsradar doctor: deferred (${outcome.reason})${
        outcome.nextEligibleAt ? ` until ${outcome.nextEligibleAt}` : ""
      }`;
    case "dispatched":
      return [
        `jobsradar doctor: ${outcome.receipt.status}`,
        `incident=${outcome.receipt.incidentId}`,
        `events=${outcome.receipt.eventsPath}`,
        `final=${outcome.receipt.finalOutputPath}`,
      ].join("\n");
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options instanceof Error) {
    const help = options.message === usage();
    (help ? console.log : console.error)(options.message);
    process.exitCode = help ? 0 : 2;
    return;
  }
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  if (options.command === "status") {
    const config = parseDoctorDispatcherConfig(repoRoot, {
      ...process.env,
      // Status never consumes tool paths; configured malformed values must not affect it.
      JOBSRADAR_DOCTOR_CODEX_PATH: "/dev/null",
      JOBSRADAR_DOCTOR_GIT_PATH: "/dev/null",
    });
    if (config._tag === "err") {
      console.error(config.error.message);
      process.exitCode = 2;
      return;
    }
    const status = await readDoctorStatus(config.value, new Date());
    if (status._tag === "err") {
      console.error(status.error.message);
      process.exitCode = 1;
      return;
    }
    console.log(
      options.json
        ? JSON.stringify(status.value, null, 2)
        : [
            `jobsradar doctor: pending=${status.value.pendingCount}`,
            `runs_today=${status.value.state.runsToday}`,
            `consecutive_failures=${status.value.state.consecutiveFailures}`,
            `circuit_opened_at=${status.value.state.circuitOpenedAt ?? "none"}`,
          ].join("\n"),
    );
    return;
  }
  const [codexExecutable, gitExecutable] = await Promise.all([
    resolveCodexExecutable(process.env),
    resolveGitExecutable(process.env),
  ]);
  if (codexExecutable._tag === "err") {
    console.error(codexExecutable.error.message);
    process.exitCode = 2;
    return;
  }
  if (gitExecutable._tag === "err") {
    console.error(gitExecutable.error.message);
    process.exitCode = 2;
    return;
  }
  const config = parseDoctorDispatcherConfig(repoRoot, {
    ...process.env,
    JOBSRADAR_DOCTOR_CODEX_PATH: codexExecutable.value,
    JOBSRADAR_DOCTOR_GIT_PATH: gitExecutable.value,
  });
  if (config._tag === "err") {
    console.error(config.error.message);
    process.exitCode = 2;
    return;
  }
  const outcome = await runPendingDoctor(config.value);
  if (outcome._tag === "err") {
    console.error(outcome.error.message);
    process.exitCode = 1;
    return;
  }
  console.log(options.json ? JSON.stringify(outcome.value, null, 2) : renderOutcome(outcome.value));
  process.exitCode =
    outcome.value._tag === "dispatched" && outcome.value.receipt.status !== "complete" ? 1 : 0;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
