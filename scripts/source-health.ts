import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  type SourceHealthFilters,
  type SourceHealthRow,
  buildSourceHealthSql,
  renderSourceHealthMarkdown,
} from "../src/pipeline/sourceHealth";

type SourceHealthFormat = "json" | "markdown";

interface SourceHealthOptions extends SourceHealthFilters {
  format: SourceHealthFormat;
  output: string | null;
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

function readNumberFlag(args: string[], name: string, fallback: number | null): number | null {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptions(args: string[]): SourceHealthOptions {
  const formatValue = readStringFlag(args, "--format") ?? "markdown";
  if (formatValue !== "markdown" && formatValue !== "json") {
    throw new Error('--format must be "markdown" or "json"');
  }

  return {
    days: readNumberFlag(args, "--days", null),
    minAttempts: readNumberFlag(args, "--min-attempts", 1) ?? 1,
    format: formatValue,
    output: readStringFlag(args, "--output"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run source:health -- --days 14
  bun run source:health -- --format json --min-attempts 3
  bun run source:health -- --output docs/source-health.md

Options:
  --days          Only include source attempts from the last N days. Defaults to all stored attempts.
  --min-attempts  Minimum attempts per source. Defaults to 1.
  --format        markdown or json. Defaults to markdown.
  --output        Optional repo-local output path. Refuses /tmp and paths outside this project.

Requires DATABASE_URL and the job_search schema.`);
}

function assertRepoLocalOutput(output: string): string {
  const resolved = resolve(output);
  const root = process.cwd();
  const inRepo = resolved === root || resolved.startsWith(`${root}/`);
  if (!inRepo) {
    throw new Error(`--output must stay inside this project: ${output}`);
  }
  if (resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/")) {
    throw new Error("--output must not write artifacts under /tmp");
  }
  return resolved;
}

async function writeOrPrint(content: string, output: string | null): Promise<void> {
  if (output === null) {
    console.log(content.endsWith("\n") ? content.slice(0, -1) : content);
    return;
  }

  const resolved = assertRepoLocalOutput(output);
  await mkdir(dirname(resolved), { recursive: true });
  await Bun.write(resolved, content);
  console.error(`Wrote ${resolved}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<SourceHealthRow[]>(buildSourceHealthSql(options));
  const content =
    options.format === "json"
      ? `${JSON.stringify(rows, null, 2)}\n`
      : renderSourceHealthMarkdown(rows, { generatedAt: new Date(), filters: options });

  await writeOrPrint(content, options.output);
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
