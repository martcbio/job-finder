import { runPsqlJson } from "../src/db/psql";
import {
  rankJobServeContracts,
  type JobServeContractRow,
  type RankedJobServeContract,
} from "../src/pipeline/jobserveContracts";

interface Options {
  limit: number;
  candidateLimit: number;
  format: "markdown" | "json";
  strictOnly: boolean;
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
  --strict-only       Return only tier-1 matches.
  --format            markdown or json. Defaults to markdown.

Requires DATABASE_URL and JobServe rows imported with jobs:import-normalized or pipeline:run --lane jobserve.`);
}

function buildJobServeRowsSql(candidateLimit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)
FROM (
  SELECT
    j.id,
    j.title_normalized AS title,
    j.company_hint AS company,
    j.canonical_url AS url,
    j.last_seen_at::text AS "lastSeenAt",
    COALESCE(MAX(jp.markdown) FILTER (WHERE jp.status = 'success'), '') AS markdown,
    COALESCE(string_agg(DISTINCT sr.description_raw, E'\\n'), '') AS description
  FROM job_search.jobs j
  JOIN job_search.job_observations jo ON jo.job_id = j.id
  JOIN job_search.search_results sr ON sr.id = jo.search_result_id
  JOIN job_search.search_queries sq ON sq.id = sr.query_id
  LEFT JOIN job_search.job_pages jp ON jp.job_id = j.id
  WHERE sq.source_id = 'jobserve'
  GROUP BY j.id, j.title_normalized, j.company_hint, j.canonical_url, j.last_seen_at
  ORDER BY j.last_seen_at DESC, j.id DESC
  LIMIT ${candidateLimit}
) rows;`;
}

function renderMarkdown(rows: RankedJobServeContract[]): string {
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
  const selected = (options.strictOnly ? ranked.filter((row) => row.tier === 1) : ranked).slice(
    0,
    options.limit,
  );

  if (options.format === "json") {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }

  console.log(renderMarkdown(selected).trimEnd());
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
