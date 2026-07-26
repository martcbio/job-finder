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

  test("rejects an exact North America structured location", () => {
    const decision = screenJob({
      title: "Senior Product Engineer, AI",
      companyHint: "Linear",
      canonicalUrl: "https://linear.app/careers/example",
      locationHint: "North America",
      markdown: "About the role. Responsibilities include building production AI products.",
    });

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

  test("does not treat a non-US role as US-only because the body lists US offices", () => {
    const decision = screenJob({
      title: "Senior Research Scientist",
      companyHint: "Cohere",
      canonicalUrl: "https://jobs.example.com/cohere/research-scientist",
      locationHint: "London",
      markdown: [
        "About the role",
        "Lead frontier machine-learning research from our London team.",
        "We are co-headquartered in Toronto and San Francisco, with offices in London, New York City, Montreal, Paris, and more.",
        "Responsibilities include original research, publications, mentoring, and building production machine-learning systems.",
        "Requirements include extensive research experience, machine-learning expertise, and scientific leadership.",
      ]
        .join("\n")
        .repeat(4),
    });

    expect(decision.reasons.map((reason) => reason.code)).not.toContain("us_remote_or_auth");
  });

  test("rejects an explicit structured US role location", () => {
    const decision = screenJob({
      title: "Senior Research Scientist",
      companyHint: "Cohere",
      canonicalUrl: "https://jobs.example.com/cohere/research-scientist",
      locationHint: "United States",
      markdown: "About the role. Lead frontier machine-learning research.",
    });

    expect(decision.reasons.map((reason) => reason.code)).toContain("us_remote_or_auth");
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
      "locality_restricted_or_ambiguous",
    );
  });

  test("rejects Swiss-local roles", () => {
    const decision = screen("Remote within Switzerland only. Must be based in Switzerland.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "locality_restricted_or_ambiguous",
    );
  });

  test("rejects Switzerland-based or Zurich-local roles", () => {
    const decision = screen("Switzerland-based role. You must work from Zurich for team rituals.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "locality_restricted_or_ambiguous",
    );
  });

  test("allows broad Europe remote even when Switzerland is one listed country", () => {
    const decision = screen("Remote across Europe. Locations include Spain, Germany, Switzerland.");

    expect(decision.status).toBe("high_signal");
  });

  test("ignores Switzerland mentioned only in recruiter privacy boilerplate", () => {
    const decision = screen(
      [
        "Security Cloud Engineer contract. Location: London, UK.",
        "Your personal data will be processed as described in our Online Privacy Notice.",
        "Personal data may be stored in the UK, EEA, Switzerland and the USA.",
      ].join("\n"),
    );

    expect(decision.reasons.map((reason) => reason.code)).not.toContain(
      "locality_restricted_or_ambiguous",
    );
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

  test("uses an explicit London location hint when the body does not repeat the location", () => {
    const decision = screenJob({
      title: "Senior Software Engineer, AI",
      companyHint: "Google",
      canonicalUrl: "https://careers.example.com/jobs/ai",
      locationHint: "London, UK",
      markdown: [
        "About the role",
        "Build production AI systems and reliable customer-facing services.",
        "Responsibilities include architecture, implementation, evaluation, and operations.",
        "Requirements include distributed systems, TypeScript, Python, and applied AI.",
      ]
        .join(" ")
        .repeat(8),
    });

    expect(decision.status).toBe("high_signal");
    expect(decision.reasons).toEqual([]);
  });

  test("rejects security-clearance requirements", () => {
    const decision = screen("Requires active UK SC clearance.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("security_clearance");
  });

  test("rejects explicit US citizenship or passport requirements regardless of work mode", () => {
    for (const markdown of [
      "On-site in New York. Applicants must hold a US passport.",
      "Work from anywhere. US citizenship is required for this position.",
    ]) {
      const decision = screen(markdown);
      expect(decision.status).toBe("rejected");
      expect(decision.reasons.map((reason) => reason.code)).toContain(
        "citizenship_or_work_authorization",
      );
    }
  });

  test("rejects explicit EU passport or citizenship requirements", () => {
    const decision = screen(
      "Remote across Europe. Candidates must hold an EU passport or EU citizenship.",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain(
      "citizenship_or_work_authorization",
    );
  });

  test("rejects identity requirements but not inclusive recruitment boilerplate", () => {
    const blocked = screen("Applicants must be women. This programme is open to women only.");
    const inclusive = screen(
      "We are an equal opportunity employer. Women are encouraged to apply.",
    );

    expect(blocked.status).toBe("rejected");
    expect(blocked.reasons.map((reason) => reason.code)).toContain(
      "candidate_identity_requirement",
    );
    expect(inclusive.reasons.map((reason) => reason.code)).not.toContain(
      "candidate_identity_requirement",
    );
  });

  test("rejects roles that require the successful candidate to undergo clearance", () => {
    const decision = screen(
      "The successful candidate will be required to undergo a basic level of security clearance before undertaking the assignment.",
    );

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

  test("rejects roles that require Mandarin fluency in the body", () => {
    const decision = screen(
      [
        "About the role",
        "Serve as the technical advisor for customer implementations.",
        "You might thrive in this role if you are fluent in Mandarin.",
        "Responsibilities include deploying production AI systems.",
      ].join("\n"),
      "AI Success Engineer",
    );

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("language_requirement");
  });

  test("rejects internships and junior roles", () => {
    const decision = screen("Data Science Intern. New grads ok.");

    expect(decision.status).toBe("rejected");
    expect(decision.reasons.map((reason) => reason.code)).toContain("junior_or_intern");
  });

  test("flags ordinary Inside IR35 contracts without rejecting them", () => {
    const decision = screen("Six month contract. Inside IR35. Generic enterprise migration.");

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("inside_ir35");
  });

  test("does not treat Inside IR35: no metadata as inside IR35", () => {
    const decision = screen(
      [
        "- Outside IR35: no",
        "- Inside IR35: no",
        "Head of Engineering and AI. London. 12 month contract.",
      ].join("\n"),
      "McCabe & Barton - Head of Engineering and AI",
    );

    expect(decision.reasons.map((reason) => reason.code)).not.toContain("inside_ir35");
  });

  test("flags government contracts for IR35 review even when advertised outside IR35", () => {
    const decision = screen(
      "Outside IR35 remote contract supporting a major UK Government Department.",
      "Data Architect",
    );

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("government_ir35_risk");
  });

  test("flags contracts supporting a public sector organisation as an IR35 caveat", () => {
    const decision = screen(
      "Outside IR35 remote contract supporting a public sector organisation. Category: Public Sector.",
      "Data Architect - AI Governance",
    );

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("government_ir35_risk");
  });

  test("flags regular hybrid or on-site attendance without rejecting the role", () => {
    const decision = screen(
      "Senior AI Engineer. Three days per week in the London office. Build production LLM systems.",
    );

    expect(decision.status).toBe("needs_human_review");
    expect(decision.reasons.map((reason) => reason.code)).toContain("regular_hybrid_or_onsite");
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

  test("rejects management, analysis, governance, and creative titles that mention AI or data", () => {
    const titles = [
      "PMO Manager",
      "AI Delivery Manager",
      "Agentic AI Product Manager",
      "Agentic AI Product Manage",
      "Project Manager (AI & Data Transformation)",
      "IT Business Analyst (Governance/Data/BI)",
      "Senior AI VFX Artist",
      "Privacy & Responsible AI Manager",
      "Responsible AI Governance Specialist",
    ];

    for (const title of titles) {
      const decision = screen("Enterprise AI programme contract.", title);
      expect(decision.reasons.map((reason) => reason.code)).toContain("not_target_role");
    }
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
