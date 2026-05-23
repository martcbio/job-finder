import { planMigrations } from "../src/db/migrations";
import { runPsql, runPsqlJson } from "../src/db/psql";
import { fetchLinearCareersJobs } from "../src/pipeline/directSources";
import {
  type ClassifiableJobRow,
  buildClassifiableJobsForSearchRunSql,
  buildUpdateJobClassificationSql,
  classifyJobText,
} from "../src/pipeline/jobClassification";
import {
  buildJobServeRowsSql,
  type JobServeContractRow,
  rankJobServeContracts,
} from "../src/pipeline/jobserveContracts";
import { fetchLiveJobServeRoles, jobServeRoleToNormalizedJob } from "../src/pipeline/jobserveLive";
import { ingestNormalizedJobs } from "../src/pipeline/normalizedJobIngest";

interface Options {
  limit: number;
  jobserveQueries: string[];
  jobserveMaxPages: number;
  jobserveImportLimitPerQuery: number;
  directLimit: number;
  timeoutMs: number;
  classifyLimit: number;
  json: boolean;
}

interface RunIngestSummary {
  sourceId: string;
  sourceLabel: string;
  keyword: string;
  runId: number | null;
  discovered: number;
  imported: number;
  pagesPersisted: number;
  pagesFetched: number | null;
  errors: string[];
}

interface ClassifiedSummary {
  runId: number;
  classified: number;
}

const DEFAULT_JOBSERVE_QUERIES = [
  "agentic",
  "langchain",
  "forward deployed engineer",
  "inference engineer",
];

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
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.push(...splitList(value));
    i++;
  }
  return values;
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
  const queries = readRepeatedFlag(args, ["--jobserve-query", "-q"]);
  return {
    limit: readNumberFlag(args, "--limit", 20),
    jobserveQueries: queries.length > 0 ? queries : DEFAULT_JOBSERVE_QUERIES,
    jobserveMaxPages: readNumberFlag(args, "--jobserve-max-pages", 3),
    jobserveImportLimitPerQuery: readNumberFlag(args, "--jobserve-import-limit-per-query", 8),
    directLimit: readNumberFlag(args, "--direct-limit", 6),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 20000),
    classifyLimit: readNumberFlag(args, "--classify-limit", 250),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:fast-refresh -- --limit 20
  bun run jobserve:refresh-contracts -- -q agentic -q langchain --jobserve-max-pages 3

Options:
  -q, --jobserve-query    JobServe query. Repeatable. Defaults to agentic/langchain/FDE/inference.
  --jobserve-max-pages    JobServe classic pages per query. Defaults to 3.
  --jobserve-import-limit-per-query
                           JobServe rows to persist per query after discovery. Defaults to 8.
  --direct-limit          Direct Linear Careers roles to ingest. Defaults to 6.
  --timeout-ms            Per-request timeout. Defaults to 20000.
  --classify-limit        Max jobs to classify per run. Defaults to 250.
  --limit                 Latest ranked jobs to print. Defaults to 20.
  --json                  Print machine-readable summary.

Requires DATABASE_URL. Uses native HTTP and rule-based classification; no Jina/OpenAI tokens are consumed.`);
}

async function assertMigrationsReady(): Promise<void> {
  const plan = await planMigrations();
  if (plan.pending.length > 0) {
    throw new Error(`Database has ${plan.pending.length} pending migration(s). Run bun run db:migrate.`);
  }
}

async function ingestJobServeQuery(
  query: string,
  options: Pick<Options, "jobserveMaxPages" | "jobserveImportLimitPerQuery" | "timeoutMs">,
): Promise<RunIngestSummary> {
  const result = await fetchLiveJobServeRoles({
    query,
    maxPages: options.jobserveMaxPages,
    timeoutMs: options.timeoutMs,
  });
  const jobs = result.roles
    .slice(0, options.jobserveImportLimitPerQuery)
    .map((role) => jobServeRoleToNormalizedJob(role, query));
  if (jobs.length === 0) {
    return {
      sourceId: "jobserve",
      sourceLabel: "JobServe",
      keyword: query,
      runId: null,
      discovered: result.roles.length,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: result.pagesFetched,
      errors: [],
    };
  }

  const ingest = await ingestNormalizedJobs({
    sourceId: "jobserve",
    sourceLabel: "JobServe",
    keyword: `jobserve:${query}`,
    jobs,
    timeoutMs: options.timeoutMs,
  });

  return {
    sourceId: "jobserve",
    sourceLabel: "JobServe",
    keyword: query,
    runId: ingest.runId,
    discovered: result.roles.length,
    imported: ingest.jobsPersisted,
    pagesPersisted: ingest.pagesPersisted,
    pagesFetched: result.pagesFetched,
    errors: ingest.errors.map((error) => `${error.title}: ${error.error}`),
  };
}

async function ingestLinearCareers(
  options: Pick<Options, "directLimit" | "timeoutMs">,
): Promise<RunIngestSummary> {
  const result = await fetchLinearCareersJobs({
    limit: options.directLimit,
    timeoutMs: options.timeoutMs,
  });
  if (result.jobs.length === 0) {
    return {
      sourceId: result.sourceId,
      sourceLabel: result.sourceLabel,
      keyword: "linear-careers",
      runId: null,
      discovered: result.discovered,
      imported: 0,
      pagesPersisted: 0,
      pagesFetched: null,
      errors: [],
    };
  }

  const ingest = await ingestNormalizedJobs({
    sourceId: result.sourceId,
    sourceLabel: result.sourceLabel,
    keyword: "direct:linear-careers",
    jobs: result.jobs,
    timeoutMs: options.timeoutMs,
  });

  return {
    sourceId: result.sourceId,
    sourceLabel: result.sourceLabel,
    keyword: "linear-careers",
    runId: ingest.runId,
    discovered: result.discovered,
    imported: ingest.jobsPersisted,
    pagesPersisted: ingest.pagesPersisted,
    pagesFetched: null,
    errors: ingest.errors.map((error) => `${error.title}: ${error.error}`),
  };
}

async function classifyRun(runId: number, limit: number): Promise<ClassifiedSummary> {
  const rows = await runPsqlJson<ClassifiableJobRow[]>(
    buildClassifiableJobsForSearchRunSql(runId, limit),
  );
  let classified = 0;
  for (const row of rows) {
    const classification = classifyJobText({
      title: row.title,
      description: row.description_text,
      hasPageSnapshot: row.has_page_snapshot,
    });
    await runPsql(buildUpdateJobClassificationSql(row.id, classification));
    classified++;
  }
  return { runId, classified };
}

async function latestDirectRows(runIds: number[], limit: number): Promise<DirectLatestRow[]> {
  if (runIds.length === 0) return [];
  return runPsqlJson<DirectLatestRow[]>(`SELECT COALESCE(json_agg(row_to_json(rows)), '[]'::json)
FROM (
  SELECT DISTINCT ON (j.id)
    j.id,
    j.title_normalized AS title,
    j.company_hint AS company,
    j.canonical_url AS url,
    j.last_seen_at::text AS "lastSeenAt",
    j.category,
    COALESCE(array_agg(DISTINCT jcl.label) FILTER (WHERE jcl.label IS NOT NULL), ARRAY[]::text[]) AS labels
  FROM job_search.search_queries sq
  JOIN job_search.search_results sr ON sr.query_id = sq.id
  JOIN job_search.job_observations jo ON jo.search_result_id = sr.id
  JOIN job_search.jobs j ON j.id = jo.job_id
  LEFT JOIN job_search.job_classification_labels jcl ON jcl.job_id = j.id
  WHERE sq.run_id IN (${runIds.join(", ")})
    AND sq.source_id = 'linear-careers'
  GROUP BY j.id
  ORDER BY j.id, j.last_seen_at DESC
  LIMIT ${limit}
) rows;`);
}

interface DirectLatestRow {
  id: number;
  title: string;
  company: string | null;
  url: string;
  lastSeenAt: string;
  category: string;
  labels: string[];
}

function renderMarkdown(input: {
  startedAt: number;
  ingest: RunIngestSummary[];
  classified: ClassifiedSummary[];
  jobserve: ReturnType<typeof rankJobServeContracts>;
  direct: DirectLatestRow[];
  limit: number;
}): string {
  const elapsedMs = Date.now() - input.startedAt;
  const lines = [
    "# Fast Job Refresh",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Elapsed: ${(elapsedMs / 1000).toFixed(2)}s`,
    "",
    "## Counts",
    "",
  ];

  for (const row of input.ingest) {
    lines.push(
      `- ${row.sourceLabel} / ${row.keyword}: discovered ${row.discovered}, imported ${row.imported}, full-text pages ${row.pagesPersisted}, run ${row.runId ?? "none"}${
        row.pagesFetched === null ? "" : `, pages fetched ${row.pagesFetched}`
      }`,
    );
  }

  const classifiedTotal = input.classified.reduce((sum, item) => sum + item.classified, 0);
  lines.push(`- Classified this run: ${classifiedTotal}`);
  lines.push("- Tokens/cost: 0 Jina tokens, 0 OpenAI tokens, 0 billable search API calls");
  lines.push("");
  lines.push("## Latest Ranked Jobs");
  lines.push("");

  const combined = [
    ...input.jobserve.map((row) => ({
      title: row.title,
      company: row.company,
      url: row.url,
      meta: `JobServe | tier ${row.tier}${row.postedAt ? ` | posted ${row.postedAt.toISOString().slice(0, 10)}` : ""}`,
      matched: row.whyMatched.join(", "),
    })),
    ...input.direct.map((row) => ({
      title: row.title,
      company: row.company,
      url: row.url,
      meta: `Linear Careers | ${row.category}`,
      matched: row.labels.join(", ") || "direct-source current role",
    })),
  ].slice(0, input.limit);

  if (combined.length === 0) {
    lines.push("No ranked jobs available.");
  } else {
    for (const [index, row] of combined.entries()) {
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${row.url})`);
      lines.push(`   ${[row.company, row.meta].filter(Boolean).join(" | ")}`);
      lines.push(`   matched: ${row.matched}`);
      lines.push("");
    }
  }

  if (input.direct.length > 0) {
    lines.push("## Direct Source Lane");
    lines.push("");
    for (const [index, row] of input.direct.entries()) {
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${row.url})`);
      lines.push(`   ${[row.company, "Linear Careers", row.category].filter(Boolean).join(" | ")}`);
      lines.push(`   matched: ${row.labels.join(", ") || "direct-source current role"}`);
      lines.push("");
    }
  }

  const errors = input.ingest.flatMap((row) =>
    row.errors.map((error) => `${row.sourceLabel} / ${row.keyword}: ${error}`),
  );
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    lines.push(...errors.map((error) => `- ${error}`));
  }

  return `${lines.join("\n").trimEnd()}\n`;
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

  const startedAt = Date.now();
  const options = parseOptions(args);
  await assertMigrationsReady();

  const ingest = await Promise.all([
    ...options.jobserveQueries.map((query) => ingestJobServeQuery(query, options)),
    ingestLinearCareers(options),
  ]);

  const runIds = ingest.flatMap((item) => (item.runId === null ? [] : [item.runId]));
  const classified: ClassifiedSummary[] = [];
  for (const runId of runIds) {
    classified.push(await classifyRun(runId, options.classifyLimit));
  }

  const jobserveRows = await runPsqlJson<JobServeContractRow[]>(buildJobServeRowsSql(1000));
  const rankedJobServe = rankJobServeContracts(jobserveRows, { limit: options.limit });
  const direct = await latestDirectRows(runIds, options.limit);
  const output = {
    elapsedMs: Date.now() - startedAt,
    ingest,
    classified,
    tokens: {
      jina: 0,
      openai: 0,
      billableSearchApiCalls: 0,
    },
    latest: {
      jobserve: rankedJobServe,
      direct,
    },
  };

  if (options.json) {
    console.log(JSON.stringify(output, null, 2));
  } else {
    console.log(
      renderMarkdown({
        startedAt,
        ingest,
        classified,
        jobserve: rankedJobServe,
        direct,
        limit: options.limit,
      }).trimEnd(),
    );
  }

  const fatalErrors = ingest.flatMap((item) => item.errors);
  if (runIds.length === 0 || fatalErrors.length > 0) {
    process.exitCode = 1;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
