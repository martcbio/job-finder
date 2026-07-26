import type { CvStageResult } from "../src/cv/stageApplicationCv";

const applicationId = process.argv.slice(2).find((argument) => argument !== "--");

if (!applicationId || !/^[1-9]\d*$/.test(applicationId)) {
  console.error("Usage: bun run cv:stage -- <applicationId>");
  process.exit(1);
}

try {
  const apiBase = (process.env.JOB_FINDER_API_URL ?? "http://127.0.0.1:3737/api").replace(
    /\/$/,
    "",
  );
  const response = await fetch(`${apiBase}/applications/${applicationId}/stage-cv`, {
    method: "POST",
  });
  const body = (await response.json()) as
    | { ok: true; data: CvStageResult }
    | { ok: false; error: { code: string; message: string; details?: unknown } };
  if (!response.ok || !body.ok) {
    const message = body.ok
      ? `CV staging returned HTTP ${response.status}`
      : `${body.error.code}: ${body.error.message}`;
    throw new Error(message);
  }
  const result = body.data;
  console.log(`Staged application ${applicationId} into resume4: ${result.cvRef}`);
  console.log(`Application directory: ${result.applicationDir}`);
  console.log(
    result.description.available
      ? `Job source: ${result.description.source} (capture mode ${result.capture.mode})`
      : `Job source: unavailable; captured title + company only (capture mode ${result.capture.mode})`,
  );
  console.log(result.prepared ? "Prepared: classification and retrieval written" : "Prepared: no");
  console.log("");
  console.log("No CV was produced. resume4 is human-gated; next steps:");
  for (const step of result.nextSteps) console.log(`  - ${step}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
}
