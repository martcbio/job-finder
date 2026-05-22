import { describe, expect, test } from "bun:test";
import { screenJob } from "../jobScreening";

function screen(markdown: string, title = "Senior Agentic Engineer") {
  return screenJob({
    title,
    companyHint: "Acme",
    canonicalUrl: "https://jobs.example.com/agentic",
    markdown,
  });
}

describe("screenJob", () => {
  test("rejects closed or no-longer-accepting pages", () => {
    const decision = screen(
      "This position has been closed and is no longer accepting applications.",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("closed_or_expired");
  });

  test("rejects inaccessible page snapshots", () => {
    const decision = screen("404 Page Not Found. Verify you are human before continuing.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects placeholder pages for missing ATS jobs", () => {
    const decision = screen(
      "Title: Careers\nThe page you are looking for doesn't exist.\n© 2026 Workday, Inc.",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects non-2xx reader snapshots", () => {
    const decision = screen("Warning: Target URL returned error 410: Gone");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects short reader shells without usable body text", () => {
    const decision = screen(
      "Title: Careers\n\nURL Source: https://example.wd1.myworkdayjobs.com/careers/job/remote/foo\n\nMarkdown Content:\nApply\nSave\n",
      "Product Education Facilitator – Agentic Learning & AI-Enhanced Enablement",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects deleted or unavailable job shells", () => {
    const decision = screen(
      "The Job posting is not available anymore. The job that you're trying to view may be deleted or hidden.",
      "Java Developer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("closed_or_expired");
  });

  test("rejects cookie-wall-only pages", () => {
    const decision = screen(
      "Select which cookies you accept. Strictly necessary. Vendors Teamtailor.",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects ATS metadata without a job body", () => {
    const decision = screen(
      "## ATS Structured Data\n- Primary location: Remote\n- Workplace type: Remote",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inaccessible_page");
  });

  test("rejects US-only remote roles", () => {
    const decision = screen("Remote - United States. Must be authorized to work in the US.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
  });

  test("rejects explicit US-only role locations even when the company claims global distribution", () => {
    const decision = screen(
      "We are globally distributed. For this position, we are looking to hire in the US. Apply now. Finance, Remote (United States).",
      "Global Controller",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
    expect(decision.reasons.map((reason) => reason.code)).toContain("not_target_role");
  });

  test("rejects ATS structured US-remote roles", () => {
    const decision = screen(
      "## ATS Structured Data\n- Primary location: United States\n- All listed locations: United States\n- Workplace type: Remote\n---\nAbout the role\nResponsibilities include building LLM platform services and model orchestration.\nRequirements include production AI infrastructure, distributed systems, and privacy controls.",
      "Senior AI Engineer - AI Platform",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
  });

  test("rejects North America remote roles", () => {
    const decision = screen(
      "Remote - North America (EST). Responsibilities include building agentic AI platform services and secure deployment patterns.",
      "Senior AI Platform Engineer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
  });

  test("rejects explicit US city/state role titles", () => {
    const decision = screen(
      "About the role. Responsibilities include building agentic AI systems for mission customers.",
      "Careers Agentic Engineer in Tysons Corner, Virginia",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
  });

  test("rejects Washington DC role titles", () => {
    const decision = screen(
      "About the role. Responsibilities include building forward-deployed AI systems.",
      "Forward Deployed Engineer in Washington, DC ... - LMI",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
  });

  test("allows US-headquartered roles when global hiring is explicit", () => {
    const decision = screen(
      "HQ: United States. We hire globally regardless of location and have employees worldwide.",
    );

    expect(decision.status).toBe("high_signal");
  });

  test("rejects LATAM-only remote roles", () => {
    const decision = screen("Remote role for LATAM. Candidates must be based in Latin America.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("latam_only");
  });

  test("rejects country-local remote roles", () => {
    const decision = screen("Job Locations\nIN-Remote\nResponsibilities: build AI agents.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("country_local_remote");
  });

  test("keeps ambiguous Switzerland roles out of high signal", () => {
    const decision = screen("Remote role. Location: Zurich, Switzerland.");

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "switzerland_local_or_ambiguous",
    );
  });

  test("rejects Swiss-local roles", () => {
    const decision = screen("Remote within Switzerland only. Must be based in Switzerland.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "switzerland_local_or_ambiguous",
    );
  });

  test("rejects Switzerland-based or Zurich-local roles", () => {
    const decision = screen("Switzerland-based role. You must work from Zurich for team rituals.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "switzerland_local_or_ambiguous",
    );
  });

  test("allows broad Europe remote even when Switzerland is one listed country", () => {
    const decision = screen("Remote across Europe. Locations include Spain, Germany, Switzerland.");

    expect(decision.status).toBe("high_signal");
  });

  test("keeps generic remote-only ATS roles for review", () => {
    const decision = screen(
      [
        "## ATS Structured Data",
        "- Primary location: Remote",
        "- All listed locations: Remote",
        "- Workplace type: Remote",
        "---",
        "About the role",
        "We are seeking a senior engineer to build agentic AI systems for enterprise workflows.",
        "Responsibilities include designing LLM orchestration, retrieval, evaluations, and production services.",
        "Requirements include distributed systems, TypeScript, Python, applied AI product engineering, and ownership.",
        "You will collaborate with founders, customers, product, and design to ship production AI features.",
      ]
        .join("\n")
        .repeat(3),
      "Founding Software Engineer - Agentic AI (Remote)",
    );

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("location_or_remote_unclear");
  });

  test("keeps usable jobs with no remote or acceptable-location signal for review", () => {
    const decision = screen(
      [
        "About the role",
        "We are seeking an experienced Engineering Lead - ML to build next-generation conversational AI agents.",
        "Responsibilities include architecture, delivery, mentoring engineers, and scaling enterprise-grade AI products.",
        "Requirements include reinforcement learning, computer vision, LLM fine-tuning, distributed systems, and cloud platforms.",
        "You will work with product, design, and research teams to deliver real-world outcomes.",
        "This is a rare opportunity to shape how enterprises adopt agentic AI at production scale.",
        "The team owns reliability, model quality, product integration, evaluation, and secure enterprise deployment for complex workflows.",
        "The successful candidate will set technical direction and stay hands-on with implementation, mentoring, and operational excellence.",
      ]
        .join(" ".repeat(40))
        .repeat(2),
      "Machine Learning Lead",
    );

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("location_or_remote_unclear");
  });

  test("rejects security-clearance requirements", () => {
    const decision = screen("Requires active UK SC clearance.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("security_clearance");
  });

  test("rejects US public-trust requirements", () => {
    const decision = screen("Candidates must be able to obtain public trust for federal work.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("security_clearance");
  });

  test("rejects non-English language requirements", () => {
    const decision = screen(
      "Requirements: fluent communication skills in English and Hungarian. Responsibilities include building agentic AI systems.",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("language_requirement");
  });

  test("rejects internships and junior roles", () => {
    const decision = screen("Data Science Intern. New grads ok.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("junior_or_intern");
  });

  test("rejects ordinary Inside IR35 contracts", () => {
    const decision = screen("Six month contract. Inside IR35. Generic enterprise migration.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inside_ir35");
  });

  test("rejects DevOps and SRE primary roles", () => {
    const decision = screen(
      "Build CI/CD, provisioning, observability, production operations, and incident response.",
      "Staff DevOps Engineer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("ops_primary");
  });

  test("rejects non-engineering job titles from broad keyword collisions", () => {
    const decision = screen(
      "Responsibilities include travel, merchandising, store displays, and field visits. Requirements include a valid driver's license.",
      "Project-Based Display Installer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("not_target_role");
  });

  test("rejects non-job content pages from broad keyword collisions", () => {
    const decision = screen(
      "Customer stories that inspire. IT Services and Consulting. Manufacturing. E-commerce. Finance/BFSI. Related articles.",
      "Keka Customer Stories - Real HR Success Stories",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("not_target_role");
  });

  test("keeps exceptional Inside IR35 AI roles for human review", () => {
    const decision = screen("Frontier AI lab. Staff Agent Engineer. Inside IR35 contract.");

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inside_ir35");
  });

  test("rejects index pages via labels", () => {
    const decision = screenJob({
      title: "Careers",
      companyHint: "Acme",
      canonicalUrl: "https://jobs.example.com/careers",
      markdown: "View all jobs at Acme.",
      labels: [{ label: "index_not_job" }],
    });

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("index_or_not_job");
  });

  test("rejects careers roots that list multiple open positions", () => {
    const decision = screenJob({
      title: "Careers at Nurix",
      companyHint: "Nurix",
      canonicalUrl: "https://nurix.keka.com/careers",
      markdown: [
        "Title:",
        "URL Source: https://nurix.keka.com/careers",
        "## Open Positions!",
        "Department",
        "Location",
        "Job Type",
        "[Enterprise Architect](https://nurix.keka.com/careers/jobdetails/40673)",
        "[Sr. DevOps Engineer](https://nurix.keka.com/careers/jobdetails/50186)",
      ].join("\n"),
    });

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("index_or_not_job");
  });

  test("rejects templated ATS index shells", () => {
    const decision = screen(
      "%LABEL_DEPARTMENTS%\n%DROPDOWN_LOCATIONS%\n%BUTTON_APPLY%\nOpen Positions",
      "Senior Agentic Engineer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("index_or_not_job");
  });

  test("rejects templated apply pages with no positions", () => {
    const decision = screen(
      "%HEADER_OUR_OPENINGS%\n%LABEL_NO_POSITIONS%\nThank you for your submission!",
      "Founding Forward Deployed Engineer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("index_or_not_job");
  });
});
