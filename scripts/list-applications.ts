import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson } from "../src/db/psql";
import {
  type ApplicationListRow,
  type ApplicationStatus,
  buildListApplicationsSql,
  isApplicationStatus,
  renderApplicationsMarkdown,
} from "../src/pipeline/jobApplications";

interface ListApplicationsOptions {
  status: ApplicationStatus | undefined;
  limit: number;
  output: string | null;
  json: boolean;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }

  return value;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseStatus(value: string | null): ApplicationStatus | undefined {
  if (value === null) return undefined;
  if (!isApplicationStatus(value)) {
    throw new Error(`Unsupported application status "${value}"`);
  }
  return value;
}

function parseOptions(args: string[]): ListApplicationsOptions {
  return {
    status: parseStatus(readStringFlag(args, "--status")),
    limit: readNumberFlag(args, "--limit", 25),
    output: readStringFlag(args, "--output"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run applications:list -- --limit 25
  bun run applications:list -- --status waiting --output docs/applications.md
  bun run applications:list -- --json

Options:
  --status  Optional filter: prepared, applied, waiting, rejected_by_company, or withdrawn.
  --limit   Maximum rows. Defaults to 25.
  --output  Optional Markdown output path.
  --json    Print machine-readable output.`);
}

async function writeOrPrint(content: string, output: string | null): Promise<void> {
  if (!output) {
    console.log(content);
    return;
  }

  const resolved = resolve(output);
  await mkdir(dirname(resolved), { recursive: true });
  await Bun.write(resolved, content);
  console.log(`Wrote ${resolved}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<ApplicationListRow[]>(
    buildListApplicationsSql({
      limit: options.limit,
      ...(options.status ? { status: options.status } : {}),
    }),
  );

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  await writeOrPrint(renderApplicationsMarkdown(rows), options.output);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
