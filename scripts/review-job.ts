import { runPsqlJson } from "../src/db/psql";
import {
  type ReviewActor,
  type ReviewState,
  type ReviewTransitionRow,
  buildReviewEventsSql,
  buildReviewTransitionSql,
  isReviewActor,
  isReviewState,
} from "../src/pipeline/jobReview";

interface ReviewJobOptions {
  jobId: string | null;
  toState: ReviewState | null;
  reasons: string[];
  note: string | null;
  actor: ReviewActor;
  history: boolean;
  limit: number;
  json: boolean;
}

interface ReviewEventRow {
  id: string;
  job_id: string;
  from_state: string | null;
  to_state: string;
  reason_codes: string[];
  note: string | null;
  actor: string;
  created_at: string;
}

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

function parseOptions(args: string[]): ReviewJobOptions {
  const stateValue = readStringFlag(args, "--state");
  if (stateValue !== null && !isReviewState(stateValue)) {
    throw new Error(`Unsupported review state "${stateValue}"`);
  }

  const actorValue = readStringFlag(args, "--actor") ?? "human";
  if (!isReviewActor(actorValue)) {
    throw new Error(`Unsupported review actor "${actorValue}"`);
  }

  return {
    jobId: readStringFlag(args, "--job-id"),
    toState: stateValue,
    reasons: readRepeatedFlag(args, ["--reason", "--reasons"]),
    note: readStringFlag(args, "--note"),
    actor: actorValue,
    history: args.includes("--history"),
    limit: readNumberFlag(args, "--limit", 20),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:review -- --job-id 1 --state ready_for_review --reason page_ingested --note "Looks worth reviewing"
  bun run jobs:review -- --job-id 1 --state shortlisted --reason strong_match --actor human
  bun run jobs:review -- --job-id 1 --history

Options:
  --job-id    Job id from Postgres.
  --state     Target review state for a transition.
  --reason    Reason code. Repeatable. Comma-separated values accepted.
  --note      Freeform review note.
  --actor     system, human, or agent. Defaults to human.
  --history   Print review events for the job instead of transitioning it.
  --limit     History limit. Defaults to 20.
  --json      Print machine-readable output.

Requires DATABASE_URL and applied job_search migrations. This only updates local DB review state; it never applies externally.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  if (options.jobId === null) {
    throw new Error("--job-id is required");
  }

  if (options.history) {
    const rows = await runPsqlJson<ReviewEventRow[]>(
      buildReviewEventsSql(options.jobId, options.limit),
    );
    if (options.json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log(`No review events for job ${options.jobId}.`);
      return;
    }
    for (const row of rows) {
      const reasons = row.reason_codes.length > 0 ? ` reasons=${row.reason_codes.join(",")}` : "";
      const note = row.note ? ` note=${JSON.stringify(row.note)}` : "";
      console.log(`${row.created_at}: ${row.from_state ?? "-"} -> ${row.to_state} by ${row.actor}${reasons}${note}`);
    }
    return;
  }

  if (options.toState === null) {
    throw new Error("--state is required unless --history is used");
  }

  const result = await runPsqlJson<ReviewTransitionRow | null>(
    buildReviewTransitionSql({
      jobId: options.jobId,
      toState: options.toState,
      reasonCodes: options.reasons,
      note: options.note,
      actor: options.actor,
    }),
  );

  if (result === null) {
    throw new Error(`No job found with id ${options.jobId}`);
  }

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log(
    `Job ${result.job_id}: ${result.from_state} -> ${result.to_state} (review event ${result.event_id})`,
  );
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
