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
    cv_ref: "pipeline/apply/app-42-acme-agentic-ai-engineer",
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
        caseRef: application.cv_ref,
        caseDir: "/resume3/pipeline/apply/app-42-acme-agentic-ai-engineer",
        sourcePath: "/resume3/pipeline/apply/app-42-acme-agentic-ai-engineer/outputs/source.md",
        htmlPaths: ["/resume3/pipeline/apply/app-42-acme-agentic-ai-engineer/outputs/html/cv.html"],
        pdfPaths: ["/resume3/pipeline/apply/app-42-acme-agentic-ai-engineer/outputs/pdf/cv.pdf"],
        renderStatus: "dummy_rendered",
        identity: "dummy",
        description: { available: true, source: "lab_opening_raw" },
        fragments: { available: 12, selected: 7 },
      };
    },
  });

  const response = await handler(
    new Request("http://localhost/api/applications/42/stage-cv", { method: "POST" }),
  );
  const body = (await response.json()) as {
    ok: boolean;
    data: { renderStatus: string; caseRef: string };
  };

  expect(response.status).toBe(200);
  expect(called).toEqual(["42"]);
  expect(body).toMatchObject({
    ok: true,
    data: {
      renderStatus: "dummy_rendered",
      caseRef: "pipeline/apply/app-42-acme-agentic-ai-engineer",
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
