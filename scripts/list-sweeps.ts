import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson } from "../src/db/psql";
import {
  type SavedSweepRow,
  buildListSavedSweepsSql,
  renderSavedSweepsMarkdown,
} from "../src/pipeline/savedSweeps";

interface ListSweepsOptions {
  enabledOnly: boolean;
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

function parseOptions(args: string[]): ListSweepsOptions {
  return {
    enabledOnly: !args.includes("--all"),
    output: readStringFlag(args, "--output"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run sweeps:list
  bun run sweeps:list -- --all --json
  bun run sweeps:list -- --output docs/saved-sweeps.md

Options:
  --all     Include disabled sweeps.
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
  const rows = await runPsqlJson<SavedSweepRow[]>(buildListSavedSweepsSql(options.enabledOnly));

  if (options.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  await writeOrPrint(renderSavedSweepsMarkdown(rows), options.output);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
