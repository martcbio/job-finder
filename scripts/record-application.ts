import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  type ApplicationStatus,
  type RecordedApplicationRow,
  buildRecordApplicationSql,
  isApplicationStatus,
} from "../src/pipeline/jobApplications";
import {
  type ReviewActor,
  isReviewActor,
} from "../src/pipeline/jobReview";

interface RecordApplicationOptions {
  jobId: string | null;
  cvDraftId: string | null;
  status: ApplicationStatus;
  channel: string | null;
  externalUrl: string | null;
  appliedAt: string | null;
  note: string | null;
  actor: ReviewActor;
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

function parseStatus(value: string | null): ApplicationStatus {
  const status = value ?? "applied";
  if (!isApplicationStatus(status)) {
    throw new Error(
      '--status must be one of "prepared", "applied", "waiting", "rejected_by_company", or "withdrawn"',
    );
  }
  return status;
}

function parseActor(value: string | null): ReviewActor {
  const actor = value ?? "human";
  if (!isReviewActor(actor)) {
    throw new Error('--actor must be one of "system", "human", or "agent"');
  }
  return actor;
}

function parseOptions(args: string[]): RecordApplicationOptions {
  return {
    jobId: readStringFlag(args, "--job-id"),
    cvDraftId: readStringFlag(args, "--cv-draft-id"),
    status: parseStatus(readStringFlag(args, "--status")),
    channel: readStringFlag(args, "--channel"),
    externalUrl: readStringFlag(args, "--external-url"),
    appliedAt: readStringFlag(args, "--applied-at"),
    note: readStringFlag(args, "--note"),
    actor: parseActor(readStringFlag(args, "--actor")),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run applications:record -- --job-id 1 --status applied --channel greenhouse --external-url https://example.com/application
  bun run applications:record -- --job-id 1 --status waiting --cv-draft-id 2 --note "Submitted manually"
  bun run applications:record -- --job-id 1 --status prepared --actor agent

Options:
  --job-id        Job id from Postgres.
  --status        prepared, applied, waiting, rejected_by_company, or withdrawn. Defaults to applied.
  --cv-draft-id   Optional reviewed job_cv_drafts.id used for the application.
  --channel       Optional application channel, e.g. greenhouse, lever, email, referral.
  --external-url  Optional URL for the application or confirmation page.
  --applied-at    Optional timestamp. Defaults to now for applied/waiting.
  --note          Freeform local note.
  --actor         system, human, or agent. Defaults to human.
  --json          Print machine-readable output.

This records a local application audit event and review-state transition only. It never submits an external application.`);
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

  const row = await runPsqlJson<RecordedApplicationRow | null>(
    buildRecordApplicationSql({
      jobId: options.jobId,
      cvDraftId: options.cvDraftId,
      status: options.status,
      channel: options.channel,
      externalUrl: options.externalUrl,
      appliedAt: options.appliedAt,
      note: options.note,
      actor: options.actor,
    }),
  );

  if (row === null) {
    throw new Error(`No job found with id ${options.jobId}`);
  }

  if (options.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  console.log(
    `Application ${row.id}: job ${row.job_id} ${row.from_state} -> ${row.to_state} (${row.status}, review event ${row.event_id})`,
  );
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
