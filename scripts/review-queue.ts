import { runPsqlJson } from "../src/db/psql";
import {
  type ReviewState,
  REVIEW_STATES,
  isReviewState,
} from "../src/pipeline/jobReview";
import {
  type ReviewQueueFilters,
  type ReviewQueueRow,
  buildReviewQueueSql,
  renderReviewQueueMarkdown,
} from "../src/pipeline/jobReviewQueue";

type QueueFormat = "markdown" | "json";

interface ReviewQueueOptions extends ReviewQueueFilters {
  format: QueueFormat;
}

const DEFAULT_QUEUE_STATES: ReviewState[] = [
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "duplicate_candidate",
];

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readRepeatedFlag(args: string[], name: string): string[] {
  const values: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a value`);
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

function parseStates(values: string[]): ReviewState[] {
  if (values.length === 0) return DEFAULT_QUEUE_STATES;

  const states: ReviewState[] = [];
  for (const value of values) {
    if (!isReviewState(value)) {
      throw new Error(
        `Unsupported review state "${value}". Valid states: ${REVIEW_STATES.join(", ")}`,
      );
    }
    states.push(value);
  }

  return [...new Set(states)];
}

function parseOptions(args: string[]): ReviewQueueOptions {
  const formatValue = readStringFlag(args, "--format") ?? "markdown";
  if (formatValue !== "markdown" && formatValue !== "json") {
    throw new Error('--format must be "markdown" or "json"');
  }

  return {
    limit: readNumberFlag(args, "--limit", 25),
    states: parseStates(readRepeatedFlag(args, "--state")),
    format: formatValue,
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:queue -- --limit 25
  bun run jobs:queue -- --state ready_for_review --state duplicate_candidate
  bun run jobs:queue -- --state ready_for_review,shortlisted --format json

Options:
  --limit   Maximum jobs to print. Defaults to 25.
  --state   Review state filter. Repeatable. Comma-separated values accepted.
  --format  markdown or json. Defaults to markdown.

Requires DATABASE_URL and applied job_search migrations.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<ReviewQueueRow[]>(buildReviewQueueSql(options));

  if (options.format === "json") {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log(
    renderReviewQueueMarkdown(rows, {
      generatedAt: new Date(),
      filters: options,
    }).trimEnd(),
  );
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
