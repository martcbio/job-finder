import { createLabOpeningsModule } from "./labOpenings";

interface CliOptions {
  command: "record" | "inspect";
  json: boolean;
  help: boolean;
  scheduledAt?: string;
}

function usage(): string {
  return [
    "Usage:",
    "  bun run labs:openings [record] [--scheduled-at <ISO-8601>]",
    "  bun run labs:openings -- inspect [--json]",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  let command: CliOptions["command"] = "record";
  let json = false;
  let help = false;
  let scheduledAt: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "record" || argument === "inspect") {
      command = argument;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--scheduled-at") {
      const value = argv[index + 1];
      if (!value) throw new Error("--scheduled-at requires an ISO-8601 timestamp");
      scheduledAt = value;
      index++;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n\n${usage()}`);
  }

  if (command === "inspect" && scheduledAt) {
    throw new Error("--scheduled-at is only valid with record");
  }
  return { command, json, help, ...(scheduledAt ? { scheduledAt } : {}) };
}

export function exitCodeForRecordStatus(
  status: "complete" | "degraded" | "failed" | "locked",
): 0 | 1 {
  return status === "complete" ? 0 : 1;
}

function renderInspection(
  report: Awaited<ReturnType<ReturnType<typeof createLabOpeningsModule>["inspect"]>>,
): string {
  const lines = [`Lab openings checked at ${report.checkedAt}`];
  for (const projection of report.projections) {
    lines.push(
      "",
      `${projection.projectionId}: ${projection.diagnosis.code}`,
      projection.diagnosis.message,
    );
    for (const cause of projection.diagnosis.causes) lines.push(`- ${cause}`);
    lines.push(
      "",
      "Repair:",
      `  cd ${projection.repair.cwd}`,
      `  ${projection.repair.argv.join(" ")}`,
    );
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return;
  }
  const labOpenings = createLabOpeningsModule();

  if (options.command === "inspect") {
    const report = await labOpenings.inspect(["lab-openings"]);
    console.log(options.json ? JSON.stringify(report, null, 2) : renderInspection(report));
    if (report.projections.some((item) => item.diagnosis.severity === "error")) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await labOpenings.record({
    trigger: options.scheduledAt ? "scheduled" : "manual",
    ...(options.scheduledAt ? { scheduledAt: options.scheduledAt } : {}),
  });
  if (result.status === "locked") {
    console.error(
      `Lab openings run ${result.runId} did not start because ${result.owner?.runId ?? "another invocation"} owns the publication lock.`,
    );
    process.exitCode = exitCodeForRecordStatus(result.status);
    return;
  }

  console.log(
    `Lab openings run ${result.runId} finished with status ${result.status}. Generation: ${result.generationDir}`,
  );
  for (const diagnostic of result.record.diagnostics) console.error(diagnostic);
  for (const warning of result.legacyWarnings) console.error(warning);
  process.exitCode = exitCodeForRecordStatus(result.status);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
