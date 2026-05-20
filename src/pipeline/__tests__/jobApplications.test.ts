import { describe, expect, test } from "bun:test";
import {
  applicationStatusToReviewState,
  buildListApplicationsSql,
  buildRecordApplicationSql,
  isApplicationStatus,
  renderApplicationsMarkdown,
} from "../jobApplications";

describe("application status helpers", () => {
  test("accepts known statuses and maps them to review states", () => {
    expect(isApplicationStatus("applied")).toBe(true);
    expect(isApplicationStatus("bogus")).toBe(false);
    expect(applicationStatusToReviewState("prepared")).toBe("ready_to_apply");
    expect(applicationStatusToReviewState("waiting")).toBe("waiting");
    expect(applicationStatusToReviewState("withdrawn")).toBe("rejected_by_us");
  });
});

describe("buildRecordApplicationSql", () => {
  test("inserts local application record and review event", () => {
    const sql = buildRecordApplicationSql({
      jobId: "42",
      cvDraftId: "9",
      status: "applied",
      channel: "greenhouse",
      externalUrl: "https://example.com/application",
      appliedAt: "2026-05-20T00:00:00Z",
      note: "Submitted manually",
      actor: "human",
    });

    expect(sql).toContain("INSERT INTO job_search.job_applications");
    expect(sql).toContain("WHERE id = '42'");
    expect(sql).toContain("'9'::bigint");
    expect(sql).toContain("'applied'");
    expect(sql).toContain("'2026-05-20T00:00:00Z'::timestamptz");
    expect(sql).toContain("SET review_state = 'applied'");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain("ARRAY['application_recorded', 'applied']::text[]");
  });

  test("defaults applied timestamp to now for waiting records", () => {
    const sql = buildRecordApplicationSql({
      jobId: "42",
      cvDraftId: null,
      status: "waiting",
      channel: null,
      externalUrl: null,
      appliedAt: null,
      note: null,
      actor: "agent",
    });

    expect(sql).toContain("now()");
    expect(sql).toContain("SET review_state = 'waiting'");
    expect(sql).toContain("'agent'");
  });
});

describe("application listing", () => {
  test("builds bounded optional status query", () => {
    const sql = buildListApplicationsSql({ status: "waiting", limit: 10 });

    expect(sql).toContain("FROM job_search.job_applications ja");
    expect(sql).toContain("JOIN job_search.jobs j ON j.id = ja.job_id");
    expect(sql).toContain("WHERE ja.status = 'waiting'");
    expect(sql).toContain("LIMIT 10");
  });

  test("renders application markdown", () => {
    const markdown = renderApplicationsMarkdown([
      {
        id: "7",
        job_id: "42",
        cv_draft_id: "9",
        status: "applied",
        title: "Senior Agentic Engineer",
        company_hint: "Acme",
        canonical_url: "https://jobs.example.com/42",
        channel: "greenhouse",
        external_url: "https://example.com/application",
        applied_at: "2026-05-20T00:00:00.000Z",
        note: "Submitted manually",
        created_at: "2026-05-20T00:00:00.000Z",
      },
    ]);

    expect(markdown).toContain("# Job Applications");
    expect(markdown).toContain("## Senior Agentic Engineer");
    expect(markdown).toContain("- Status: applied");
    expect(markdown).toContain("- CV draft ID: 9");
    expect(markdown).toContain("- Channel: greenhouse");
  });
});
