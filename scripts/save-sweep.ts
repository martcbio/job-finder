import { runPsqlJson } from "../src/db/psql";
import { type SavedSweepInput, type SavedSweepRow, buildUpsertSavedSweepSql } from "../src/pipeline/savedSweeps";
import { isBrianTimeFilter } from "../src/pipeline/searchEngines";

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRepeatedFlag(args: string[], names: string[]): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag || !names.includes(flag)) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${flag} requires a value`);
    }
    values.push(...splitList(value));
    i++;
  }

  return values;
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

function readFloatFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;

  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new Error(`${name} must be a number greater than 0 and less than or equal to 1`);
  }

  return parsed;
}

function parseOptions(args: string[]): SavedSweepInput {
  const name = readStringFlag(args, "--name");
  if (name === null) {
    throw new Error("--name is required");
  }

  const keywords = readRepeatedFlag(args, ["--keyword", "-k"]);
  const sites = readRepeatedFlag(args, ["--site", "-s"]);
  const timeFilter = readStringFlag(args, "--time") ?? "24hours";
  if (!isBrianTimeFilter(timeFilter)) {
    throw new Error(`Unsupported time filter "${timeFilter}"`);
  }

  return {
    name,
    keywords: keywords.length > 0 ? keywords : ["Agentic"],
    sites: sites.length > 0 ? sites : ["greenhouse", "lever", "ashby"],
    timeFilter,
    includeRemote: !args.includes("--exclude-remote"),
    location: readStringFlag(args, "--location"),
    maxQueries: readNumberFlag(args, "--max-queries", 12),
    searchLimit: readNumberFlag(args, "--search-limit", 5),
    searchTimeoutMs: readNumberFlag(args, "--search-timeout-ms", 30000),
    pageLimit: readNumberFlag(args, "--page-limit", 10),
    pageTimeoutMs: readNumberFlag(args, "--page-timeout-ms", 45000),
    classifyLimit: readNumberFlag(args, "--classify-limit", 50),
    duplicateLimit: readNumberFlag(args, "--duplicate-limit", 250),
    duplicateThreshold: readFloatFlag(args, "--duplicate-threshold", 0.82),
    queueLimit: readNumberFlag(args, "--queue-limit", 25),
    enabled: !args.includes("--disabled"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run sweeps:save -- --name daily-agentic -k "Agentic" --site greenhouse --site lever
  bun run sweeps:save -- --name broad-agentic --site all --max-queries 50 --search-limit 3

Options mirror pipeline:run search and per-stage caps.
  --name                   Saved sweep name.
  -k, --keyword            Search keyword. Repeatable. Defaults to Agentic.
  -s, --site               Brian site ID/label/site. Repeatable. Defaults to greenhouse, lever, ashby.
  --time                   Brian-style time filter. Defaults to 24hours.
  --location               Optional location text for search queries.
  --exclude-remote         Do not append remote to search queries.
  --max-queries            Search target cap. Defaults to 12.
  --search-limit           Result cap per search query. Defaults to 5.
  --search-timeout-ms      Per-search timeout. Defaults to 30000.
  --page-limit             Page ingest cap. Defaults to 10.
  --page-timeout-ms        Page ingest timeout. Defaults to 45000.
  --classify-limit         Classification cap. Defaults to 50.
  --duplicate-limit        Duplicate comparison cap. Defaults to 250.
  --duplicate-threshold    Duplicate confidence threshold. Defaults to 0.82.
  --queue-limit            Review queue cap. Defaults to 25.
  --disabled               Save disabled.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const input = parseOptions(args);
  const row = await runPsqlJson<SavedSweepRow>(buildUpsertSavedSweepSql(input));
  console.log(`Saved sweep ${row.name} (${row.enabled ? "enabled" : "disabled"})`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
