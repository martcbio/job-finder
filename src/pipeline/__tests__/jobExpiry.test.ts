import { describe, expect, test } from "bun:test";
import { buildApplyJobExpirySql, buildExpireCandidatesSql, expiryCutoff } from "../jobExpiry";

describe("expiryCutoff", () => {
  test("subtracts the configured whole-day window", () => {
    expect(expiryCutoff(new Date("2026-07-16T12:00:00.000Z"), 21).toISOString()).toBe(
      "2026-06-25T12:00:00.000Z",
    );
  });

  test("rejects non-positive and fractional day windows", () => {
    expect(() => expiryCutoff(new Date(), 0)).toThrow("positive integer");
    expect(() => expiryCutoff(new Date(), 1.5)).toThrow("positive integer");
  });
});

describe("job expiry SQL", () => {
  const cutoff = new Date("2026-06-25T12:00:00.000Z");

  test("selects only active queue states last seen before the cutoff", () => {
    const sql = buildExpireCandidatesSql(cutoff);
    expect(sql).toContain("last_seen_at < '2026-06-25T12:00:00.000Z'::timestamptz");
    expect(sql).toContain("'ready_for_review'");
    expect(sql).toContain("'duplicate_candidate'");
    expect(sql).not.toContain("'shortlisted'");
  });

  test("moves candidates to stale and records review events", () => {
    const sql = buildApplyJobExpirySql(cutoff);
    expect(sql).toContain("SET review_state = 'stale'");
    expect(sql).toContain("INSERT INTO job_search.review_events");
    expect(sql).toContain("ARRAY['source_expired']::text[]");
  });
});
