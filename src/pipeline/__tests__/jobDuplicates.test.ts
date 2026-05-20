import { describe, expect, test } from "bun:test";
import {
  buildDuplicateCandidateJobsSql,
  buildReviewDuplicateCandidateSql,
  buildUpsertDuplicateCandidateSql,
  findDuplicateCandidates,
  isDuplicateCandidateState,
} from "../jobDuplicates";

describe("findDuplicateCandidates", () => {
  test("suggests same-company similar-title candidates without suppressing jobs", () => {
    const candidates = findDuplicateCandidates(
      [
        {
          id: "2",
          title: "Senior Agentic Engineer",
          company_hint: "Webflow Inc",
          canonical_url: "https://a.example/jobs/2",
          category: "agentic_engineer",
        },
        {
          id: "1",
          title: "Sr Agentic Eng",
          company_hint: "Webflow",
          canonical_url: "https://b.example/jobs/1",
          category: "agentic_engineer",
        },
      ],
      0.7,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.jobIdA).toBe("1");
    expect(candidates[0]?.jobIdB).toBe("2");
    expect(candidates[0]?.reason).toContain("same_company");
    expect(candidates[0]?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  test("does not suggest weak cross-company matches", () => {
    const candidates = findDuplicateCandidates(
      [
        {
          id: "1",
          title: "Senior Agentic Engineer",
          company_hint: "Webflow",
          canonical_url: "https://a.example/jobs/1",
          category: "agentic_engineer",
        },
        {
          id: "2",
          title: "Backend Data Platform Engineer",
          company_hint: "Acme",
          canonical_url: "https://b.example/jobs/2",
          category: "other",
        },
      ],
      0.7,
    );

    expect(candidates).toHaveLength(0);
  });
});

describe("duplicate SQL builders", () => {
  test("accepts known duplicate candidate states", () => {
    expect(isDuplicateCandidateState("suggested")).toBe(true);
    expect(isDuplicateCandidateState("confirmed_same")).toBe(true);
    expect(isDuplicateCandidateState("bogus")).toBe(false);
  });

  test("builds candidate source query", () => {
    const sql = buildDuplicateCandidateJobsSql(50);

    expect(sql).toContain("FROM job_search.jobs");
    expect(sql).toContain("review_state <> 'rejected_by_us'");
    expect(sql).toContain("LIMIT 50");
  });

  test("builds conservative upsert query", () => {
    const sql = buildUpsertDuplicateCandidateSql({
      jobIdA: "9",
      jobIdB: "3",
      confidence: 0.81234,
      reason: "same company",
    });

    expect(sql).toContain("INSERT INTO job_search.duplicate_candidates");
    expect(sql).toContain("'3'");
    expect(sql).toContain("'9'");
    expect(sql).toContain("0.8123");
    expect(sql).toContain("WHERE job_search.duplicate_candidates.state = 'suggested'");
  });

  test("builds duplicate candidate review update with review event feedback", () => {
    const sql = buildReviewDuplicateCandidateSql({
      candidateId: "12",
      state: "confirmed_distinct",
      actor: "human",
      reasonCodes: ["different_team"],
      note: "Different job despite similar title",
    });

    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("WHERE id = '12'");
    expect(sql).toContain("state = 'confirmed_distinct'");
    expect(sql).toContain("reviewed_by = 'human'");
    expect(sql).toContain("ARRAY['different_team']::text[]");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain(
      "ARRAY['duplicate_candidate_review', 'confirmed_distinct', 'different_team']::text[]",
    );
    expect(sql).toContain("'Different job despite similar title'");
  });
});
