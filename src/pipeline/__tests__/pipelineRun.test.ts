import { describe, expect, test } from "bun:test";
import {
  buildCompletePipelineRunSql,
  buildCompletePipelineRunStepSql,
  buildCreatePipelineRunSql,
  buildInsertPipelineRunStepsSql,
  buildPipelineHistorySql,
  buildStartPipelineRunStepSql,
  renderPipelineHistoryMarkdown,
} from "../pipelineRun";

describe("pipeline run SQL", () => {
  test("builds create run SQL with saved sweep linkage", () => {
    const sql = buildCreatePipelineRunSql({
      sweepName: "daily-agentic",
      commandArgs: ["--sweep", "daily-agentic"],
    });

    expect(sql).toContain("INSERT INTO job_search.pipeline_runs");
    expect(sql).toContain("SELECT id FROM job_search.saved_sweeps");
    expect(sql).toContain("'daily-agentic'");
    expect(sql).toContain("ARRAY['--sweep', 'daily-agentic']::text[]");
  });

  test("builds step insertion SQL", () => {
    const sql = buildInsertPipelineRunStepsSql("7", [
      {
        name: "db_check",
        description: "Verify DB",
        command: ["bun", "run", "db:check"],
      },
      {
        name: "search",
        description: "Search",
        command: ["bun", "run", "search:db", "--", "-k", "Agentic Engineer"],
      },
    ]);

    expect(sql).toContain("INSERT INTO job_search.pipeline_run_steps");
    expect(sql).toContain("'7'");
    expect(sql).toContain("'db_check'");
    expect(sql).toContain("ARRAY['bun', 'run', 'db:check']::text[]");
    expect(sql).toContain("bun run search:db -- -k ''Agentic Engineer''");
  });

  test("builds step lifecycle SQL", () => {
    expect(buildStartPipelineRunStepSql("7", 2)).toContain("SET status = 'running'");
    const completed = buildCompletePipelineRunStepSql({
      runId: "7",
      position: 2,
      status: "failed",
      durationMs: 123,
      exitCode: 1,
      error: "boom",
    });

    expect(completed).toContain("SET status = 'failed'");
    expect(completed).toContain("duration_ms = 123");
    expect(completed).toContain("exit_code = 1");
    expect(completed).toContain("error = 'boom'");
  });

  test("builds run completion and history SQL", () => {
    expect(
      buildCompletePipelineRunSql({
        runId: "7",
        status: "completed",
        errorSummary: null,
      }),
    ).toContain("SET status = 'completed'");
    expect(buildPipelineHistorySql(5)).toContain("LIMIT 5");
  });
});

describe("renderPipelineHistoryMarkdown", () => {
  test("renders step status and errors", () => {
    const markdown = renderPipelineHistoryMarkdown([
      {
        id: "7",
        sweep_name: "daily-agentic",
        status: "failed",
        started_at: "2026-05-20T00:00:00.000Z",
        finished_at: "2026-05-20T00:01:00.000Z",
        error_summary: "search failed",
        steps: [
          {
            position: 1,
            step_name: "db_check",
            status: "completed",
            duration_ms: 100,
            exit_code: 0,
            error: null,
          },
          {
            position: 2,
            step_name: "search",
            status: "failed",
            duration_ms: 200,
            exit_code: 1,
            error: "search failed",
          },
        ],
      },
    ]);

    expect(markdown).toContain("# Pipeline Runs");
    expect(markdown).toContain("## Run 7");
    expect(markdown).toContain("- Sweep: daily-agentic");
    expect(markdown).toContain('2. search: failed 200ms exit=1 error="search failed"');
  });
});
