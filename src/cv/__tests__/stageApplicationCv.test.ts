import { describe, expect, test } from "bun:test";
import {
  buildComposition,
  buildResume3ProcessSpecs,
  finalizeApplicationCvStage,
  parseResumeFragments,
  type StageApplication,
  selectResumeFragments,
} from "../stageApplicationCv";

const application: StageApplication = {
  id: "42",
  org: "acme",
  ats: "greenhouse",
  external_id: "123",
  source: "lab-openings",
  title: "Agentic AI Engineer",
  company: "Acme",
  url: "https://example.com/jobs/123",
  status: "shortlisted",
  status_history: [],
  cv_ref: null,
  notes: null,
  created_at: "2026-07-17T10:00:00Z",
  updated_at: "2026-07-17T10:00:00Z",
};

describe("mechanical CV fragment selection", () => {
  test("ranks agentic evidence above unrelated evidence", () => {
    const fragments = parseResumeFragments(`
## Agentic systems
- Built agentic tool orchestration with evals and human review.
- Shipped multi-agent workflows with durable state and retries.

## Finance operations
- Reconciled quarterly invoices and supplier purchase orders.
`);
    const selected = selectResumeFragments(
      fragments,
      "Build agentic AI agents, tool orchestration, evals, retries, and human review.",
      3,
    );

    expect(selected).toHaveLength(2);
    expect(selected[0]?.text).toContain("agentic tool orchestration");
    expect(selected[0]?.score).toBeGreaterThan(selected[1]?.score ?? 0);
    expect(selected.some((fragment) => fragment.text.includes("invoices"))).toBe(false);
  });
});

describe("resume3 case contract", () => {
  test("generates the existing composition.json shape", () => {
    const composition = buildComposition(application, "app-42-acme-agentic-ai-engineer");
    expect(composition).toMatchObject({
      job_id: "app-42",
      job_slug: "app-42-acme-agentic-ai-engineer",
      profile_label: "Agentic AI Engineer",
      sync_from: { resume_root: "../../../resume" },
      recipe: {
        experience_order: ["recent", "historical"],
        historical_include: [],
      },
      layers: {
        historical: "inputs/historical",
        adaptive: "inputs/recent.md",
        education_languages: "inputs/education-languages.md",
      },
      output: { source: "outputs/source.md" },
      render: {
        html_dir: "outputs/html",
        pdf_dir: "outputs/pdf",
        catalog: "preferred",
      },
    });
  });

  test("sets AGENT_MODE and dummy identity on every resume3 subprocess", () => {
    const specs = buildResume3ProcessSpecs("/cases/app-42", "/resume3", {
      PATH: "/usr/bin",
      RESUME_IDENTITY_JSON: "must-not-be-forwarded",
    });
    for (const spec of [specs.sync, specs.compose]) {
      expect(spec.env.AGENT_MODE).toBe("1");
      expect(spec.env.RESUME_IDENTITY_JSON).toBeUndefined();
      expect(spec.argv).toContain("--identity=dummy");
    }
    expect(specs.compose.argv).toContain("--render");
  });

  test("patches cv_ref before transitioning to cv_staged as wired by the adapter", async () => {
    const calls: string[] = [];
    const staged = { ...application, status: "cv_staged", cv_ref: "pipeline/apply/app-42" };
    const result = await finalizeApplicationCvStage(application.id, "pipeline/apply/app-42", {
      patchCvRef: async (id, cvRef) => {
        calls.push(`patch:${id}:${cvRef}`);
        return { ...application, cv_ref: cvRef };
      },
      transitionToCvStaged: async (id) => {
        calls.push(`transition:${id}:cv_staged:agent`);
        return staged;
      },
    });

    expect(calls).toEqual(["patch:42:pipeline/apply/app-42", "transition:42:cv_staged:agent"]);
    expect(result).toEqual(staged);
  });
});
