import { describe, expect, test } from "bun:test";
import type { ApplicationRow, ReviewQueueRow } from "../../types";
import {
  applicationInputFromQueueRow,
  deriveApplicationFunnel,
  groupApplications,
  nextApplicationStatus,
} from "../applicationBoardModel";

function application(
  status: ApplicationRow["status"],
  history: ApplicationRow["status_history"] = [],
): ApplicationRow {
  return {
    id: status,
    org: "acme",
    ats: "greenhouse",
    external_id: status,
    source: "lab-openings",
    title: "Engineer",
    company: "Acme",
    url: `https://example.com/${status}`,
    status,
    status_history: history,
    cv_ref: null,
    notes: null,
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-15T00:00:00Z",
  };
}

describe("application board model", () => {
  test("groups only board statuses", () => {
    const grouped = groupApplications([
      application("interested"),
      application("sent"),
      application("offer"),
      application("closed"),
    ]);
    expect(grouped.interested).toHaveLength(1);
    expect(grouped.sent).toHaveLength(1);
    expect(Object.keys(grouped)).toEqual([
      "interested",
      "shortlisted",
      "cv_staged",
      "sent",
      "response",
      "interview",
    ]);
  });

  test("returns the one legal forward status", () => {
    expect(nextApplicationStatus("interested")).toBe("shortlisted");
    expect(nextApplicationStatus("cv_staged")).toBe("sent");
    expect(nextApplicationStatus("offer")).toBeNull();
    expect(nextApplicationStatus("closed")).toBeNull();
  });

  test("derives funnel counts and 30-day interviews from history timestamps", () => {
    const funnel = deriveApplicationFunnel(
      [
        application("interview", [
          { status: "interview", at: "2026-07-10T00:00:00Z", by: "owner" },
        ]),
        application("offer", [
          { status: "interview", at: "2026-05-01T00:00:00Z", by: "owner" },
        ]),
        application("sent"),
      ],
      new Date("2026-07-16T00:00:00Z"),
    );
    expect(funnel.counts.interview).toBe(1);
    expect(funnel.counts.offer).toBe(1);
    expect(funnel.interviewsAllTime).toBe(2);
    expect(funnel.interviews30d).toBe(1);
  });

  test("extracts stable ATS provenance from a queue row", () => {
    const job = {
      id: "12",
      title: "AI Engineer",
      company_hint: "Acme",
      canonical_url: "https://job-boards.greenhouse.io/acme/jobs/9988",
      source_labels: ["greenhouse-direct"],
    } as ReviewQueueRow;
    expect(applicationInputFromQueueRow(job)).toMatchObject({
      org: "acme",
      ats: "greenhouse",
      external_id: "9988",
      source: "lab-openings",
    });
  });
});
