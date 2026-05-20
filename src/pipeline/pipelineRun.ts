import { quoteSqlLiteral } from "../db/config";
import type { PipelineStep } from "./pipelinePlan";
import { shellQuoteArgs } from "./pipelinePlan";

export const PIPELINE_RUN_STATUSES = ["running", "completed", "failed"] as const;
export const PIPELINE_STEP_STATUSES = ["pending", "running", "completed", "failed"] as const;

export type PipelineRunStatus = (typeof PIPELINE_RUN_STATUSES)[number];
export type PipelineStepStatus = (typeof PIPELINE_STEP_STATUSES)[number];

export interface CreatePipelineRunInput {
  sweepName: string | null;
  commandArgs: string[];
}

export interface PipelineRunRow {
  id: string;
  sweep_name: string | null;
  status: PipelineRunStatus;
  started_at: string;
  finished_at: string | null;
  error_summary: string | null;
}

export interface PipelineStepStartRow {
  id: string;
  pipeline_run_id: string;
  position: number;
  step_name: string;
}

export interface CompletePipelineRunStepInput {
  runId: string;
  position: number;
  status: Exclude<PipelineStepStatus, "pending" | "running">;
  durationMs: number;
  exitCode: number | null;
  error: string | null;
}

export interface CompletePipelineRunInput {
  runId: string;
  status: Exclude<PipelineRunStatus, "running">;
  errorSummary: string | null;
}

export interface PipelineHistoryRow {
  id: string;
  sweep_name: string | null;
  status: PipelineRunStatus;
  started_at: string;
  finished_at: string | null;
  error_summary: string | null;
  steps: PipelineHistoryStep[];
}

export interface PipelineHistoryStep {
  position: number;
  step_name: string;
  status: PipelineStepStatus;
  duration_ms: number | null;
  exit_code: number | null;
  error: string | null;
}

export function buildCreatePipelineRunSql(input: CreatePipelineRunInput): string {
  return `INSERT INTO job_search.pipeline_runs (
  saved_sweep_id,
  sweep_name,
  command_args
)
VALUES (
  ${savedSweepIdSubquery(input.sweepName)},
  ${nullableText(input.sweepName)},
  ${textArrayLiteral(input.commandArgs)}
)
RETURNING json_build_object(
  'id', id::text,
  'sweep_name', sweep_name,
  'status', status,
  'started_at', started_at,
  'finished_at', finished_at,
  'error_summary', error_summary
);`;
}

export function buildInsertPipelineRunStepsSql(runId: string, steps: PipelineStep[]): string {
  if (steps.length === 0) {
    throw new Error("Pipeline run must include at least one step");
  }

  const values = steps
    .map((step, index) => {
      const position = index + 1;
      return `(
    ${quoteSqlLiteral(runId)},
    ${position},
    ${quoteSqlLiteral(step.name)},
    ${quoteSqlLiteral(step.description)},
    ${textArrayLiteral(step.command)},
    ${quoteSqlLiteral(shellQuoteArgs(step.command))}
  )`;
    })
    .join(",\n");

  return `WITH inserted AS (
  INSERT INTO job_search.pipeline_run_steps (
  pipeline_run_id,
  position,
  step_name,
  description,
  command_args,
  command_display
)
VALUES
${values}
  RETURNING id
)
SELECT json_build_object('inserted', count(*))
FROM inserted;`;
}

export function buildStartPipelineRunStepSql(runId: string, position: number): string {
  return `UPDATE job_search.pipeline_run_steps
SET status = 'running',
    started_at = now()
WHERE pipeline_run_id = ${quoteSqlLiteral(runId)}
  AND position = ${position}
RETURNING json_build_object(
  'id', id::text,
  'pipeline_run_id', pipeline_run_id::text,
  'position', position,
  'step_name', step_name
);`;
}

export function buildCompletePipelineRunStepSql(input: CompletePipelineRunStepInput): string {
  return `UPDATE job_search.pipeline_run_steps
SET status = ${quoteSqlLiteral(input.status)},
    finished_at = now(),
    duration_ms = ${input.durationMs},
    exit_code = ${nullableInteger(input.exitCode)},
    error = ${nullableText(input.error)}
WHERE pipeline_run_id = ${quoteSqlLiteral(input.runId)}
  AND position = ${input.position}
RETURNING json_build_object(
  'id', id::text,
  'pipeline_run_id', pipeline_run_id::text,
  'position', position,
  'step_name', step_name
);`;
}

export function buildCompletePipelineRunSql(input: CompletePipelineRunInput): string {
  return `UPDATE job_search.pipeline_runs
SET status = ${quoteSqlLiteral(input.status)},
    finished_at = now(),
    error_summary = ${nullableText(input.errorSummary)}
WHERE id = ${quoteSqlLiteral(input.runId)}
RETURNING json_build_object(
  'id', id::text,
  'sweep_name', sweep_name,
  'status', status,
  'started_at', started_at,
  'finished_at', finished_at,
  'error_summary', error_summary
);`;
}

export function buildPipelineHistorySql(limit: number): string {
  return `SELECT COALESCE(json_agg(row_to_json(run_row)), '[]'::json)
FROM (
  SELECT
    pr.id::text AS id,
    pr.sweep_name,
    pr.status,
    pr.started_at,
    pr.finished_at,
    pr.error_summary,
    COALESCE(
      (
        SELECT json_agg(row_to_json(step_row) ORDER BY step_row.position)
        FROM (
          SELECT
            prs.position,
            prs.step_name,
            prs.status,
            prs.duration_ms,
            prs.exit_code,
            prs.error
          FROM job_search.pipeline_run_steps prs
          WHERE prs.pipeline_run_id = pr.id
          ORDER BY prs.position
        ) step_row
      ),
      '[]'::json
    ) AS steps
  FROM job_search.pipeline_runs pr
  ORDER BY pr.started_at DESC, pr.id DESC
  LIMIT ${limit}
) run_row;`;
}

export function renderPipelineHistoryMarkdown(rows: PipelineHistoryRow[]): string {
  const lines = ["# Pipeline Runs", ""];

  if (rows.length === 0) {
    lines.push("_No pipeline runs found._");
    return `${lines.join("\n")}\n`;
  }

  for (const row of rows) {
    lines.push(`## Run ${row.id}`);
    lines.push("");
    lines.push(`- Status: ${row.status}`);
    lines.push(`- Sweep: ${row.sweep_name ?? "manual"}`);
    lines.push(`- Started: ${row.started_at}`);
    if (row.finished_at) lines.push(`- Finished: ${row.finished_at}`);
    if (row.error_summary) lines.push(`- Error: ${row.error_summary}`);
    lines.push("");
    for (const step of row.steps) {
      const duration = step.duration_ms === null ? "" : ` ${step.duration_ms}ms`;
      const exitCode = step.exit_code === null ? "" : ` exit=${step.exit_code}`;
      const error = step.error === null ? "" : ` error=${JSON.stringify(step.error)}`;
      lines.push(
        `- ${step.position}. ${step.step_name}: ${step.status}${duration}${exitCode}${error}`,
      );
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function savedSweepIdSubquery(sweepName: string | null): string {
  if (sweepName === null) return "NULL";
  return `(SELECT id FROM job_search.saved_sweeps WHERE name = ${quoteSqlLiteral(sweepName)})`;
}

function nullableText(value: string | null): string {
  return value === null ? "NULL" : quoteSqlLiteral(value);
}

function nullableInteger(value: number | null): string {
  return value === null ? "NULL" : String(value);
}

function textArrayLiteral(values: string[]): string {
  if (values.length === 0) return "ARRAY[]::text[]";
  return `ARRAY[${values.map((value) => quoteSqlLiteral(value)).join(", ")}]::text[]`;
}
