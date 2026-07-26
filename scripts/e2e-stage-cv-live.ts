import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parseCvRef } from "../src/cv/stageApplicationCv";

const apiBase = (process.env.JOB_FINDER_API_URL ?? "http://127.0.0.1:3737/api").replace(
  /\/$/,
  "",
);
const repoRoot = path.resolve(import.meta.dir, "..");

interface ApplicationRow {
  id: string;
  status: string;
  cv_ref: string | null;
}

async function api<T>(endpoint: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${apiBase}${endpoint}`, init);
  const body = (await response.json()) as
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } };
  if (!response.ok || !body.ok) {
    throw new Error(
      body.ok ? `HTTP ${response.status}` : `${body.error.code}: ${body.error.message}`,
    );
  }
  return body.data;
}

async function post<T>(endpoint: string, payload: Record<string, unknown>): Promise<T> {
  return api<T>(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
}

let applicationId: string | null = null;
let completed = false;

try {
  const jobs = await api<
    Array<{
      id: string;
      title: string;
      company_hint: string | null;
      canonical_url: string;
      description_sample: string | null;
    }>
  >("/jobs?limit=250");
  const job =
    jobs.find(
      (row) =>
        (row.description_sample?.length ?? 0) > 200 && /\b(ai|agent|llm|rag)\b/i.test(row.title),
    ) ?? jobs.find((row) => (row.description_sample?.length ?? 0) > 200);
  if (!job) throw new Error("No local job with a stored description is available for the e2e test.");

  const created = await post<{
    status: "available";
    data: { application: ApplicationRow; created: boolean };
  }>("/applications", {
    org: `phase-3-e2e-${Date.now()}`,
    ats: "manual",
    external_id: `local-${job.id}`,
    source: "manual",
    title: job.title,
    company: job.company_hint ?? "Phase 3 e2e company",
    url: job.canonical_url,
    notes: "e2e test: phase-3 CV bridge",
  });
  applicationId = created.data.application.id;
  await post(`/applications/${applicationId}/transition`, {
    to: "shortlisted",
    by: "agent",
    note: "e2e test: shortlist for CV staging",
  });

  const stageProcess = Bun.spawn(["bun", "run", "cv:stage", "--", applicationId], {
    cwd: repoRoot,
    env: { ...process.env, JOB_FINDER_API_URL: apiBase },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stageStdout, stageStderr] = await Promise.all([
    stageProcess.exited,
    new Response(stageProcess.stdout).text(),
    new Response(stageProcess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `cv:stage failed with exit ${exitCode}\nstdout:\n${stageStdout}\nstderr:\n${stageStderr}`,
    );
  }

  const applications = await api<{ status: "available"; data: ApplicationRow[] }>(
    "/applications",
  );
  const staged = applications.data.find((application) => application.id === applicationId);
  if (!staged?.cv_ref || staged.status !== "cv_staged") {
    throw new Error(`Application ${applicationId} did not reach cv_staged with a cv_ref.`);
  }
  const parsed = parseCvRef(staged.cv_ref);
  if (parsed.kind !== "resume4-staged") {
    throw new Error(`Expected a resume4-staged cv_ref; got ${staged.cv_ref}`);
  }
  const applicationDir = parsed.absolutePath;
  // The bridge only stages. Verify preparation ran; never expect a rendered CV,
  // and never read working.md, facts, council output, or any sealed artifact.
  const preparedFiles = ["job.md", "classification.yaml", "retrieval.md", "compose-packet.md"];
  for (const name of preparedFiles) {
    const artifactPath = path.join(applicationDir, name);
    if ((await stat(artifactPath)).size === 0) throw new Error(`Empty artifact: ${artifactPath}`);
  }
  const jobSnapshot = await readFile(path.join(applicationDir, "job.md"), "utf8");
  if (!jobSnapshot.trim()) throw new Error(`Empty job snapshot in ${applicationDir}`);

  await post(`/applications/${applicationId}/transition`, {
    to: "closed",
    by: "agent",
    note: "e2e test: phase-3 CV staging verified",
  });
  completed = true;
  console.log(
    JSON.stringify(
      {
        e2e: "resume4-cv-stage",
        applicationId,
        finalStatus: "closed",
        localJobId: job.id,
        cvRef: staged.cv_ref,
        cvRefKind: parsed.kind,
        applicationDir,
        preparedFiles,
        renderedCv: "none (resume4 is human-gated)",
        stageOutput: stageStdout.trim().split(/\r?\n/),
      },
      null,
      2,
    ),
  );
} finally {
  if (applicationId && !completed) {
    try {
      await post(`/applications/${applicationId}/transition`, {
        to: "closed",
        by: "agent",
        note: "e2e test: cleanup after failed phase-3 CV staging",
      });
    } catch (cleanupError) {
      console.error("E2E cleanup failed", cleanupError);
    }
  }
}
