import { describe, expect, test } from "bun:test";
import {
  type BookmarkQueryPayload,
  buildCompanySignalArtifact,
  companySignalsFor,
  type TwitterReply,
} from "../companySignals";

const query: BookmarkQueryPayload = {
  freshness: {
    last_successful_refresh_utc: "2026-07-25T05:42:42Z",
    age_seconds: 1200,
    stale: false,
  },
  coverage: { covered: 10, total: 10, percent: 100 },
  rows: [
    {
      status_id: "thread-1",
      tweet_time_utc: "2026-07-21T17:00:00Z",
      first_seen_at_utc: "2026-07-21T18:00:00Z",
      author_handle: "benln",
      text: "Which startups are actively hiring? Reply with company name and location.",
      tweet_url: "https://x.com/benln/status/thread-1",
      classification: null,
    },
    {
      status_id: "funding-1",
      tweet_time_utc: "2026-07-20T10:00:00Z",
      first_seen_at_utc: "2026-07-20T11:00:00Z",
      author_handle: "founder",
      text: "Conduct AI just raised a $15m Series A and is hiring.",
      tweet_url: "https://x.com/founder/status/funding-1",
      classification: null,
    },
    {
      status_id: "not-funding",
      tweet_time_utc: "2026-07-20T09:00:00Z",
      first_seen_at_utc: "2026-07-20T10:00:00Z",
      author_handle: "researcher",
      text: "Removing repeated instructions raised scores by 15%.",
      tweet_url: "https://x.com/researcher/status/not-funding",
      classification: null,
    },
  ],
};

const replies: TwitterReply[] = [
  {
    id: "reply-1",
    text: "@benln @ConductAI https://example.com/careers London, NYC",
    createdAt: "Tue Jul 21 17:59:06 +0000 2026",
    author: { username: "founder", name: "Founder" },
  },
];

describe("company signals", () => {
  test("turns bookmark hits and hiring-thread replies into a deduplicated artifact", () => {
    const artifact = buildCompanySignalArtifact({
      generatedAt: "2026-07-25T06:00:00Z",
      queries: [query],
      threadReplies: new Map([["thread-1", replies]]),
    });

    expect(artifact.signals).toHaveLength(2);
    expect(artifact.signals.find((signal) => signal.id === "funding-1")?.kinds).toEqual([
      "funding",
      "hiring",
    ]);
    expect(artifact.signals.find((signal) => signal.id === "reply-1")?.companyHandles).toEqual([
      "ConductAI",
    ]);
    expect(artifact.diagnostics).toEqual([]);
  });

  test("matches company handles and names without source-specific bonuses", () => {
    const artifact = buildCompanySignalArtifact({
      generatedAt: "2026-07-25T06:00:00Z",
      queries: [query],
      threadReplies: new Map([["thread-1", replies]]),
    });

    expect(
      companySignalsFor("Conduct AI", artifact.signals)
        .map((signal) => signal.id)
        .sort(),
    ).toEqual(["funding-1", "reply-1"]);
    expect(companySignalsFor("OpenAI", artifact.signals)).toEqual([]);
  });
});
