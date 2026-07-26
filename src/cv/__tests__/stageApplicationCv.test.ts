import { describe, expect, test } from "bun:test";
import {
  buildCaptureSpec,
  buildJobMarkdown,
  buildPrepareSpec,
  type CvJobSource,
  chooseCaptureMode,
  cvRefKind,
  finalizeApplicationCvStage,
  findExistingStage,
  type ProcessOutput,
  parseCapturedApplicationDir,
  parseCvRef,
  RESUME4_CV_REF_PREFIX,
  type Resume4ProcessSpec,
  type StageApplication,
  stageApplicationCv,
} from "../stageApplicationCv";

const RESUME4_ROOT = "/resume4";

const noStage = { exists: () => false, list: () => [] as string[] };

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

const jobSource: CvJobSource = {
  title: "Agentic AI Engineer",
  company: "Acme",
  description: "Build agentic AI systems with evals, retries, and human review.",
  descriptionSource: "local_job_page",
};

function recordingRunner(): {
  specs: Resume4ProcessSpec[];
  run: (spec: Resume4ProcessSpec) => Promise<ProcessOutput>;
} {
  const specs: Resume4ProcessSpec[] = [];
  return {
    specs,
    run: async (spec) => {
      specs.push(spec);
      return {
        stdout:
          spec.label === "capture"
            ? `> resume\n${RESUME4_ROOT}/applications/greenhouse/123-agentic-ai-engineer\n`
            : "",
      };
    },
  };
}

describe("cv_ref generations", () => {
  test("resume4 refs carry the prefix and resolve under resume4", () => {
    const parsed = parseCvRef(`${RESUME4_CV_REF_PREFIX}applications/jobserve/abc-role`, {
      resume4Root: RESUME4_ROOT,
    });
    expect(parsed.kind).toBe("resume4-staged");
    expect(parsed.relativePath).toBe("applications/jobserve/abc-role");
    expect(parsed.absolutePath).toBe("/resume4/applications/jobserve/abc-role");
  });

  test("legacy resume3 refs stay readable against the resume3 root", () => {
    const parsed = parseCvRef("pipeline/apply/app-42-acme-agentic-ai-engineer", {
      resume3Root: "/resume3",
    });
    expect(parsed.kind).toBe("resume3-legacy");
    expect(parsed.absolutePath).toBe("/resume3/pipeline/apply/app-42-acme-agentic-ai-engineer");
    expect(cvRefKind("pipeline/apply/x")).toBe("resume3-legacy");
    expect(cvRefKind(null)).toBeNull();
  });
});

describe("resume4 capture contract", () => {
  test("stored postings go in on stdin and never via --job-file", () => {
    const spec = buildCaptureSpec(application, jobSource, "job_markdown_stdin", RESUME4_ROOT, {
      PATH: "/usr/bin",
      RESUME_IDENTITY_JSON: "must-not-be-forwarded",
    });
    expect(spec.argv).toEqual([
      "npm",
      "run",
      "resume",
      "--",
      "new",
      "--site",
      "greenhouse",
      "--job-id",
      "123",
      "--role",
      "Agentic AI Engineer",
    ]);
    expect(spec.argv).not.toContain("--job-file");
    expect(spec.stdin).toContain("# Agentic AI Engineer");
    expect(spec.stdin).toContain("Build agentic AI systems");
    expect(spec.env.RESUME_IDENTITY_JSON).toBeUndefined();
    expect(spec.env.AGENT_MODE).toBe("1");
  });

  test("stdin is the default; URL capture only on an explicit override", () => {
    const bare: CvJobSource = {
      ...jobSource,
      description: null,
      descriptionSource: "application_only",
    };
    expect(chooseCaptureMode(application, bare)).toBe("job_markdown_stdin");
    expect(chooseCaptureMode(application, jobSource)).toBe("job_markdown_stdin");
    const spec = buildCaptureSpec(application, bare, "job_url", RESUME4_ROOT, {});
    expect(spec.argv).toEqual([
      "npm",
      "run",
      "resume",
      "--",
      "new",
      "--url",
      "https://example.com/jobs/123",
    ]);
    expect(spec.stdin).toBeNull();
  });

  test("prepare runs against the repository-relative application path", () => {
    const spec = buildPrepareSpec("applications/greenhouse/123-role", RESUME4_ROOT, {});
    expect(spec.argv).toEqual([
      "npm",
      "run",
      "resume",
      "--",
      "prepare",
      "applications/greenhouse/123-role",
    ]);
  });

  test("the staged markdown carries no instructions to the model", () => {
    const markdown = buildJobMarkdown(application, jobSource);
    expect(markdown.startsWith("# Agentic AI Engineer")).toBe(true);
    expect(markdown).toContain("Company: Acme");
    expect(markdown).toContain("staged from job-finder application 42");
  });

  test("the printed application directory is parsed out of npm noise", () => {
    expect(
      parseCapturedApplicationDir(
        "> jobfinder@ resume\n> node tools/resume.mjs\n/resume4/applications/jobserve/abc-role\n",
        RESUME4_ROOT,
      ),
    ).toBe("/resume4/applications/jobserve/abc-role");
    expect(() => parseCapturedApplicationDir("nothing useful", RESUME4_ROOT)).toThrow(
      /did not print an application directory/,
    );
  });
});

describe("staging pipeline", () => {
  test("captures, prepares, stores a resume4 cv_ref, and stops at the human gate", async () => {
    const runner = recordingRunner();
    const calls: string[] = [];
    const result = await stageApplicationCv(
      application,
      {
        resolveJobSource: async () => jobSource,
        patchCvRef: async (id, ref) => {
          calls.push(`patch:${id}:${ref}`);
          return { ...application, cv_ref: ref };
        },
        transitionToCvStaged: async (id) => {
          calls.push(`transition:${id}:cv_staged:agent`);
          return { ...application, status: "cv_staged" };
        },
        runProcess: runner.run,
      },
      { resume4Root: RESUME4_ROOT, processEnv: {}, fs: noStage },
    );

    expect(runner.specs.map((spec) => spec.label)).toEqual(["capture", "prepare"]);
    expect(result.cvRef).toBe(
      `${RESUME4_CV_REF_PREFIX}applications/greenhouse/123-agentic-ai-engineer`,
    );
    expect(result.cvRefKind).toBe("resume4-staged");
    expect(result.applicationPath).toBe("applications/greenhouse/123-agentic-ai-engineer");
    expect(result.humanGate).toBe("compose_and_facts");
    expect(result.nextSteps.length).toBeGreaterThan(0);
    expect(calls).toEqual([
      `patch:42:${RESUME4_CV_REF_PREFIX}applications/greenhouse/123-agentic-ai-engineer`,
      "transition:42:cv_staged:agent",
    ]);
    expect(result).not.toHaveProperty("pdfPaths");
  });

  test("refuses to re-stage over an existing resume4 application directory", async () => {
    const runner = recordingRunner();
    await expect(
      stageApplicationCv(
        application,
        {
          resolveJobSource: async () => jobSource,
          patchCvRef: async () => application,
          transitionToCvStaged: async () => application,
          runProcess: runner.run,
        },
        {
          resume4Root: RESUME4_ROOT,
          processEnv: {},
          fs: { exists: () => true, list: () => ["123-agentic-ai-engineer"] },
        },
      ),
    ).rejects.toThrow(/already staged into resume4/);
    expect(runner.specs).toHaveLength(0);
  });

  test("refuses to re-stage when cv_ref already points at resume4", async () => {
    const runner = recordingRunner();
    await expect(
      stageApplicationCv(
        { ...application, cv_ref: `${RESUME4_CV_REF_PREFIX}applications/greenhouse/123-role` },
        {
          resolveJobSource: async () => jobSource,
          patchCvRef: async () => application,
          transitionToCvStaged: async () => application,
          runProcess: runner.run,
        },
        { resume4Root: RESUME4_ROOT, processEnv: {}, fs: noStage },
      ),
    ).rejects.toThrow(/already staged into resume4/);
    expect(runner.specs).toHaveLength(0);
  });

  test("legacy resume3 cv_ref rows are not treated as already staged", () => {
    expect(
      findExistingStage(
        { ...application, cv_ref: "pipeline/apply/app-42-acme" },
        RESUME4_ROOT,
        noStage,
      ),
    ).toBeNull();
  });

  test("refuses to stage an application that is not shortlisted", async () => {
    const runner = recordingRunner();
    await expect(
      stageApplicationCv(
        { ...application, status: "interested" },
        {
          resolveJobSource: async () => jobSource,
          patchCvRef: async () => application,
          transitionToCvStaged: async () => application,
          runProcess: runner.run,
        },
        { resume4Root: RESUME4_ROOT, processEnv: {}, fs: noStage },
      ),
    ).rejects.toThrow(/must be shortlisted/);
    expect(runner.specs).toHaveLength(0);
  });

  test("patches cv_ref before transitioning to cv_staged", async () => {
    const calls: string[] = [];
    const staged = { ...application, status: "cv_staged", cv_ref: "resume4:applications/x/y" };
    const result = await finalizeApplicationCvStage(application.id, "resume4:applications/x/y", {
      patchCvRef: async (id, ref) => {
        calls.push(`patch:${id}:${ref}`);
        return { ...application, cv_ref: ref };
      },
      transitionToCvStaged: async (id) => {
        calls.push(`transition:${id}:cv_staged:agent`);
        return staged;
      },
    });
    expect(calls).toEqual(["patch:42:resume4:applications/x/y", "transition:42:cv_staged:agent"]);
    expect(result).toEqual(staged);
  });
});
