import { quoteSqlLiteral } from "../db/config";
import { classifyIr35Signals, parseIr35Metadata } from "./ir35Signals";

export interface Ir35BackfillRow {
  page_id: string;
  job_id: string;
  title: string;
  markdown: string;
}

export interface Ir35BackfillDecision {
  changed: boolean;
  reason: "permanent_evidence_veto" | null;
  markdown: string;
}

export function reclassifyIr35Markdown(markdown: string): Ir35BackfillDecision {
  const metadata = parseIr35Metadata(markdown);
  if (metadata.inside !== true && metadata.outside !== true) {
    return { changed: false, reason: null, markdown };
  }

  const signals = classifyIr35Signals({
    text: markdown,
    employmentType: metadataLineValue(markdown, "Employment type"),
    compensation:
      metadataLineValue(markdown, "Compensation") ?? metadataLineValue(markdown, "Rate"),
  });
  if (!signals.permanentEvidence) return { changed: false, reason: null, markdown };

  const revised = removeContradictoryIr35Labels(markdown);
  return {
    changed: revised !== markdown,
    reason: revised !== markdown ? "permanent_evidence_veto" : null,
    markdown: revised,
  };
}

export function buildIr35LabelPageBatchSql(afterPageId: string, limit: number): string {
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("IR35 batch limit must be positive");
  return `SELECT COALESCE(json_agg(row_to_json(affected_page)), '[]'::json)
FROM (
  SELECT
    jp.id::text AS page_id,
    jp.job_id::text AS job_id,
    j.title_normalized AS title,
    jp.markdown
  FROM job_search.job_pages jp
  JOIN job_search.jobs j ON j.id = jp.job_id
  WHERE jp.id > ${quoteSqlLiteral(afterPageId)}::bigint
    AND jp.markdown IS NOT NULL
    AND (
      jp.markdown ILIKE '%Outside IR35: yes%'
      OR jp.markdown ILIKE '%Inside IR35: yes%'
    )
  ORDER BY jp.id
  LIMIT ${limit}
) affected_page;`;
}

export function buildUpdateIr35PageSql(row: Ir35BackfillRow, markdown: string): string {
  return `UPDATE job_search.job_pages
SET markdown = ${quoteSqlLiteral(markdown)}
WHERE id = ${quoteSqlLiteral(row.page_id)}::bigint
  AND markdown = ${quoteSqlLiteral(row.markdown)}
RETURNING id::text;`;
}

function metadataLineValue(markdown: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return markdown.match(new RegExp(`^-\\s*${escaped}:\\s*([^\\n]+)`, "im"))?.[1]?.trim() ?? null;
}

function removeContradictoryIr35Labels(markdown: string): string {
  return markdown
    .replace(/^-\s*Outside IR35:\s*yes\b.*$/gim, "- Outside IR35: no")
    .replace(/^-\s*Inside IR35:\s*yes\b.*$/gim, "- Inside IR35: no")
    .replace(/^(-\s*Priority notes:\s*)([^\n]+)$/gim, (_line, prefix: string, value: string) => {
      const notes = value
        .split(",")
        .map((note) => note.trim())
        .filter((note) => !/^(?:outside|inside)_ir35$/i.test(note));
      return notes.length > 0 ? `${prefix}${notes.join(", ")}` : "";
    });
}
