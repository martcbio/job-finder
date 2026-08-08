import { describe, expect, test } from "bun:test";
import {
  fetchLiveJobServeRoles,
  jobServeDetailMarkdownFromHtml,
  jobServeRoleToNormalizedJob,
  parseJobServeRolesFromClassicHtml,
} from "../jobserveLive";

const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx?shid=400A6BF6B1A53C1181D0">
  <input name="ctl00$txtKeyWords" value="">
  <input name="selAge" value="3">
  <input type="hidden" name="__VIEWSTATE" value="abc">
</form>`;

const submittedHtml = `<html>
  <body>
    <form>
      <div id="joblistingcollection">
        <div class="jobListItem newjobsum" id="6254F1931AC08CB43F">
          <div class="jobListHeaderPanel">
            <a href="/gb/en/search-jobs-in-London/AGENTIC-AI-ENGINEER-6254F1931AC08CB43F/" class="jobListPosition">Agentic AI Engineer - Hybrid - Contract - Outside IR35</a>
            <a href="/gb/en/W6254F1931AC08CB43F.jsap" class="jobListApply">Apply</a>
            <p class="jobListSkills">Build agentic systems with customers. <a href="/gb/en/W6254F1931AC08CB43F.jsjob">more</a></p>
            <label class="jobListLabel left">Location</label><span class="jobListDetail left">London</span>
            <label class="jobListLabel left">Rate</label><span class="jobListDetail left">£450 per day</span>
            <label class="jobListLabel left">Type</label><span class="jobListDetail left">Contract</span>
            <label class="jobListLabel left">Employment Business</label><span class="jobListDetail left">SixteenFifty</span>
            <label class="jobListLabel left">Posted Date</label><span class="jobListDetail left">05/08/2026 09:17:10</span>
            <label class="jobListLabel left">Duration</label><span class="jobListDetail left">6 months</span>
            <label class="jobListLabel left">Reference</label><span class="jobListDetail left">JSDB108564</span>
          </div>
        </div>
      </div>
    </form>
  </body>
</html>`;

const detailHtml = `<div id="JobDetailPanel">
  <div id="top_detail">
    <div id="LeftJobHeaderWrapper">
      <h1 id="positiontitle"><a href="/gnMfr?src=51784C66D7">Agentic AI Engineer - Hybrid - Contract - Outside IR35</a></h1>
      <span class="td_location_salary">London - £450 per day</span>
      <span id="td_job_type">Contract</span>
      <span id="td_posted_by"><span class="lbl">Posted by:</span> SixteenFifty</span>
      <span id="td_posted_date"><strong>Posted:</strong> Wednesday, 5 August 2026</span>
    </div>
    <div id="md_skills">
      <P>${"Build next-generation automation powered by Agentic AI across cloud engineering, data platforms, and enterprise systems. ".repeat(6)}</P>
      <UL><LI>Design AWS infrastructure</LI><LI>Develop agentic AI solutions</LI></UL>
    </div>
  </div>
  <input value="6254F1931AC08CB43F" />
</div>`;

const detailEnvelope = JSON.stringify({
  d: {
    __type: "JobServe.Web.UI.Pages.KeyFunction.WebServices.RetrieveSingleJobDetailResponse",
    JobDetailHtml: detailHtml,
    ChallengeBits: ["22", "D2"],
    ChallengeBobs: [207, 228],
  },
});

const restrictedHtml =
  "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>";

describe("live JobServe WebServices parsing", () => {
  test("parses classic result blocks and enriches via RetrieveSingleJobDetail", async () => {
    const responses = [
      new Response(seedHtml, { status: 200 }),
      new Response(submittedHtml, { status: 200 }),
      new Response(detailEnvelope, { status: 200 }),
    ];
    const fetcher = (async () =>
      responses.shift() ?? new Response("unexpected", { status: 404 })) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 5,
      fetcher,
    });

    expect(result.pagesFetched).toBe(1);
    expect(result.roles).toHaveLength(1);
    const role = result.roles[0];
    if (!role) throw new Error("Expected parsed role");
    expect(role).toMatchObject({
      job_id: "6254F1931AC08CB43F",
      title: "Agentic AI Engineer - Hybrid - Contract - Outside IR35",
      rate: "£450 per day",
      location: "London",
      job_type: "Contract",
      employer_name: "SixteenFifty",
      detail_status: "success",
    });
    expect(role.posted_date).toBe("05/08/2026 00:00:00");
    expect(role.detail_markdown).toContain("Build next-generation automation");
    expect(role.detail_markdown).toContain("- Design AWS infrastructure");

    const normalized = jobServeRoleToNormalizedJob(role, "agentic");
    expect(normalized.sourceLabel).toBe("JobServe");
    expect(normalized.company).toBe("SixteenFifty");
    expect(normalized.compensation).toContain("£450 per day");
    expect(normalized.raw).toMatchObject({
      job_id: "6254F1931AC08CB43F",
      outside_ir35: true,
    });
  });

  test("stops immediately when JobServe returns its fair-usage restriction page", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      return new Response(restrictedHtml, { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(requests).toBe(1);
    expect(result.roles).toEqual([]);
    expect(result.blockedReason).toContain("usage restricted");
  });

  test("returns a zero-evidence blocked receipt when JobServe restricts search setup", async () => {
    for (const responseBodies of [[restrictedHtml], [seedHtml, restrictedHtml]]) {
      let requests = 0;
      const fetcher = (async () => {
        const body = responseBodies[requests++];
        if (!body) throw new Error("Unexpected request after fair-usage restriction");
        return new Response(body);
      }) as unknown as typeof fetch;

      const result = await fetchLiveJobServeRoles({
        query: "agentic",
        maxPages: 3,
        timeoutMs: 1000,
        requestDelayMs: 0,
        fetcher,
      });

      expect(result.roles).toEqual([]);
      expect(result.pagesFetched).toBe(0);
      expect(result.blockedReason).toContain("usage restricted");
      if (!result.blockedReason) throw new Error("Expected a JobServe block reason");
      expect(result.errors).toEqual([result.blockedReason]);
    }
  });

  test("retains already discovered cards when pagination reaches a fair-usage restriction", async () => {
    const firstPage = `${submittedHtml}<span class="nav_Next"><a href="/gb/en/JobListing.aspx?page=2">Next</a></span>`;
    const responses = [
      new Response(seedHtml),
      new Response(firstPage),
      new Response(
        "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
      ),
    ];
    let requests = 0;
    const fetcher = (async () => {
      const response = responses[requests++];
      if (!response) throw new Error("Unexpected request after fair-usage restriction");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(requests).toBe(3);
    expect(result.pagesFetched).toBe(1);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({
      job_id: "6254F1931AC08CB43F",
      detail_status: "error",
    });
    expect(result.blockedReason).toContain("usage restricted");
    if (!result.blockedReason) throw new Error("Expected a JobServe block reason");
    expect(result.errors).toEqual([result.blockedReason]);
  });

  test("stops detail acquisition and reports a fair-usage block without discarding listings", async () => {
    const responses = [
      new Response(seedHtml),
      new Response(submittedHtml),
      new Response(restrictedHtml),
    ];
    let requests = 0;
    const fetcher = (async () => {
      const response = responses[requests++];
      if (!response) throw new Error("Unexpected request after fair-usage restriction");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 5,
      fetcher,
    });

    expect(requests).toBe(3);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]?.detail_status).toBe("error");
    expect(result.blockedReason).toContain("usage restricted");
    expect(result.errors).toContain(result.blockedReason as string);
  });

  test("retains ordinary detail failures and exposes them as source errors", async () => {
    const responses = [
      new Response(seedHtml),
      new Response(submittedHtml),
      new Response("temporarily unavailable", { status: 503 }),
    ];
    const fetcher = (async () =>
      responses.shift() ?? new Response("unexpected", { status: 404 })) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 5,
      fetcher,
    });

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({ detail_status: "error" });
    expect(result.errors).toEqual([
      "JobServe detail fetch failed for https://www.jobserve.com/gb/en/search-jobs-in-London/AGENTIC-AI-ENGINEER-6254F1931AC08CB43F/: HTTP 503: https://www.jobserve.com/WebServices/JobSearch.asmx/RetrieveSingleJobDetail",
    ]);
    expect(result.blockedReason).toBeNull();
  });

  test("rejects a detail response that does not reference the requested job id", async () => {
    const wrongEnvelope = JSON.stringify({
      d: {
        JobDetailHtml: `<div id="JobDetailPanel"><div id="md_skills"><P>${"Some other job body. ".repeat(40)}</P></div></div>`,
      },
    });
    const responses = [
      new Response(seedHtml),
      new Response(submittedHtml),
      new Response(wrongEnvelope, { status: 200 }),
    ];
    const fetcher = (async () =>
      responses.shift() ?? new Response("unexpected", { status: 404 })) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 5,
      fetcher,
    });

    expect(result.roles[0]).toMatchObject({
      job_id: "6254F1931AC08CB43F",
      detail_status: "error",
      detail_error: "JobServe detail response did not reference job 6254F1931AC08CB43F.",
    });
  });

  test("accepts a successful detail response that references the matching JobServe id", async () => {
    const longBody = `<div id="JobDetailPanel">
      <div id="md_skills"><P>${"Build production agent systems with customers. ".repeat(15)}</P></div>
      <input value="6254F1931AC08CB43F" />
    </div>`;
    const envelope = JSON.stringify({ d: { JobDetailHtml: longBody } });
    const responses = [
      new Response(seedHtml),
      new Response(submittedHtml),
      new Response(envelope, { status: 200 }),
    ];
    const fetcher = (async () =>
      responses.shift() ?? new Response("unexpected", { status: 404 })) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 3,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 5,
      fetcher,
    });

    expect(result.roles[0]).toMatchObject({
      job_id: "6254F1931AC08CB43F",
      detail_status: "success",
    });
    expect(result.roles[0]?.detail_markdown).toContain("Build production agent systems");
  });

  test("paginates classic result pages across nav_Next links", async () => {
    const pageOf = (page: number) => {
      const ids = Array.from({ length: 20 }, (_, i) => `B${page}${String(i).padStart(18, "0")}`);
      const rows = ids
        .map(
          (id) =>
            `<div class="jobListItem" id="${id}"><a href="/gb/en/search-jobs/${id}" class="jobListPosition">Role ${id}</a><p class="jobListSkills"><a href="/gb/en/W${id}.jsjob">more</a></p><label class="jobListLabel left">Rate</label><span class="jobListDetail left">£500 per day</span></div>`,
        )
        .join("");
      const next =
        page < 3
          ? `<span class="nav_Next"><a href="/gb/en/JobListing.aspx?page=${page + 1}">Next</a></span>`
          : "";
      return `<form><div id="joblistingcollection">${rows}</div></form>${next}`;
    };
    const responses = [new Response(seedHtml), new Response(pageOf(1)), new Response(pageOf(2))];
    const fetcher = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 2,
      timeoutMs: 1000,
      requestDelayMs: 0,
      detailLimit: 0,
      fetcher,
    });

    expect(result.pagesFetched).toBe(2);
    expect(result.roles).toHaveLength(40);
  });

  test("converts JobServe detail HTML into scoped markdown with lists", () => {
    const markdown = jobServeDetailMarkdownFromHtml(
      detailHtml,
      "https://www.jobserve.com/gb/en/W6254F1931AC08CB43F.jsjob",
    );

    expect(markdown).toContain("- Design AWS infrastructure");
    expect(markdown).toContain("- Develop agentic AI solutions");
    expect(markdown).not.toContain("ChallengeBits");
  });

  test("parses classic result blocks into normalized JobServe jobs", () => {
    const roles = parseJobServeRolesFromClassicHtml(submittedHtml, {
      pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1",
    });

    expect(roles).toHaveLength(1);
    expect(roles[0]?.title).toBe("Agentic AI Engineer - Hybrid - Contract - Outside IR35");
    expect(roles[0]?.employer_name).toBe("SixteenFifty");
    expect(roles[0]?.outside_ir35).toBe(true);
    expect(roles[0]?.priority_notes).toEqual(["contract", "outside_ir35", "agentic"]);
  });
});
