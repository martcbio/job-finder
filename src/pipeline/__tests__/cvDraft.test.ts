import { describe, expect, test } from "bun:test";
import {
  buildApprovedBulletInsertSql,
  buildCvDraftSourceSql,
  buildInsertCvDraftSql,
  buildReviewCvDraftSql,
  type CvDraftJobRow,
  isCvDraftStatus,
  renderCvDraftMarkdown,
} from "../cvDraft";

describe("CV draft SQL builders", () => {
  test("accepts known CV draft statuses", () => {
    expect(isCvDraftStatus("needs_human_review")).toBe(true);
    expect(isCvDraftStatus("approved")).toBe(true);
    expect(isCvDraftStatus("bogus")).toBe(false);
  });

  test("builds source query for job labels and approved bullet blocks", () => {
    const sql = buildCvDraftSourceSql("42", 4);

    expect(sql).toContain("FROM job_search.jobs j");
    expect(sql).toContain("FROM job_search.cv_bullet_blocks cbb");
    expect(sql).toContain("cbb.status = 'approved'");
    expect(sql).toContain("WHERE j.id = '42'");
    expect(sql).toContain("LIMIT 4");
  });

  test("builds draft insert", () => {
    const sql = buildInsertCvDraftSql(
      "42",
      {
        themeKeys: ["agentic_engineer", "rag_enterprise"],
        bulletBlockIds: ["1", "2"],
        markdown: "# CV Draft\n",
      },
      "human review required",
    );

    expect(sql).toContain("INSERT INTO job_search.job_cv_drafts");
    expect(sql).toContain("ARRAY['agentic_engineer', 'rag_enterprise']::text[]");
    expect(sql).toContain("ARRAY['1', '2']::bigint[]");
    expect(sql).toContain("'human review required'");
  });

  test("builds approved bullet insert", () => {
    const sql = buildApprovedBulletInsertSql({
      themeKey: "agentic_engineer",
      title: "Agent systems",
      bulletText: "Shipped reliable agent systems.",
      evidenceNote: "Evidence link",
    });

    expect(sql).toContain("INSERT INTO job_search.cv_bullet_blocks");
    expect(sql).toContain("'agentic_engineer'");
    expect(sql).toContain("'approved'");
    expect(sql).toContain("'Shipped reliable agent systems.'");
  });

  test("builds CV draft review update and linked review event", () => {
    const sql = buildReviewCvDraftSql({
      draftId: "9",
      status: "approved",
      actor: "human",
      reasonCodes: ["accurate", "strong_match"],
      note: "Ready to use",
    });

    expect(sql).toContain("FROM job_search.job_cv_drafts");
    expect(sql).toContain("WHERE id = '9'");
    expect(sql).toContain("SET status = 'approved'");
    expect(sql).toContain("reviewed_by = 'human'");
    expect(sql).toContain("ARRAY['accurate', 'strong_match']::text[]");
    expect(sql).toContain("WHEN updated_draft.status = 'approved' THEN 'ready_to_apply'");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain(
      "ARRAY['cv_draft_review', 'approved', 'accurate', 'strong_match']::text[]",
    );
    expect(sql).toContain("'Ready to use'");
  });
});

describe("renderCvDraftMarkdown", () => {
  test("renders draft with matched approved blocks", () => {
    const row: CvDraftJobRow = {
      id: "42",
      title: "Senior Agentic Engineer",
      company_hint: "Acme",
      canonical_url: "https://jobs.example.com/42",
      review_state: "needs_cv_tailoring",
      labels: [
        { label: "agentic_engineer", source_stage: "page", confidence: "0.7400" },
        { label: "rag_enterprise", source_stage: "page", confidence: "0.7600" },
      ],
      bullet_blocks: [
        {
          id: "1",
          theme_key: "agentic_engineer",
          title: "Agent systems",
          bullet_text: "Shipped reliable agent systems.",
          evidence_note: "Project evidence",
        },
      ],
    };

    const draft = renderCvDraftMarkdown(row, {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      maxBullets: 6,
    });

    expect(draft.themeKeys).toEqual(["agentic_engineer", "rag_enterprise"]);
    expect(draft.bulletBlockIds).toEqual(["1"]);
    expect(draft.markdown).toContain("# CV Draft");
    expect(draft.markdown).toContain("- agentic_engineer (page, 0.7400)");
    expect(draft.markdown).toContain("- Shipped reliable agent systems.");
    expect(draft.markdown).toContain("Evidence: Project evidence");
    expect(draft.markdown).toContain("Confirm every bullet is accurate");
  });

  test("does not invent bullets when no approved blocks match", () => {
    const row: CvDraftJobRow = {
      id: "42",
      title: "Senior Agentic Engineer",
      company_hint: null,
      canonical_url: "https://jobs.example.com/42",
      review_state: "ready_for_review",
      labels: [{ label: "agentic_engineer", source_stage: "page", confidence: 0.74 }],
      bullet_blocks: [],
    };

    const draft = renderCvDraftMarkdown(row, {
      generatedAt: new Date("2026-05-20T00:00:00.000Z"),
      maxBullets: 6,
    });

    expect(draft.bulletBlockIds).toEqual([]);
    expect(draft.markdown).toContain("No approved CV bullet blocks matched");
  });
});
