import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  type DuplicateCandidateReviewRow,
  type DuplicateCandidateState,
  buildReviewDuplicateCandidateSql,
  isDuplicateCandidateState,
} from "../src/pipeline/jobDuplicates";
import {
  type ReviewActor,
  isReviewActor,
} from "../src/pipeline/jobReview";

interface ReviewDuplicateOptions {
  candidateId: string | null;
  state: Exclude<DuplicateCandidateState, "suggested"> | null;
  actor: ReviewActor;
  reasons: string[];
  note: string | null;
  json: boolean;
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

function parseState(value: string | null): Exclude<DuplicateCandidateState, "suggested"> | null {
  if (value === null) return null;
  if (!isDuplicateCandidateState(value) || value === "suggested") {
    throw new Error(
      '--state must be one of "confirmed_same", "confirmed_distinct", or "ignored"',
    );
  }
  return value;
}

function parseActor(value: string | null): ReviewActor {
  const actor = value ?? "human";
  if (!isReviewActor(actor)) {
    throw new Error('--actor must be one of "system", "human", or "agent"');
  }
  return actor;
}

function parseOptions(args: string[]): ReviewDuplicateOptions {
  return {
    candidateId: readStringFlag(args, "--candidate-id"),
    state: parseState(readStringFlag(args, "--state")),
    actor: parseActor(readStringFlag(args, "--actor")),
    reasons: readRepeatedFlag(args, ["--reason", "--reasons"]),
    note: readStringFlag(args, "--note"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:duplicate-review -- --candidate-id 12 --state confirmed_same --reason same_employer
  bun run jobs:duplicate-review -- --candidate-id 12 --state confirmed_distinct --note "Different teams"
  bun run jobs:duplicate-review -- --candidate-id 12 --state ignored --actor agent

Options:
  --candidate-id  duplicate_candidates.id from jobs:queue output.
  --state         confirmed_same, confirmed_distinct, or ignored.
  --reason        Reason code. Repeatable. Comma-separated values accepted.
  --note          Freeform review note.
  --actor         system, human, or agent. Defaults to human.
  --json          Print machine-readable output.

This records review feedback only. It does not merge, delete, suppress, or auto-apply jobs.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  if (options.candidateId === null) {
    throw new Error("--candidate-id is required");
  }
  if (options.state === null) {
    throw new Error("--state is required");
  }

  const row = await runPsqlJson<DuplicateCandidateReviewRow | null>(
    buildReviewDuplicateCandidateSql({
      candidateId: options.candidateId,
      state: options.state,
      actor: options.actor,
      reasonCodes: options.reasons,
      note: options.note,
    }),
  );

  if (row === null) {
    throw new Error(`No duplicate candidate found with id ${options.candidateId}`);
  }

  if (options.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  console.log(
    `Duplicate candidate ${row.id}: ${row.previous_state} -> ${row.state} (${row.job_id_a} <-> ${row.job_id_b})`,
  );
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
