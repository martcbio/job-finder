import { runPsqlJson } from "../src/db/psql";
import { buildApprovedBulletInsertSql } from "../src/pipeline/cvDraft";

interface AddBulletOptions {
  theme: string | null;
  title: string | null;
  bullet: string | null;
  evidence: string | null;
  json: boolean;
}

interface AddedBulletRow {
  id: string;
  theme_key: string;
  title: string;
  status: string;
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

function parseOptions(args: string[]): AddBulletOptions {
  return {
    theme: readStringFlag(args, "--theme"),
    title: readStringFlag(args, "--title"),
    bullet: readStringFlag(args, "--bullet"),
    evidence: readStringFlag(args, "--evidence"),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run cv:add-bullet -- --theme agentic_engineer --title "Agent systems" --bullet "Shipped ..." --evidence "Project/link/source"

Options:
  --theme     Focus theme key matching cv_focus_themes.key.
  --title     Short internal title for this reusable block.
  --bullet    CV bullet text. Must be an accurate, reusable claim.
  --evidence  Source note proving the claim.
  --json      Print machine-readable output.

This inserts an approved bullet block. Do not add speculative or unverified claims.`);
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  if (!options.theme) throw new Error("--theme is required");
  if (!options.title) throw new Error("--title is required");
  if (!options.bullet) throw new Error("--bullet is required");
  if (!options.evidence) throw new Error("--evidence is required");

  const row = await runPsqlJson<AddedBulletRow>(
    buildApprovedBulletInsertSql({
      themeKey: options.theme,
      title: options.title,
      bulletText: options.bullet,
      evidenceNote: options.evidence,
    }),
  );

  if (options.json) {
    console.log(JSON.stringify(row, null, 2));
    return;
  }

  console.log(`Added approved CV bullet ${row.id}: ${row.theme_key} / ${row.title}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
