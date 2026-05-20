import { runPsql, runPsqlJson } from "../src/db/psql";
import {
  type PageIngestJobRow,
  buildInsertPageIngestAttemptSql,
  buildPendingPageIngestSql,
  buildUpsertJobPageSql,
} from "../src/pipeline/jobPageIngest";
import { fetchJinaReaderWithUsage } from "../src/pipeline/search";
import { fetchAtsData, formatAtsBlock } from "../src/services/ats";

interface IngestPagesOptions {
  limit: number;
  timeoutMs: number;
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

function parseOptions(args: string[]): IngestPagesOptions {
  return {
    limit: readNumberFlag(args, "--limit", 25),
    timeoutMs: readNumberFlag(args, "--timeout-ms", 45000),
    json: args.includes("--json"),
  };
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:ingest-pages -- --limit 25
  bun run jobs:ingest-pages -- --limit 5 --timeout-ms 30000 --json

Options:
  --limit       Maximum jobs to ingest. Defaults to 25.
  --timeout-ms  Per-page Jina Reader timeout. Defaults to 45000.
  --json        Print machine-readable ingest summary.

Requires DATABASE_URL, JINA_API_KEY, and applied job_search migrations.`);
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
  const jinaApiKey = process.env.JINA_API_KEY ?? "";
  if (!jinaApiKey) {
    throw new Error("JINA_API_KEY is required for page ingestion");
  }

  const rows = await runPsqlJson<PageIngestJobRow[]>(buildPendingPageIngestSql(options.limit));
  const results = [];
  let totalReportedTokens = 0;

  for (const row of rows) {
    const atsCaptured = await captureAtsMetadata(row);
    try {
      const startedAt = Date.now();
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
      results.push({ id: row.id, status: "success", atsCaptured, tokens: call.usage.tokens });
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
      results.push({ id: row.id, status, atsCaptured, error: message });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ ingested: results.length, totalReportedTokens, results }, null, 2));
    return;
  }

  console.log(`Ingested ${results.length} page(s).`);
  console.log(`Reported Jina tokens: ${totalReportedTokens}`);
}

async function captureAtsMetadata(row: PageIngestJobRow): Promise<boolean> {
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
    return false;
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

  return true;
}

run().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exitCode = 1;
});
