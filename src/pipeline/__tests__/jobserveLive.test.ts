import { describe, expect, test } from "bun:test";
import {
  fetchLiveJobServeRoles,
  jobServeDetailMarkdownFromHtml,
  jobServeRoleToNormalizedJob,
  parseJobServeRolesFromClassicHtml,
} from "../jobserveLive";

const classicHtml = `
<form>
  <div id="joblistingcollection">
    <div class="jobListItem" id="ABC123">
      <a href="/gb/en/search-jobs-in-London/FORWARD-DEPLOYED-AI-ENGINEER-ABC123" class="jobListPosition">Forward Deployed AI Engineer</a>
      <a href="/gb/en/WABC123.jsap" class="jobListApply">Apply</a>
      <p class="jobListSkills">Build agentic systems with customers. <a href="/gb/en/WABC123.jsjob">more</a></p>
      <label class="jobListLabel left">Location</label><span class="jobListDetail left">London</span>
      <label class="jobListLabel left">Rate</label><span class="jobListDetail left">£800 - 900 Daily Outside IR35</span>
      <label class="jobListLabel left">Type</label><span class="jobListDetail left">Contract</span>
      <label class="jobListLabel left EmploymentAgency">Employment Agency</label><span class="jobListDetail left">Investigo</span>
      <label class="jobListLabel left">Posted Date</label><span class="jobListDetail left">22/05/2026 09:00:00</span>
      <label class="jobListLabel left">Duration</label><span class="jobListDetail left">6 months</span>
      <label class="jobListLabel left">Reference</label><span class="jobListDetail left">JS123</span>
      <label class="jobListLabel left">Permalink</label><span class="jobListDetail left">https://jobserve.com/gabc</span>
    </div>
  </div>
  <div id="actions"></div>
</form>
`;

describe("live JobServe parsing", () => {
  test("parses classic result blocks into normalized JobServe jobs", () => {
    const roles = parseJobServeRolesFromClassicHtml(classicHtml, {
      pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1",
    });

    expect(roles).toHaveLength(1);
    expect(roles[0]?.title).toBe("Forward Deployed AI Engineer");
    expect(roles[0]?.employer_name).toBe("Investigo");
    expect(roles[0]?.outside_ir35).toBe(true);
    expect(roles[0]?.priority_notes).toEqual([
      "contract",
      "outside_ir35",
      "forward_deployed",
      "agentic",
    ]);

    const [role] = roles;
    if (!role) throw new Error("Expected parsed role");
    const normalized = jobServeRoleToNormalizedJob(role, "forward deployed engineer");
    expect(normalized.sourceLabel).toBe("JobServe");
    expect(normalized.company).toBe("Investigo");
    expect(normalized.compensation).toContain("Outside IR35");
    expect(normalized.raw).toMatchObject({
      job_id: "ABC123",
      reference: "JS123",
      outside_ir35: true,
    });
  });

  test("decodes ampersands in JobServe card text", () => {
    const [role] = parseJobServeRolesFromClassicHtml(
      classicHtml.replace("Forward Deployed AI Engineer", "R&amp;D Engineer"),
      { pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1" },
    );

    expect(role?.title).toBe("R&D Engineer");
  });

  test("converts JobServe detail pages into scoped markdown with lists", () => {
    const markdown = jobServeDetailMarkdownFromHtml(
      `<!doctype html>
      <html>
        <head><title>Senior AI Engineer</title></head>
        <body>
          <nav><ul><li>Home</li><li>Job Search</li></ul></nav>
          <div id="job">
            <h1>Senior AI Engineer</h1>
            <p>Role Overview</p>
            <ul>
              <li>Design autonomous task execution</li>
              <li>Implement monitoring for agent behaviour</li>
            </ul>
          </div>
        </body>
      </html>`,
      "https://www.jobserve.com/gb/en/WABC123.jsjob",
    );

    expect(markdown).toContain("# Senior AI Engineer");
    expect(markdown).toContain("- Design autonomous task execution");
    expect(markdown).toContain("- Implement monitoring for agent behaviour");
    expect(markdown).not.toContain("Job Search");
  });

  test("prefers fetched detail markdown over the search-card snippet", () => {
    const [role] = parseJobServeRolesFromClassicHtml(classicHtml, {
      pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1",
    });
    if (!role) throw new Error("Expected parsed role");

    const normalized = jobServeRoleToNormalizedJob(
      {
        ...role,
        detail_status: "success",
        detail_markdown: "# Forward Deployed AI Engineer\n\n- Build real agent systems",
        detail_error: "",
      },
      "forward deployed engineer",
    );

    expect(normalized.description).toContain("- Build real agent systems");
    expect(normalized.description).not.toBe(role.summary_snippet);
  });

  test("does not label permanent per-annum roles as IR35", () => {
    const [role] = parseJobServeRolesFromClassicHtml(
      classicHtml
        .replace("£800 - 900 Daily Outside IR35", "£85k - £90k per annum + Bonus, Outside IR35")
        .replace(">Contract<", ">Permanent<"),
      { pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1" },
    );

    expect(role?.outside_ir35).toBe(false);
    expect(role?.inside_ir35).toBe(false);
    expect(role?.priority_notes).not.toContain("outside_ir35");
  });

  test("labels affirmative outside-IR35 day-rate contracts", () => {
    const [role] = parseJobServeRolesFromClassicHtml(
      classicHtml.replace("£800 - 900 Daily Outside IR35", "£600 per day outside IR35"),
      { pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1" },
    );

    expect(role?.outside_ir35).toBe(true);
    expect(role?.priority_notes).toContain("outside_ir35");
  });

  test("does not treat negated IR35 metadata as affirmative", () => {
    const [role] = parseJobServeRolesFromClassicHtml(
      classicHtml.replace("£800 - 900 Daily Outside IR35", "£600 per day, Outside IR35: no"),
      { pageUrl: "https://www.jobserve.com/gb/en/JobListing.aspx?page=1" },
    );

    expect(role?.outside_ir35).toBe(false);
    expect(role?.priority_notes).not.toContain("outside_ir35");
  });

  test("stops immediately when JobServe returns its fair-usage restriction page", async () => {
    let requests = 0;
    const fetcher = (async () => {
      requests++;
      return new Response(
        "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
        { status: 200 },
      );
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
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const restrictedHtml =
      "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>";

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
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const firstPage = `${classicHtml}<span class="nav_Next"><a href="/gb/en/JobListing.aspx?page=2">Next</a></span>`;
    const responses = [
      new Response(seedHtml),
      new Response(
        '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>',
      ),
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

    expect(requests).toBe(4);
    expect(result.pagesFetched).toBe(1);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({
      job_id: "ABC123",
      detail_status: "error",
    });
    expect(result.blockedReason).toContain("usage restricted");
    if (!result.blockedReason) throw new Error("Expected a JobServe block reason");
    expect(result.errors).toEqual([result.blockedReason]);
  });

  test("stops detail acquisition and reports a fair-usage block without discarding listings", async () => {
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const submittedHtml =
      '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>';
    const responses = [
      new Response(seedHtml, { status: 200 }),
      new Response(submittedHtml, { status: 200 }),
      new Response(classicHtml, { status: 200 }),
      new Response(
        "<h1>Usage Restricted</h1><p>Your IP Address has been deemed to exceed our fair usage levels.</p>",
        { status: 200 },
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
      detailLimit: 5,
      fetcher,
    });

    expect(requests).toBe(4);
    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]?.detail_status).toBe("error");
    expect(result.blockedReason).toContain("usage restricted");
    expect(result.errors).toContain(result.blockedReason as string);
  });

  test("retains ordinary detail failures and exposes them as source errors", async () => {
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const responses = [
      new Response(seedHtml),
      new Response(
        '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>',
      ),
      new Response(classicHtml),
      new Response("temporarily unavailable", { status: 503 }),
    ];
    const fetcher = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 1,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({ detail_status: "error" });
    expect(result.errors).toEqual([
      "JobServe detail fetch failed for https://www.jobserve.com/gb/en/WABC123.jsjob: HTTP 503: https://www.jobserve.com/gb/en/WABC123.jsjob",
    ]);
    expect(result.blockedReason).toBeNull();
  });

  test("rejects a detail request that redirects to generic JobServe search", async () => {
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const searchLanding = new Response(`${"Generic search results. ".repeat(30)}`, { status: 200 });
    Object.defineProperty(searchLanding, "url", {
      value: "https://www.jobserve.com/gb/en/JobSearch.aspx?q=agentic",
    });
    const responses = [
      new Response(seedHtml),
      new Response(
        '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>',
      ),
      new Response(classicHtml),
      searchLanding,
    ];
    const fetcher = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 1,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(result.roles[0]).toMatchObject({
      job_id: "ABC123",
      detail_status: "error",
      detail_error:
        "JobServe detail request landed on an unexpected URL: https://www.jobserve.com/gb/en/JobSearch.aspx?q=agentic",
    });
  });

  test("accepts a successful detail response that lands on the matching JobServe id", async () => {
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const detail = new Response(
      `<main id="job"><h1>Forward Deployed AI Engineer</h1><p>${"Build production agent systems with customers. ".repeat(15)}</p></main>`,
      { status: 200 },
    );
    Object.defineProperty(detail, "url", {
      value: "https://www.jobserve.com/gb/en/WABC123.jsjob",
    });
    const responses = [
      new Response(seedHtml),
      new Response(
        '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>',
      ),
      new Response(classicHtml),
      detail,
    ];
    const fetcher = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 1,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(result.roles[0]).toMatchObject({ job_id: "ABC123", detail_status: "success" });
    expect(result.roles[0]?.detail_markdown).toContain("Build production agent systems");
  });

  test("persists security-clearance listings as raw evidence", async () => {
    const restrictedHtml = classicHtml
      .replace("ABC123", "SC123")
      .replace("Build agentic systems with customers.", "SC clearance required.");
    const seedHtml = `<form id="frm1" action="/gb/en/JobSearch.aspx">
      <input name="ctl00$txtKeyWords" value="">
      <input name="selAge" value="3">
    </form>`;
    const responses = [
      new Response(seedHtml, { status: 200 }),
      new Response(
        '<a href="/gb/en/JobListing.aspx?page=1" id="searchtogglelink">Classic View</a>',
        { status: 200 },
      ),
      new Response(restrictedHtml, { status: 200 }),
    ];
    const fetcher = (async () => {
      const response = responses.shift();
      if (!response) throw new Error("Unexpected JobServe request");
      return response;
    }) as unknown as typeof fetch;

    const result = await fetchLiveJobServeRoles({
      query: "agentic",
      maxPages: 1,
      timeoutMs: 1000,
      requestDelayMs: 0,
      fetcher,
    });

    expect(result.roles).toHaveLength(1);
    expect(result.roles[0]).toMatchObject({
      job_id: "SC123",
      security_clearance_required: true,
      detail_status: "error",
    });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("JobServe detail fetch failed");
  });
});
