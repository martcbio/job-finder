import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { runPsqlJson } from "../src/db/psql";
import { screenJob, type JobScreeningDecision } from "../src/pipeline/jobScreening";

interface FullTextJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  page_source: string;
  usage_tokens: number | null;
  markdown: string;
  source_labels: string[];
  source_ids: string[];
  classification_labels: { label: string; source_stage: string; confidence: string; reason: string }[];
}

interface ExportOptions {
  runIds: number[];
  output: string;
  includeRejected: boolean;
}

function readRepeatedNumberFlag(args: string[], name: string): number[] {
  const values: number[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] !== name) continue;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`${name} requires a numeric value`);
    }
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`${name} must be a positive integer`);
    }
    values.push(parsed);
    i++;
  }

  return values;
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

function parseOptions(args: string[]): ExportOptions {
  const runIds = readRepeatedNumberFlag(args, "--run-id");
  if (runIds.length === 0) {
    throw new Error("At least one --run-id is required");
  }

  return {
    runIds,
    output:
      readStringFlag(args, "--output") ??
      `docs/artifacts/full-text-jobs-${new Date().toISOString().slice(0, 10)}.md`,
    includeRejected: args.includes("--include-rejected"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun scripts/export-full-text-jobs.ts --run-id 9 --run-id 10 --output docs/artifacts/full-text.md

Options:
  --run-id   Search run ID to include. Repeatable.
  --output   Repo-local Markdown output path.
  --include-rejected  Include full rejected/low-quality page bodies instead of audit summaries only.`);
}

function assertRepoLocalOutput(output: string): string {
  const resolved = resolve(output);
  const root = process.cwd();
  if (resolved !== root && !resolved.startsWith(`${root}/`)) {
    throw new Error(`--output must stay inside this project: ${output}`);
  }
  if (resolved.startsWith("/tmp/") || resolved.startsWith("/private/tmp/")) {
    throw new Error("--output must not write artifacts under /tmp");
  }
  return resolved;
}

function buildFullTextJobsSql(runIds: number[]): string {
  return `SELECT COALESCE(json_agg(row_to_json(full_text_job)), '[]'::json)
FROM (
  WITH run_jobs AS (
    SELECT DISTINCT
      j.id,
      j.title_normalized AS title,
      j.company_hint,
      j.canonical_url,
      j.category,
      j.rag_focus,
      j.enterprise_focus,
      COALESCE(array_remove(array_agg(DISTINCT sq.source_label), NULL), ARRAY[]::text[]) AS source_labels,
      COALESCE(array_remove(array_agg(DISTINCT sq.source_id), NULL), ARRAY[]::text[]) AS source_ids
    FROM job_search.search_queries sq
    JOIN job_search.search_results sr ON sr.query_id = sq.id
    JOIN job_search.job_observations jo ON jo.search_result_id = sr.id
    JOIN job_search.jobs j ON j.id = jo.job_id
    WHERE sq.run_id = ANY (ARRAY[${runIds.join(",")}])
    GROUP BY j.id
  )
  SELECT
    rj.id::text AS id,
    rj.title,
    rj.company_hint,
    rj.canonical_url,
    rj.category,
    rj.rag_focus,
    rj.enterprise_focus,
    rj.source_labels,
    rj.source_ids,
    COALESCE(
      (
        SELECT json_agg(
          json_build_object(
            'label', jcl.label,
            'source_stage', jcl.source_stage,
            'confidence', jcl.confidence,
            'reason', jcl.reason
          )
          ORDER BY
            CASE jcl.source_stage WHEN 'page' THEN 0 WHEN 'metadata' THEN 1 ELSE 2 END,
            jcl.confidence DESC,
            jcl.label
        )
        FROM job_search.job_classification_labels jcl
        WHERE jcl.job_id = rj.id
      ),
      '[]'::json
    ) AS classification_labels,
    jp.source AS page_source,
    jp.usage_tokens,
    jp.markdown
  FROM run_jobs rj
  JOIN LATERAL (
    SELECT source, usage_tokens, markdown
    FROM job_search.job_pages jp
    WHERE jp.job_id = rj.id
      AND jp.status = 'success'
      AND NULLIF(BTRIM(COALESCE(jp.markdown, '')), '') IS NOT NULL
    ORDER BY fetched_at DESC, LENGTH(markdown) DESC
    LIMIT 1
  ) jp ON true
  ORDER BY rj.title, rj.id
) full_text_job;`;
}

interface ScreenedFullTextJob {
  row: FullTextJobRow;
  screening: JobScreeningDecision;
}

function renderMarkdown(rows: FullTextJobRow[], options: ExportOptions): string {
  const screened = rows.map((row): ScreenedFullTextJob => ({ row, screening: screenFullTextJob(row) }));
  const highSignal = screened.filter((item) => item.screening.status === "high_signal");
  const needsReview = screened.filter((item) => item.screening.status === "needs_human_review");
  const rejected = screened.filter((item) => item.screening.status === "rejected");
  const lines = [
    "# Screened Full-Text Jobs",
    "",
    `Generated: ${new Date().toISOString()}`,
    `Search runs: ${options.runIds.join(", ")}`,
    `Unique jobs with full text: ${rows.length}`,
    `High signal: ${highSignal.length}`,
    `Needs human review: ${needsReview.length}`,
    `Rejected/low quality: ${rejected.length}`,
    `Rejected bodies included: ${options.includeRejected ? "yes" : "no"}`,
    "",
  ];

  appendScreenedSection(lines, "High-Signal Eligible Jobs", highSignal, true);
  appendScreenedSection(lines, "Needs Human Review", needsReview, true);
  appendScreenedSection(lines, "Rejected / Low Quality", rejected, options.includeRejected);

  return `${lines.join("\n")}\n`;
}

function appendScreenedSection(
  lines: string[],
  title: string,
  items: ScreenedFullTextJob[],
  includeBody: boolean,
): void {
  lines.push(`## ${title}`);
  lines.push("");

  if (items.length === 0) {
    lines.push("_None._");
    lines.push("");
    return;
  }

  for (const { row, screening } of items) {
    lines.push(`### ${row.title}`);
    lines.push("");
    lines.push(`- Job ID: ${row.id}`);
    lines.push(`- Company: ${row.company_hint ?? "Unknown"}`);
    lines.push(`- URL: ${row.canonical_url}`);
    lines.push(`- Screening: ${screening.summary}`);
    if (screening.reasons.length > 0) {
      lines.push(
        `- Screening reasons: ${screening.reasons.map((reason) => `${reason.code}: ${reason.detail}`).join("; ")}`,
      );
    }
    lines.push(`- Category: ${row.category}`);
    lines.push(`- RAG: ${row.rag_focus}`);
    lines.push(`- Enterprise: ${row.enterprise_focus}`);
    if (row.classification_labels.length > 0) {
      lines.push(`- Labels: ${formatLabels(row.classification_labels)}`);
    }
    lines.push(
      `- Sources: ${row.source_labels.length > 0 ? row.source_labels.join(", ") : "Unknown"}`,
    );
    lines.push(`- Page source: ${row.page_source}`);
    lines.push(`- Page tokens: ${row.usage_tokens ?? 0}`);
    lines.push("");
    if (includeBody) {
      lines.push(row.markdown.trim());
    } else {
      lines.push("_Body suppressed; rerun with `--include-rejected` for full rejected page text._");
    }
    lines.push("");
    lines.push("---");
    lines.push("");
  }
}

function screenFullTextJob(row: FullTextJobRow): JobScreeningDecision {
  return screenJob({
    title: row.title,
    companyHint: row.company_hint,
    canonicalUrl: row.canonical_url,
    markdown: row.markdown,
    labels: row.classification_labels,
  });
}

function formatLabels(
  labels: { label: string; source_stage: string; confidence: string; reason: string }[],
): string {
  return labels
    .map((label) => `${label.label}@${label.source_stage}(${formatConfidence(label.confidence)})`)
    .join(", ");
}

function formatConfidence(confidence: string): string {
  const parsed = Number.parseFloat(confidence);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : confidence;
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);
  const rows = await runPsqlJson<FullTextJobRow[]>(buildFullTextJobsSql(options.runIds));
  const output = assertRepoLocalOutput(options.output);
  await mkdir(dirname(output), { recursive: true });
  await Bun.write(output, renderMarkdown(rows, options));
  console.log(`Wrote ${output}`);
  console.log(`Jobs: ${rows.length}`);
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
