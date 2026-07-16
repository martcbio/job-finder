import { runPsqlJson } from "../src/db/psql";
import {
  DEFAULT_EXPIRY_DAYS,
  type ExpireJobRow,
  buildApplyJobExpirySql,
  buildExpireCandidatesSql,
  expiryCutoff,
} from "../src/pipeline/jobExpiry";

interface ExpireOptions {
  days: number;
  apply: boolean;
  json: boolean;
}

function readDays(args: string[]): number {
  const index = args.indexOf("--days");
  if (index === -1) return DEFAULT_EXPIRY_DAYS;
  const value = args[index + 1];
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--days requires a positive integer");
  }
  return parsed;
}

export function parseExpireOptions(args: string[]): ExpireOptions {
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("Use either --apply or --dry-run, not both");
  }
  return {
    days: readDays(args),
    apply: args.includes("--apply"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:expire
  bun run jobs:expire -- --days 21 --apply

Options:
  --days     Last-seen age in days. Defaults to 21.
  --dry-run  Explicit dry-run (also the default when --apply is absent).
  --apply    Mark matching active queue jobs stale and record review events.
  --json     Print machine-readable output.

No rows are changed unless --apply is present.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseExpireOptions(args);
  const cutoff = expiryCutoff(new Date(), options.days);
  const rows = await runPsqlJson<ExpireJobRow[]>(
    options.apply ? buildApplyJobExpirySql(cutoff) : buildExpireCandidatesSql(cutoff),
  );
  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    days: options.days,
    cutoff: cutoff.toISOString(),
    matched: rows.length,
    samples: rows.slice(0, 10),
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(
    `${options.apply ? "Expired" : "Would expire"} ${rows.length} job(s) not seen for ${options.days} day(s).`,
  );
  console.log(`Cutoff: ${cutoff.toISOString()}`);
  for (const row of summary.samples) {
    console.log(`${row.id}: ${row.title} — last seen ${row.last_seen_at}`);
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
