import { runPsqlJson } from "../src/db/psql";
import {
  type CvDraftReviewRow,
  type CvDraftStatus,
  buildReviewCvDraftSql,
  isCvDraftStatus,
} from "../src/pipeline/cvDraft";
import {
  type ReviewActor,
  isReviewActor,
} from "../src/pipeline/jobReview";

interface ReviewDraftOptions {
  draftId: string | null;
  status: Exclude<CvDraftStatus, "needs_human_review"> | null;
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

function parseStatus(value: string | null): Exclude<CvDraftStatus, "needs_human_review"> | null {
  if (value === null) return null;
  if (!isCvDraftStatus(value) || value === "needs_human_review") {
    throw new Error('--status must be one of "approved", "rejected", or "superseded"');
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

function parseOptions(args: string[]): ReviewDraftOptions {
  return {
    draftId: readStringFlag(args, "--draft-id"),
    status: parseStatus(readStringFlag(args, "--status")),
    actor: parseActor(readStringFlag(args, "--actor")),
    reasons: readRepeatedFlag(args, ["--reason", "--reasons"]),
    note: readStringFlag(args, "--note"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run cv:review-draft -- --draft-id 1 --status approved --reason accurate
  bun run cv:review-draft -- --draft-id 1 --status rejected --note "Needs different emphasis"
  bun run cv:review-draft -- --draft-id 1 --status superseded --actor agent

Options:
  --draft-id  job_cv_drafts.id.
  --status    approved, rejected, or superseded.
  --reason    Reason code. Repeatable. Comma-separated values accepted.
  --note      Freeform review note.
  --actor     system, human, or agent. Defaults to human.
  --json      Print machine-readable output.

Approving a draft moves the linked job to ready_to_apply. Rejected drafts do not apply externally.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  if (options.draftId === null) {
    throw new Error("--draft-id is required");
  }
  if (options.status === null) {
    throw new Error("--status is required");
  }

  const row = await runPsqlJson<CvDraftReviewRow | null>(
    buildReviewCvDraftSql({
      draftId: options.draftId,
      status: options.status,
      actor: options.actor,
      reasonCodes: options.reasons,
      note: options.note,
    }),
  );

  if (row === null) {
    throw new Error(`No CV draft found with id ${options.draftId}`);
  }

  if (options.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  console.log(
    `CV draft ${row.id}: ${row.previous_status} -> ${row.status} for job ${row.job_id} (review event ${row.event_id})`,
  );
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
