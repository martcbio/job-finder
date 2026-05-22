import { runPsql, runPsqlJson } from "../src/db/psql";
import {
  type ClassifiableJobRow,
  buildClassifiableJobsSql,
  buildClassifiableJobsForSearchRunSql,
  buildUpdateJobClassificationSql,
  classifyJobText,
} from "../src/pipeline/jobClassification";

interface ClassifyJobsOptions {
  limit: number;
  runId: number | null;
  json: boolean;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a numeric value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readOptionalNumberFlag(args: string[], name: string): number | null {
  const index = args.indexOf(name);
  if (index === -1) return null;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a numeric value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptions(args: string[]): ClassifyJobsOptions {
  return {
    limit: readNumberFlag(args, "--limit", 50),
    runId: readOptionalNumberFlag(args, "--run-id"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:classify -- --limit 50
  bun run jobs:classify -- --limit 10 --json

Options:
  --limit  Maximum unclassified jobs to classify. Defaults to 50.
  --run-id Restrict classification to jobs observed in a specific search run.
  --json   Print machine-readable classification summary.

Requires DATABASE_URL and applied job_search migrations.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<ClassifiableJobRow[]>(
    options.runId === null
      ? buildClassifiableJobsSql(options.limit)
      : buildClassifiableJobsForSearchRunSql(options.runId, options.limit),
  );
  const results = [];

  for (const row of rows) {
    const classification = classifyJobText({
      title: row.title,
      description: row.description_text,
      hasPageSnapshot: row.has_page_snapshot,
    });
    await runPsql(buildUpdateJobClassificationSql(row.id, classification));
    results.push({
      id: row.id,
      title: row.title,
      url: row.canonical_url,
      ...classification,
    });
  }

  if (options.json) {
    console.log(JSON.stringify({ classified: results.length, results }, null, 2));
    return;
  }

  console.log(`Classified ${results.length} job(s).`);
  for (const result of results) {
    console.log(
      `${result.id}: ${result.category}, rag=${result.ragFocus}, enterprise=${result.enterpriseFocus}, labels=${result.labels.map((label) => label.label).join(",") || "none"}, confidence=${result.confidence.toFixed(2)} — ${result.title}`,
    );
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
