import { describe, expect, test } from "bun:test";
import {
  filterRecentJobServeContracts,
  type JobServeContractRow,
  rankJobServeContracts,
} from "../jobserveContracts";

function row(overrides: Partial<JobServeContractRow>): JobServeContractRow {
  return {
    id: 1,
    title: "Untitled",
    company: null,
    url: "https://www.jobserve.com/gb/en/job",
    lastSeenAt: "2026-05-22T00:00:00.000Z",
    markdown: "",
    description: "",
    ...overrides,
  };
}

describe("JobServe contract ranking", () => {
  test("ranks strict outside-IR35 contract matches before softened matches", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          id: 1,
          title: "Product Owner",
          markdown: "- Outside IR35: yes\n- Employment type: Contract\nAI delivery",
        }),
        row({
          id: 2,
          title: "Forward Deployed AI Engineer",
          markdown:
            "- Outside IR35: yes\n- Employment type: Contract\nPosted date: 20/05/2026 13:29:08",
        }),
        row({
          id: 3,
          title: "Agentic AI Engineer via Umbrella",
          markdown: "- Employment type: Contract\nPosted date: 22/05/2026 07:00:00",
        }),
      ],
      { limit: 20 },
    );

    expect(ranked.map((item) => [item.id, item.tier])).toEqual([
      [2, 1],
      [1, 2],
      [3, 3],
    ]);
    expect(ranked[0]?.whyMatched).toContain("forward deployed");
    expect(ranked[1]?.whySoftened).toBe("AI-adjacent term only");
  });

  test("does not include inside-IR35 or non-contract jobs when padding", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          id: 1,
          title: "Agentic AI Engineer",
          markdown: "- Inside IR35: yes\n- Outside IR35: no\n- Employment type: Contract",
        }),
        row({
          id: 2,
          title: "Agentic AI Engineer",
          markdown: "- Outside IR35: yes\n- Employment type: Permanent",
        }),
      ],
      { limit: 20 },
    );

    expect(ranked).toEqual([]);
  });

  test("does not let stored search terms create false agentic matches", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          id: 1,
          title: "Contract Project Manager",
          markdown: [
            "- Search term: jobserve-agentic",
            "- Outside IR35: yes",
            "- Employment type: Contract",
            "Plain delivery role.",
          ].join("\n"),
        }),
      ],
      { limit: 20 },
    );

    expect(ranked).toEqual([]);
  });

  test("does not rank permanent per-annum rows as outside IR35", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          title: "Agentic AI Contractor",
          markdown: [
            "- Rate: £85k - £90k per annum + Bonus",
            "- Outside IR35: yes",
            "- Employment type: Permanent",
          ].join("\n"),
        }),
      ],
      { limit: 20 },
    );

    expect(ranked).toEqual([]);
  });

  test("ranks affirmative outside-IR35 day-rate contracts", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          title: "Agentic AI Engineer",
          markdown: "- Rate: £600 per day outside IR35\n- Employment type: Contract",
        }),
      ],
      { limit: 20 },
    );

    expect(ranked.map((item) => [item.tier, item.whyMatched])).toEqual([
      [1, ["outside IR35", "contract", "agentic"]],
    ]);
  });

  test("filters stale postings before the output limit is applied", () => {
    const ranked = rankJobServeContracts(
      [
        row({
          title: "Old Exact Match",
          lastSeenAt: "2026-07-23T12:00:00.000Z",
          markdown:
            "- Outside IR35: yes\n- Employment type: Contract\nPosted date: 22/05/2026 07:00:00\nAgentic AI",
        }),
        row({
          title: "Fresh Adjacent Match",
          lastSeenAt: "2026-07-23T12:00:00.000Z",
          markdown:
            "- Outside IR35: yes\n- Employment type: Contract\nPosted date: 22/07/2026 07:00:00\nLLM",
        }),
      ],
      { limit: 10 },
    );

    expect(
      filterRecentJobServeContracts(ranked, {
        maxAgeDays: 30,
        now: new Date("2026-07-23T12:00:00.000Z"),
      }).map((job) => job.title),
    ).toEqual(["Fresh Adjacent Match"]);
  });
});
