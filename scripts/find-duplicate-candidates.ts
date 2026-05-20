import { runPsql, runPsqlJson } from "../src/db/psql";
import {
  type DuplicateJobRow,
  buildDuplicateCandidateJobsSql,
  buildUpsertDuplicateCandidateSql,
  findDuplicateCandidates,
} from "../src/pipeline/jobDuplicates";

interface DuplicateOptions {
  limit: number;
  threshold: number;
  dryRun: boolean;
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

function parseOptions(args: string[]): DuplicateOptions {
  return {
    limit: readNumberFlag(args, "--limit", 250),
    threshold: readFloatFlag(args, "--threshold", 0.82),
    dryRun: args.includes("--dry-run"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:duplicates -- --limit 250 --threshold 0.82
  bun run jobs:duplicates -- --dry-run --json

Options:
  --limit      Maximum recent jobs to compare. Defaults to 250.
  --threshold  Confidence threshold from 0-1. Defaults to 0.82.
  --dry-run    Print candidates without writing duplicate_candidates.
  --json       Print machine-readable output.

Stores possible duplicates as suggested relationships. It never deletes, suppresses, or merges jobs.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<DuplicateJobRow[]>(buildDuplicateCandidateJobsSql(options.limit));
  const candidates = findDuplicateCandidates(rows, options.threshold);

  if (!options.dryRun) {
    for (const candidate of candidates) {
      await runPsql(buildUpsertDuplicateCandidateSql(candidate));
    }
  }

  const summary = {
    comparedJobs: rows.length,
    candidates: candidates.length,
    threshold: options.threshold,
    dryRun: options.dryRun,
    results: candidates,
  };

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Compared ${rows.length} job(s).`);
  console.log(`${options.dryRun ? "Found" : "Stored"} ${candidates.length} possible duplicate candidate(s).`);
  for (const candidate of candidates) {
    console.log(
      `${candidate.jobIdA} <-> ${candidate.jobIdB}: ${candidate.confidence.toFixed(2)} (${candidate.reason})`,
    );
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
