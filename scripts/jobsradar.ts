import { fileURLToPath } from "node:url";
import {
  launchDetachedDoctorDispatcher,
  DetachedDispatcherError,
} from "../src/doctor/detachedDispatcher";
import {
  classifyIngestResult,
  classifyIngestThrow,
  type DoctorClassification,
} from "../src/doctor/incident";
import {
  resolveCodexExecutable,
  resolveGitExecutable,
  resolveRepoHead,
  type DoctorGitError,
} from "../src/doctor/gitWorktree";
import {
  attachDoctorIncidentRepoHead,
  recordDoctorIncident,
  recordDoctorLauncherFailure,
  type DoctorSpoolError,
} from "../src/doctor/spool";
import { err, ok, type Result } from "../src/doctor/result";
import { runJobIngest, type JobIngestOptionsInput } from "../src/pipeline/jobIngest";

interface CliOptions {
  command: "ingest";
  json: boolean;
  help: boolean;
  ingest: JobIngestOptionsInput;
}

class JobsradarCliError extends Error {
  readonly _tag = "JobsradarCliError" as const;
}

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const doctorSpoolRoot =
  process.env.JOBSRADAR_DOCTOR_SPOOL ?? `${repoRoot}/logs/doctor`;

function usage(): string {
  return [
    "Usage:",
    "  jobsradar ingest [--source <id>] [--json]",
    "",
    "Raw acquisition only: fetch, preserve evidence, normalize, and persist.",
    "Default sources include bounded JobServe plus lab ATS, Linear, and Google Careers.",
    "JobServe runs locally with pacing and immediate fair-use aborts.",
  ].join("\n");
}

function requiredValue(
  argv: string[],
  index: number,
  flag: string,
): Result<string, JobsradarCliError> {
  const value = argv[index + 1];
  return value
    ? ok(value)
    : err(new JobsradarCliError(`${flag} requires a value`));
}

function positiveInteger(value: string, flag: string): Result<number, JobsradarCliError> {
  if (!/^[1-9]\d*$/.test(value)) {
    return err(new JobsradarCliError(`${flag} requires a positive integer`));
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    return err(new JobsradarCliError(`${flag} requires a safe positive integer`));
  }
  return ok(parsed);
}

function parseArgs(argv: string[]): Result<CliOptions, JobsradarCliError> {
  let command: CliOptions["command"] = "ingest";
  let json = false;
  let help = false;
  const sourceIds: string[] = [];
  const jobserveQueries: string[] = [];
  const ingest: JobIngestOptionsInput = {};

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "ingest") {
      command = "ingest";
      continue;
    }
    if (argument === "--source") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      sourceIds.push(value.value);
      index++;
      continue;
    }
    if (argument === "--jobserve-query") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      jobserveQueries.push(value.value);
      index++;
      continue;
    }
    if (argument === "--jobserve-max-pages") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      const parsed = positiveInteger(value.value, argument);
      if (parsed._tag === "err") return parsed;
      ingest.jobserveMaxPages = parsed.value;
      index++;
      continue;
    }
    if (argument === "--jobserve-detail-limit") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      const parsed = positiveInteger(value.value, argument);
      if (parsed._tag === "err") return parsed;
      ingest.jobserveImportLimitPerQuery = parsed.value;
      index++;
      continue;
    }
    if (argument === "--direct-limit") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      const parsed = positiveInteger(value.value, argument);
      if (parsed._tag === "err") return parsed;
      ingest.directLimit = parsed.value;
      index++;
      continue;
    }
    if (argument === "--timeout-ms") {
      const value = requiredValue(argv, index, argument);
      if (value._tag === "err") return value;
      const parsed = positiveInteger(value.value, argument);
      if (parsed._tag === "err") return parsed;
      ingest.timeoutMs = parsed.value;
      index++;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    return err(new JobsradarCliError(`Unknown argument: ${argument}\n\n${usage()}`));
  }

  if (sourceIds.length > 0) ingest.sourceIds = sourceIds;
  if (jobserveQueries.length > 0) ingest.jobserveQueries = jobserveQueries;
  return ok({ command, json, help, ingest });
}

function renderResult(result: Awaited<ReturnType<typeof runJobIngest>>): string {
  const lines = [`jobsradar ingest: ${result.status}`];
  for (const source of result.sources) {
    lines.push(
      `${source.id}: ${source.status}; discovered=${source.discovered}; imported=${source.imported}`,
    );
    for (const error of source.errors) lines.push(`  ${error}`);
  }
  return lines.join("\n");
}

export async function dispatchDoctor(
  classification: DoctorClassification,
  context: {
    readonly repoRoot: string;
    readonly spoolRoot: string;
    readonly environment: NodeJS.ProcessEnv;
  } = { repoRoot, spoolRoot: doctorSpoolRoot, environment: process.env },
): Promise<
  Result<"not_needed" | "launched", DoctorSpoolError | DetachedDispatcherError | DoctorGitError>
> {
  if (classification._tag !== "repair") return ok("not_needed");
  const now = new Date();
  const recorded = await recordDoctorIncident(
    context.spoolRoot,
    classification.incident,
    null,
    now,
  );
  if (recorded._tag === "err") return recorded;
  const gitExecutable = await resolveGitExecutable(context.environment);
  if (gitExecutable._tag === "err") {
    await recordDoctorLauncherFailure(context.spoolRoot, gitExecutable.error.message, now);
    return gitExecutable;
  }
  const repoHead = await resolveRepoHead(
    context.repoRoot,
    gitExecutable.value,
    context.environment,
  );
  if (repoHead._tag === "err") {
    await recordDoctorLauncherFailure(context.spoolRoot, repoHead.error.message, now);
    return repoHead;
  }
  if (recorded.value.incident.repoHead === null) {
    const attached = await attachDoctorIncidentRepoHead(
      context.spoolRoot,
      recorded.value.path,
      recorded.value.incident.fingerprint,
      repoHead.value,
    );
    if (attached._tag === "err") return attached;
  }
  const codexExecutable = await resolveCodexExecutable(context.environment);
  if (codexExecutable._tag === "err") {
    await recordDoctorLauncherFailure(context.spoolRoot, codexExecutable.error.message, now);
    return codexExecutable;
  }
  const launched = await launchDetachedDoctorDispatcher(
    {
      repoRoot: context.repoRoot,
      spoolRoot: context.spoolRoot,
      bunExecutable: process.execPath,
      dispatcherScript: `${context.repoRoot}/scripts/jobsradar-doctor.ts`,
      codexExecutable: codexExecutable.value,
      gitExecutable: gitExecutable.value,
    },
    now,
  );
  return launched._tag === "err" ? launched : ok("launched");
}

async function handleTerminalClassification(classification: DoctorClassification): Promise<void> {
  const dispatched = await dispatchDoctor(classification);
  if (dispatched._tag === "err") {
    const artifact =
      dispatched.error instanceof DetachedDispatcherError && dispatched.error.failureArtifact
        ? `; recoverable failure artifact: ${dispatched.error.failureArtifact}`
        : "";
    console.error(
      `jobsradar doctor dispatch failed: ${dispatched.error.message}${artifact}; recover with bun run jobsradar:doctor -- run-pending`,
    );
    process.exitCode = 1;
  }
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed._tag === "err") {
    console.error(parsed.error.message);
    process.exitCode = 2;
    await handleTerminalClassification(classifyIngestThrow(parsed.error));
    return;
  }
  const options = parsed.value;
  if (options.help) {
    console.log(usage());
    return;
  }
  try {
    const result = await runJobIngest(options.ingest);
    console.log(options.json ? JSON.stringify(result, null, 2) : renderResult(result));
    process.exitCode = result.status === "complete" ? 0 : 1;
    await handleTerminalClassification(classifyIngestResult(result));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    await handleTerminalClassification(classifyIngestThrow(error));
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
