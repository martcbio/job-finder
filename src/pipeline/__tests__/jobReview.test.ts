import { describe, expect, test } from "bun:test";
import {
  buildReviewEventsSql,
  buildReviewTransitionSql,
  isReviewActor,
  isReviewState,
} from "../jobReview";

describe("review value guards", () => {
  test("accepts known review states and actors", () => {
    expect(isReviewState("ready_for_review")).toBe(true);
    expect(isReviewState("bogus")).toBe(false);
    expect(isReviewActor("human")).toBe(true);
    expect(isReviewActor("bot")).toBe(false);
  });
});

describe("buildReviewTransitionSql", () => {
  test("updates job state and appends a review event", () => {
    const sql = buildReviewTransitionSql({
      jobId: "42",
      toState: "shortlisted",
      reasonCodes: ["strong_match", "rag"],
      note: "Worth a close look",
      actor: "human",
    });

    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("SET review_state = 'shortlisted'");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain("ARRAY['strong_match', 'rag']::text[]");
    expect(sql).toContain("'Worth a close look'");
    expect(sql).toContain("WHERE id = '42'");
  });

  test("supports empty reason codes and null notes", () => {
    const sql = buildReviewTransitionSql({
      jobId: "42",
      toState: "not_relevant",
      reasonCodes: [],
      note: null,
      actor: "agent",
    });

    expect(sql).toContain("ARRAY[]::text[]");
    expect(sql).toContain("NULL");
    expect(sql).toContain("'agent'");
  });
});

describe("buildReviewEventsSql", () => {
  test("builds a bounded history query", () => {
    const sql = buildReviewEventsSql("42", 10);

    expect(sql).toContain("FROM job_search.review_events");
    expect(sql).toContain("WHERE job_id = '42'");
    expect(sql).toContain("LIMIT 10");
  });
});
