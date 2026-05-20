import { quoteSqlLiteral } from "../db/config";
import type { ReviewActor } from "./jobReview";

export interface CvDraftJobRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  review_state: string;
  labels: CvDraftLabel[];
  bullet_blocks: CvBulletBlock[];
}

export interface CvDraftLabel {
  label: string;
  source_stage: string;
  confidence: string | number;
}

export interface CvBulletBlock {
  id: string;
  theme_key: string;
  title: string;
  bullet_text: string;
  evidence_note: string;
}

export interface CvDraftRenderOptions {
  generatedAt: Date;
  maxBullets: number;
}

export interface CvDraft {
  themeKeys: string[];
  bulletBlockIds: string[];
  markdown: string;
}

export const CV_DRAFT_STATUSES = [
  "needs_human_review",
  "approved",
  "rejected",
  "superseded",
] as const;

export type CvDraftStatus = (typeof CV_DRAFT_STATUSES)[number];

export interface CvDraftReviewInput {
  draftId: string;
  status: Exclude<CvDraftStatus, "needs_human_review">;
  actor: ReviewActor;
  reasonCodes: string[];
  note: string | null;
}

export interface CvDraftReviewRow {
  id: string;
  job_id: string;
  previous_status: CvDraftStatus;
  status: CvDraftStatus;
  event_id: string;
}

export function isCvDraftStatus(value: string): value is CvDraftStatus {
  return (CV_DRAFT_STATUSES as readonly string[]).includes(value);
}

export function buildCvDraftSourceSql(jobId: string, maxBullets: number): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(draft_source)
    FROM (
      SELECT
        j.id::text AS id,
        j.title_normalized AS title,
        j.company_hint,
        j.canonical_url,
        j.review_state,
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'label', label_rows.label,
                'source_stage', label_rows.source_stage,
                'confidence', label_rows.confidence
              )
              ORDER BY
                CASE label_rows.source_stage WHEN 'page' THEN 0 WHEN 'metadata' THEN 1 ELSE 2 END,
                label_rows.confidence DESC,
                label_rows.label
            )
            FROM (
              SELECT DISTINCT ON (jcl.label)
                jcl.label,
                jcl.source_stage,
                jcl.confidence
              FROM job_search.job_classification_labels jcl
              WHERE jcl.job_id = j.id
              ORDER BY
                jcl.label,
                CASE jcl.source_stage WHEN 'page' THEN 0 WHEN 'metadata' THEN 1 ELSE 2 END,
                jcl.confidence DESC
            ) label_rows
          ),
          '[]'::json
        ) AS labels,
        COALESCE(
          (
            SELECT json_agg(row_to_json(block_row))
            FROM (
              SELECT DISTINCT ON (cbb.id)
                cbb.id::text AS id,
                cbb.theme_key,
                cbb.title,
                cbb.bullet_text,
                cbb.evidence_note
              FROM job_search.cv_bullet_blocks cbb
              JOIN job_search.job_classification_labels jcl ON jcl.label = cbb.theme_key
              WHERE jcl.job_id = j.id
                AND cbb.status = 'approved'
              ORDER BY cbb.id, jcl.confidence DESC
              LIMIT ${maxBullets}
            ) block_row
          ),
          '[]'::json
        ) AS bullet_blocks
      FROM job_search.jobs j
      WHERE j.id = ${quoteSqlLiteral(jobId)}
    ) draft_source
  ),
  'null'::json
);`;
}

export function buildInsertCvDraftSql(jobId: string, draft: CvDraft, note: string | null): string {
  return `INSERT INTO job_search.job_cv_drafts (
  job_id,
  theme_keys,
  bullet_block_ids,
  draft_markdown,
  note
)
VALUES (
  ${quoteSqlLiteral(jobId)},
  ${textArrayLiteral(draft.themeKeys)},
  ${bigintArrayLiteral(draft.bulletBlockIds)},
  ${quoteSqlLiteral(draft.markdown)},
  ${nullableText(note)}
)
RETURNING json_build_object(
  'id', id::text,
  'job_id', job_id::text,
  'status', status,
  'generated_at', generated_at
);`;
}

export function buildApprovedBulletInsertSql(input: {
  themeKey: string;
  title: string;
  bulletText: string;
  evidenceNote: string;
}): string {
  return `INSERT INTO job_search.cv_bullet_blocks (
  theme_key,
  title,
  bullet_text,
  evidence_note,
  status
)
VALUES (
  ${quoteSqlLiteral(input.themeKey)},
  ${quoteSqlLiteral(input.title)},
  ${quoteSqlLiteral(input.bulletText)},
  ${quoteSqlLiteral(input.evidenceNote)},
  'approved'
)
RETURNING json_build_object(
  'id', id::text,
  'theme_key', theme_key,
  'title', title,
  'status', status
);`;
}

export function buildReviewCvDraftSql(input: CvDraftReviewInput): string {
  return `WITH current_draft AS (
  SELECT id, job_id, status
  FROM job_search.job_cv_drafts
  WHERE id = ${quoteSqlLiteral(input.draftId)}
  FOR UPDATE
),
updated_draft AS (
  UPDATE job_search.job_cv_drafts jcd
  SET status = ${quoteSqlLiteral(input.status)},
      reviewed_at = now(),
      reviewed_by = ${quoteSqlLiteral(input.actor)},
      review_reason_codes = ${textArrayLiteral(input.reasonCodes)},
      review_note = ${nullableText(input.note)}
  FROM current_draft
  WHERE jcd.id = current_draft.id
  RETURNING
    jcd.id,
    jcd.job_id,
    current_draft.status AS previous_status,
    jcd.status
),
current_job AS (
  SELECT j.id, j.review_state
  FROM job_search.jobs j
  JOIN updated_draft ud ON ud.job_id = j.id
),
updated_job AS (
  UPDATE job_search.jobs j
  SET review_state = CASE
    WHEN updated_draft.status = 'approved' THEN 'ready_to_apply'
    WHEN updated_draft.status = 'rejected' AND j.review_state = 'needs_cv_tailoring' THEN 'shortlisted'
    ELSE j.review_state
  END
  FROM updated_draft
  WHERE j.id = updated_draft.job_id
  RETURNING j.id, j.review_state
),
inserted_event AS (
  INSERT INTO job_search.review_events (
    job_id,
    from_state,
    to_state,
    reason_codes,
    note,
    actor
  )
  SELECT
    current_job.id,
    current_job.review_state,
    updated_job.review_state,
    ${textArrayLiteral(["cv_draft_review", input.status, ...input.reasonCodes])},
    ${nullableText(input.note)},
    ${quoteSqlLiteral(input.actor)}
  FROM current_job
  JOIN updated_job ON updated_job.id = current_job.id
  RETURNING id
)
SELECT COALESCE(
  (
    SELECT json_build_object(
      'id', updated_draft.id::text,
      'job_id', updated_draft.job_id::text,
      'previous_status', updated_draft.previous_status,
      'status', updated_draft.status,
      'event_id', inserted_event.id::text
    )
    FROM updated_draft, inserted_event
  ),
  'null'::json
);`;
}

export function renderCvDraftMarkdown(row: CvDraftJobRow, options: CvDraftRenderOptions): CvDraft {
  const themeKeys = unique(row.labels.map((label) => label.label));
  const selectedBlocks = row.bullet_blocks.slice(0, options.maxBullets);
  const bulletBlockIds = selectedBlocks.map((block) => block.id);
  const lines = [
    "# CV Draft",
    "",
    `Generated: ${options.generatedAt.toISOString()}`,
    `Job: ${row.title}`,
    `Company: ${row.company_hint ?? "Unknown"}`,
    `URL: ${row.canonical_url}`,
    `Review state: ${row.review_state}`,
    "",
    "## Recommended Focus Themes",
    "",
  ];

  if (row.labels.length === 0) {
    lines.push("- No classification labels are available yet.");
  } else {
    for (const label of row.labels) {
      lines.push(`- ${label.label} (${label.source_stage}, ${formatConfidence(label.confidence)})`);
    }
  }

  lines.push("", "## Reusable Bullet Blocks", "");

  if (selectedBlocks.length === 0) {
    lines.push(
      "_No approved CV bullet blocks matched this job's labels. Add approved blocks before using this draft for an application._",
    );
  } else {
    for (const block of selectedBlocks) {
      lines.push(`- ${block.bullet_text}`);
      if (block.evidence_note.trim()) {
        lines.push(`  Evidence: ${block.evidence_note}`);
      }
    }
  }

  lines.push("", "## Human Review", "");
  lines.push("- Confirm every bullet is accurate for this application before use.");
  lines.push("- Adjust wording to match the job description without adding unsupported claims.");

  return {
    themeKeys,
    bulletBlockIds,
    markdown: `${lines.join("\n")}\n`,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function formatConfidence(confidence: string | number): string {
  if (typeof confidence === "number") return confidence.toFixed(4);
  const parsed = Number.parseFloat(confidence);
  return Number.isFinite(parsed) ? parsed.toFixed(4) : confidence;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}

function bigintArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::bigint[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::bigint[]`;
}
