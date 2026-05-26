import type { FastRefreshResult } from "./types";
import { escapeMarkdownLinkText, formatCost } from "./utils";

export function renderFastRefreshMarkdown(result: FastRefreshResult): string {
  const lines = [
    "# Fast Job Refresh",
    "",
    `Generated: ${result.finishedAt}`,
    `Elapsed: ${(result.elapsedMs / 1000).toFixed(2)}s`,
    "",
    "## Counts",
    "",
  ];

  for (const row of result.sources) {
    lines.push(
      `- ${row.source.label} / ${row.keyword}: ${row.outcome}, discovered ${row.discovered}, imported ${row.imported}, full-text pages ${row.fullText.persisted}, classified ${row.classification.classified}, run ${row.runId ?? "none"}${
        row.fullText.fetchedPages === null ? "" : `, pages fetched ${row.fullText.fetchedPages}`
      }`,
    );
  }

  const classifiedTotal = result.classified.reduce((sum, item) => sum + item.classified, 0);
  lines.push(`- Classified this run: ${classifiedTotal}`);
  lines.push(
    `- Tokens/cost: ${formatCost(result.costs.jinaSearchTokens)} Jina Search tokens, ${formatCost(
      result.costs.jinaReaderTokens,
    )} Jina Reader tokens, ${formatCost(result.costs.openAiTokens)} OpenAI tokens, ${formatCost(
      result.costs.billableSearchApiCalls,
    )} billable search API calls`,
  );
  lines.push("");
  lines.push("## Latest Ranked Jobs");
  lines.push("");

  if (result.latest.jobs.length === 0) {
    lines.push("No ranked jobs available.");
  } else {
    for (const [index, row] of result.latest.jobs.entries()) {
      const canonical = row.links.find((link) => link.kind === "canonical")?.url ?? "#";
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${canonical})`);
      lines.push(
        `   ${[row.company, row.source.label, row.classification.category, row.eligibility.status]
          .filter(Boolean)
          .join(" | ")}`,
      );
      lines.push(
        `   matched: ${row.ranking.reasons.join(", ") || row.classification.labels.join(", ")}`,
      );
      lines.push(`   full text: ${row.ingest.fullTextStatus}; review: ${row.reviewState}`);
      lines.push("");
    }
  }

  if (result.latest.direct.length > 0) {
    lines.push("## Direct Source Lane");
    lines.push("");
    for (const [index, row] of result.latest.direct.entries()) {
      const canonical = row.links.find((link) => link.kind === "canonical")?.url ?? "#";
      lines.push(`${index + 1}. [${escapeMarkdownLinkText(row.title)}](${canonical})`);
      lines.push(
        `   ${[row.company, row.source.label, row.classification.category, row.eligibility.status]
          .filter(Boolean)
          .join(" | ")}`,
      );
      lines.push(
        `   matched: ${row.classification.labels.join(", ") || "direct-source current role"}`,
      );
      lines.push("");
    }
  }

  const errors = result.sources.flatMap((row) =>
    row.errors.map((error) => `${row.source.label} / ${row.keyword}: ${error}`),
  );
  if (errors.length > 0) {
    lines.push("## Errors");
    lines.push("");
    lines.push(...errors.map((error) => `- ${error}`));
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
