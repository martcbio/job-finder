import { describe, expect, test } from "bun:test";
import {
  buildDuplicateCandidateJobsSql,
  buildReviewDuplicateCandidateSql,
  buildUpsertDuplicateCandidateSql,
  findDuplicateCandidates,
  isDuplicateCandidateState,
} from "../jobDuplicates";

describe("findDuplicateCandidates", () => {
  test("marks exact normalized identities from different sources as cross-source duplicates", () => {
    const candidates = findDuplicateCandidates(
      [
        {
          id: "10",
          title: "Senior AI Engineer",
          company_hint: "Acme Ltd",
          canonical_url: "https://jobserve.example/10",
          category: "agentic_engineer",
          location_hint: "London, England",
          source_ids: ["jobserve"],
        },
        {
          id: "12",
          title: "Senior AI Engineer",
          company_hint: "Acme",
          canonical_url: "https://boards.greenhouse.io/acme/12",
          category: "agentic_engineer",
          location_hint: "London (Hybrid), UK",
          source_ids: ["greenhouse"],
        },
      ],
      0.82,
    );

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ jobIdA: "10", jobIdB: "12", confidence: 0.99 });
    expect(candidates[0]?.reason).toContain("cross_source_exact");
  });

  test("does not mark same-source or different-city identities as cross-source duplicates", () => {
    const base = {
      title: "Senior AI Engineer",
      company_hint: "Acme",
      category: "agentic_engineer",
    };
    const candidates = findDuplicateCandidates(
      [
        {
          ...base,
          id: "10",
          canonical_url: "https://example.com/10",
          location_hint: "London",
          source_ids: ["jobserve"],
        },
        {
          ...base,
          id: "11",
          canonical_url: "https://example.com/11",
          location_hint: "London",
          source_ids: ["jobserve"],
        },
        {
          ...base,
          id: "12",
          canonical_url: "https://example.com/12",
          location_hint: "Manchester",
          source_ids: ["greenhouse"],
        },
      ],
      0.82,
    );

    expect(candidates.some((candidate) => candidate.reason.includes("cross_source_exact"))).toBe(
      false,
    );
  });

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
    expect(sql).toContain("source_ids");
    expect(sql).toContain("location_hint");
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
