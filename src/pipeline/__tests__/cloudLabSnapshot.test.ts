import { describe, expect, test } from "bun:test";
import { buildCloudLabSnapshot, type CloudLabOpening, type CloudLabRun } from "../cloudLabSnapshot";

const RUN: CloudLabRun = {
  run_id: "20260725T064101936Z_run",
  completed_at: "2026-07-25T06:41:17Z",
  health: "complete",
  raw_openings_count: 3,
  eligible_openings_count: 2,
  suitable_openings_count: 1,
  unsuitable_location_openings_count: 1,
  unsuitable_role_openings_count: 1,
  undecided_openings_count: 0,
  substrate: "modal",
};

function opening(id: string): CloudLabOpening {
  return {
    org: "anthropic",
    ats: "greenhouse",
    external_id: id,
    title: "AI Engineer",
    company: "Anthropic",
    location: "London",
    locations: ["London"],
    url: `https://example.com/jobs/${id}`,
    posted_at: "2026-07-25T05:00:00Z",
    location_eligibility: "eligible",
    location_reason_codes: ["location.europe_or_uk"],
    role_relevance: "relevant",
    role_reason_codes: ["role.technical"],
    disposition: "suitable",
    raw: { content: "Full job body" },
  };
}

describe("cloud lab snapshot", () => {
  test("transposes the complete Modal non-US candidate set into the local artifact contract", () => {
    const snapshot = buildCloudLabSnapshot(RUN, [
      opening("job-1"),
      { ...opening("job-2"), disposition: "unsuitable_role", role_relevance: "irrelevant" },
    ]);

    expect(snapshot.status).toMatchObject({
      projectionId: "lab-openings",
      runId: RUN.run_id,
      trigger: "cloud-sync",
      completedAt: RUN.completed_at,
      status: "complete",
      summary: {
        rawOpenings: 3,
        syncedOpenings: 2,
        unsuitableLocationOpenings: 1,
      },
    });
    expect(snapshot.rows[0]).toMatchObject({
      id: "job-1",
      postedAt: "2026-07-25T05:00:00Z",
      locationEligibility: {
        status: "eligible",
        reasonCodes: ["location.europe_or_uk"],
      },
      raw: { content: "Full job body" },
    });
  });

  test("fails loudly when the cloud candidate set is incomplete", () => {
    expect(() => buildCloudLabSnapshot(RUN, [opening("job-1")])).toThrow(
      "expected 2 non-US candidate rows but received 1",
    );
  });

  test("fails loudly when a cloud row lacks its full ATS body", () => {
    expect(() =>
      buildCloudLabSnapshot(RUN, [{ ...opening("job-1"), raw: undefined }, opening("job-2")]),
    ).toThrow("cloud opening job-1 has no raw ATS payload");
  });
});
