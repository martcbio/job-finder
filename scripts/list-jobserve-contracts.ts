import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  buildJobServeRowsSql,
  filterRecentJobServeContracts,
  rankJobServeContracts,
  type JobServeContractRow,
  type RankedJobServeContract,
} from "../src/pipeline/jobserveContracts";
import { screenJob, type JobScreeningDecision } from "../src/pipeline/jobScreening";

interface Options {
  limit: number;
  candidateLimit: number;
  maxAgeDays: number;
  format: "markdown" | "json";
  strictOnly: boolean;
}

interface ScreenedJobServeContract extends RankedJobServeContract {
  screening: JobScreeningDecision;
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): Options {
  const format = readStringFlag(args, "--format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error('--format must be "markdown" or "json"');
  }

  return {
    limit: readNumberFlag(args, "--limit", 20),
    candidateLimit: readNumberFlag(args, "--candidate-limit", 1000),
    maxAgeDays: readNumberFlag(args, "--max-age-days", 30),
    format,
    strictOnly: args.includes("--strict-only"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobserve:contracts -- --limit 20
  bun run jobserve:contracts -- --strict-only --format json

Options:
  --limit             Maximum jobs to print. Defaults to 20.
  --candidate-limit   Recent JobServe jobs to scan before ranking. Defaults to 1000.
  --max-age-days      Exclude postings older than this. Defaults to 30.
  --strict-only       Return only tier-1 matches.
  --format            markdown or json. Defaults to markdown.

Reads only persisted JobServe rows; it never fetches JobServe or changes the
default source composition. First run the standard default pull (opps update or
bun run jobsradar -- ingest), which already includes bounded JobServe. Requires
DATABASE_URL and stored JobServe rows.`);
}

function renderMarkdown(rows: ScreenedJobServeContract[]): string {
  const lines = [
    "# JobServe Outside-IR35 Contract Matches",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "Tier 1 = outside IR35 + contract + exact requested term.",
    "Tier 2 = outside IR35 + contract + adjacent AI/LLM signal.",
    "Tier 3 = contract + exact requested term, but IR35 status unclear.",
    "Tier 4 = contract + adjacent AI/LLM signal, but IR35 status unclear.",
    "",
  ];

  if (rows.length === 0) {
    lines.push("No matching JobServe rows found in Postgres.");
    return `${lines.join("\n")}\n`;
  }

  for (const [index, row] of rows.entries()) {
    lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${row.url})`);
    lines.push(
      `   ${[row.company, `tier ${row.tier}`, row.postedAt ? `posted ${row.postedAt.toISOString().slice(0, 10)}` : null]
        .filter(Boolean)
        .join(" | ")}`,
    );
    lines.push(`   matched: ${row.whyMatched.join(", ")}`);
    if (row.whySoftened) lines.push(`   softened: ${row.whySoftened}`);
    lines.push(`   screening: ${row.screening.status} — ${row.screening.summary}`);
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<JobServeContractRow[]>(buildJobServeRowsSql(options.candidateLimit));
  const ranked = rankJobServeContracts(rows, { limit: options.candidateLimit });
  const fresh = filterRecentJobServeContracts(ranked, { maxAgeDays: options.maxAgeDays });
  const selected = (options.strictOnly ? fresh.filter((row) => row.tier === 1) : fresh)
    .slice(0, options.limit)
    .map((row): ScreenedJobServeContract => ({
      ...row,
      screening: screenJob({
        title: row.title,
        companyHint: row.company,
        canonicalUrl: row.url,
        markdown: [row.markdown, row.description].filter(Boolean).join("\n"),
      }),
    }));

  if (options.format === "json") {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  console.log(renderMarkdown(selected).trimEnd());
}

withPsqlClientCleanup(run).catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
