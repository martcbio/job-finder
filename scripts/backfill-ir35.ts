import { runPsql, runPsqlJson } from "../src/db/psql";
import {
  type Ir35BackfillRow,
  buildIr35LabelPageBatchSql,
  buildUpdateIr35PageSql,
  reclassifyIr35Markdown,
} from "../src/pipeline/ir35Backfill";

interface BackfillOptions {
  apply: boolean;
  batchSize: number;
  json: boolean;
}

function readBatchSize(args: string[]): number {
  const index = args.indexOf("--batch-size");
  if (index === -1) return 100;
  const value = args[index + 1];
  const parsed = value ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--batch-size requires a positive integer");
  }
  return parsed;
}

export function parseBackfillOptions(args: string[]): BackfillOptions {
  if (args.includes("--apply") && args.includes("--dry-run")) {
    throw new Error("Use either --apply or --dry-run, not both");
  }
  return {
    apply: args.includes("--apply"),
    batchSize: readBatchSize(args),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun scripts/backfill-ir35.ts
  bun scripts/backfill-ir35.ts --apply

Options:
  --dry-run    Explicit dry-run (also the default when --apply is absent).
  --apply      Rewrite contradicted historical IR35 metadata.
  --batch-size Rows read per batch. Defaults to 100.
  --json       Print machine-readable output.

No rows are changed unless --apply is present.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseBackfillOptions(args);
  let cursor = "0";
  let scanned = 0;
  let contradicted = 0;
  let updated = 0;
  const samples: Array<{ pageId: string; jobId: string; title: string }> = [];

  while (true) {
    const rows = await runPsqlJson<Ir35BackfillRow[]>(
      buildIr35LabelPageBatchSql(cursor, options.batchSize),
    );
    if (rows.length === 0) break;

    for (const row of rows) {
      scanned += 1;
      cursor = row.page_id;
      const decision = reclassifyIr35Markdown(row.markdown);
      if (!decision.changed) continue;
      contradicted += 1;
      if (samples.length < 10) samples.push({ pageId: row.page_id, jobId: row.job_id, title: row.title });
      if (options.apply) {
        const result = await runPsql(buildUpdateIr35PageSql(row, decision.markdown));
        if (result.stdout) updated += 1;
      }
    }
  }

  const summary = {
    mode: options.apply ? "apply" : "dry-run",
    affectedRowsScanned: scanned,
    contradictedRows: contradicted,
    updatedRows: updated,
    samples,
  };
  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Scanned ${scanned} row(s) carrying positive IR35 labels.`);
  console.log(`${options.apply ? "Updated" : "Would update"} ${contradicted} contradicted row(s).`);
  for (const sample of samples) console.log(`${sample.pageId}: job ${sample.jobId} — ${sample.title}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
