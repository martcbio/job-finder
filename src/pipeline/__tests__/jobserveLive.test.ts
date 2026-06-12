import { describe, expect, test } from "bun:test";
import {
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
});
