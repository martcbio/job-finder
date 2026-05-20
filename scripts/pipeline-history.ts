import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson } from "../src/db/psql";
import {
  type PipelineHistoryRow,
  buildPipelineHistorySql,
  renderPipelineHistoryMarkdown,
} from "../src/pipeline/pipelineRun";

interface PipelineHistoryOptions {
  limit: number;
  output: string | null;
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

function parseOptions(args: string[]): PipelineHistoryOptions {
  return {
    limit: readNumberFlag(args, "--limit", 20),
    output: readStringFlag(args, "--output"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run pipeline:history -- --limit 20
  bun run pipeline:history -- --json
  bun run pipeline:history -- --output docs/pipeline-runs.md

Options:
  --limit   Maximum pipeline runs. Defaults to 20.
  --output  Optional Markdown output path.
  --json    Print machine-readable output.`);
}

async function writeOrPrint(content: string, output: string | null): Promise<void> {
  if (!output) {
    console.log(content);
    return;
  }

  const resolved = resolve(output);
  await mkdir(dirname(resolved), { recursive: true });
  await Bun.write(resolved, content);
  console.log(`Wrote ${resolved}`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<PipelineHistoryRow[]>(buildPipelineHistorySql(options.limit));

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  await writeOrPrint(renderPipelineHistoryMarkdown(rows), options.output);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
