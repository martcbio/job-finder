import { runPsql, runPsqlJson } from "../src/db/psql";
import {
  type PageIngestJobRow,
  buildInsertPageIngestAttemptSql,
  buildPendingPageIngestSql,
  buildSearchRunPageIngestSql,
  buildUpsertJobPageSql,
} from "../src/pipeline/jobPageIngest";
import { fetchHttpPageMarkdown } from "../src/pipeline/httpPageExtract";
import { fetchJinaReaderWithUsage } from "../src/pipeline/search";
import { fetchAtsData, formatAtsBlock, hasUsableAtsBody } from "../src/services/ats";

interface IngestPagesOptions {
  limit: number;
  runId: number | null;
  timeoutMs: number;
  httpTimeoutMs: number;
  httpMinTextLength: number;
  json: boolean;
}

function readNumberFlag(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  if (index === -1) return fallback;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a numeric value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function readOptionalNumberFlag(args: string[], name: string): number | null {
  const index = args.indexOf(name);
  if (index === -1) return null;

  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a numeric value`);
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseOptions(args: string[]): IngestPagesOptions {
  return {
    limit: readNumberFlag(args, "--limit", 25),
    runId: readOptionalNumberFlag(args, "--run-id"),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 45000),
    httpTimeoutMs: readNumberFlag(args, "--http-timeout-ms", 15000),
    httpMinTextLength: readNumberFlag(args, "--http-min-text-length", 500),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:ingest-pages -- --limit 25
  bun run jobs:ingest-pages -- --limit 5 --timeout-ms 30000 --json

Options:
  --limit       Maximum jobs to ingest. Defaults to 25.
  --run-id      Restrict ingestion to jobs observed in a specific search run.
  --timeout-ms  Per-page Jina Reader timeout when fallback is needed. Defaults to 45000.
  --http-timeout-ms       Plain HTTP extraction timeout. Defaults to 15000.
  --http-min-text-length  Minimum readable chars for HTTP success. Defaults to 500.
  --json        Print machine-readable ingest summary.

Requires DATABASE_URL and applied job_search migrations. Jina Reader fallback is attempted without Authorization when JINA_API_KEY is absent.`);
}

function errorStatus(message: string): "timeout" | "error" {
  return message.toLowerCase().includes("timed out") ? "timeout" : "error";
}

async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const options = parseOptions(args);

  const rows = await runPsqlJson<PageIngestJobRow[]>(
    options.runId === null
      ? buildPendingPageIngestSql(options.limit)
      : buildSearchRunPageIngestSql(options.runId, options.limit),
  );
  const results = [];
  let totalReportedTokens = 0;

  for (const row of rows) {
    const atsCapture = await captureAtsMetadata(row);
    if (atsCapture.stop) {
      results.push({ id: row.id, status: "success", source: "ats_api", tokens: null });
      continue;
    }

    const httpCaptured = await captureHttpExtract(row, options);
    if (httpCaptured) {
      results.push({ id: row.id, status: "success", source: "http_extract", tokens: null });
      continue;
    }

    try {
      const startedAt = Date.now();
      const jinaApiKey = process.env.JINA_API_KEY ?? "";
      const call = await fetchJinaReaderWithUsage(
        row.canonical_url,
        { jinaApiKey, jinaBaseUrl: "https://r.jina.ai" },
        { timeoutMs: options.timeoutMs },
      );
      const durationMs = Date.now() - startedAt;
      await runPsql(
        buildUpsertJobPageSql(row, {
          source: "jina_reader",
          status: "success",
          markdown: call.markdown,
          usageTokens: call.usage.tokens,
          decompressedBytes: call.usage.decompressedContentLength,
          error: null,
        }),
      );
      await runPsql(
        buildInsertPageIngestAttemptSql(row.id, {
          source: "jina_reader",
          status: "success",
          durationMs,
          usageTokens: call.usage.tokens,
          metadata: { decompressedBytes: call.usage.decompressedContentLength },
          error: null,
        }),
      );
      if (call.usage.tokens !== null) totalReportedTokens += call.usage.tokens;
      results.push({ id: row.id, status: "success", source: "jina_reader", tokens: call.usage.tokens });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = errorStatus(message);
      await runPsql(
        buildUpsertJobPageSql(row, {
          source: "jina_reader",
          status,
          markdown: null,
          usageTokens: null,
          decompressedBytes: null,
          error: message,
        }),
      );
      await runPsql(
        buildInsertPageIngestAttemptSql(row.id, {
          source: "jina_reader",
          status,
          durationMs: null,
          usageTokens: null,
          metadata: {},
          error: message,
        }),
      );
      results.push({ id: row.id, status, source: "jina_reader", error: message });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ingested: results.length, totalReportedTokens, results }, null, 2));
    return;
  }

  console.log(`Ingested ${results.length} page(s).`);
  console.log(`Reported Jina tokens: ${totalReportedTokens}`);
}

async function captureAtsMetadata(row: PageIngestJobRow): Promise<{ captured: boolean; stop: boolean }> {
  const startedAt = Date.now();
  const atsData = await fetchAtsData(row.canonical_url, { title: row.title });
  const durationMs = Date.now() - startedAt;

  if (!atsData) {
    await runPsql(
      buildInsertPageIngestAttemptSql(row.id, {
        source: "ats_api",
        status: "skipped",
        durationMs,
        usageTokens: null,
        metadata: { reason: "unsupported_or_unavailable" },
        error: null,
      }),
    );
    return { captured: false, stop: false };
  }

  await runPsql(
    buildUpsertJobPageSql(row, {
      source: "ats_api",
      status: "success",
      markdown: formatAtsBlock(atsData),
      usageTokens: null,
      decompressedBytes: null,
      error: null,
    }),
  );
  await runPsql(
    buildInsertPageIngestAttemptSql(row.id, {
      source: "ats_api",
      status: "success",
      durationMs,
      usageTokens: null,
      metadata: atsData,
      error: null,
    }),
  );

  return { captured: true, stop: hasUsableAtsBody(atsData) };
}

async function captureHttpExtract(row: PageIngestJobRow, options: IngestPagesOptions): Promise<boolean> {
  const startedAt = Date.now();
  try {
    const result = await fetchHttpPageMarkdown(row.canonical_url, {
      timeoutMs: options.httpTimeoutMs,
      minTextLength: options.httpMinTextLength,
    });
    const durationMs = Date.now() - startedAt;
    await runPsql(
      buildUpsertJobPageSql(row, {
        source: "http_extract",
        status: "success",
        markdown: result.markdown,
        usageTokens: null,
        decompressedBytes: result.byteLength,
        error: null,
      }),
    );
    await runPsql(
      buildInsertPageIngestAttemptSql(row.id, {
        source: "http_extract",
        status: "success",
        durationMs,
        usageTokens: null,
        metadata: {
          status: result.status,
          contentType: result.contentType,
          byteLength: result.byteLength,
        },
        error: null,
      }),
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await runPsql(
      buildInsertPageIngestAttemptSql(row.id, {
        source: "http_extract",
        status: errorStatus(message),
        durationMs: Date.now() - startedAt,
        usageTokens: null,
        metadata: {},
        error: message,
      }),
    );
    return false;
  }
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
