import { expect, test } from "bun:test";
import { buildApplicationJobSourceSql } from "../applicationCvStage";
import { createJobFinderApiHandler } from "../server";

test("POST /api/applications/:id/stage-cv invokes the shared stage runner", async () => {
  const application = {
    id: "42",
    org: "acme",
    ats: "greenhouse",
    external_id: "123",
    source: "lab-openings" as const,
    title: "Agentic AI Engineer",
    company: "Acme",
    url: "https://example.com/jobs/123",
    status: "cv_staged",
    status_history: [],
    cv_ref: "resume4:applications/greenhouse/123-agentic-ai-engineer",
    notes: null,
    created_at: null,
    updated_at: null,
  };
  const called: string[] = [];
  const handler = createJobFinderApiHandler({
    stageCv: async (_context, id) => {
      called.push(id);
      return {
        application,
        cvRef: application.cv_ref,
        cvRefKind: "resume4-staged",
        applicationPath: "applications/greenhouse/123-agentic-ai-engineer",
        applicationDir: "/resume4/applications/greenhouse/123-agentic-ai-engineer",
        resume4Root: "/resume4",
        capture: {
          mode: "job_markdown_stdin",
          site: "greenhouse",
          jobId: "123",
          role: "Agentic AI Engineer",
          url: null,
        },
        prepared: true,
        description: { available: true, source: "lab_opening_raw" },
        humanGate: "compose_and_facts",
        nextSteps: ["Human: compose in resume4"],
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/applications/42/stage-cv", { method: "POST" }),
  );
  const body = (await response.json()) as {
    ok: boolean;
    data: { cvRefKind: string; cvRef: string; humanGate: string };
  };

  expect(response.status).toBe(200);
  expect(called).toEqual(["42"]);
  expect(body).toMatchObject({
    ok: true,
    data: {
      cvRefKind: "resume4-staged",
      cvRef: "resume4:applications/greenhouse/123-agentic-ai-engineer",
      humanGate: "compose_and_facts",
    },
  });
});

test("builds valid SQL for a manual application with no provenance", () => {
  const sql = buildApplicationJobSourceSql({
    org: null,
    ats: null,
    external_id: null,
    url: null,
  } as never);
  expect(sql).toBe("SELECT 'null'::text;");
  expect(sql).not.toContain("CASE  ELSE");
});
