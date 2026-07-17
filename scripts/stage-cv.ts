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
  console.log(`Staged application ${applicationId}: ${result.caseRef}`);
  console.log(
    result.description.available
      ? `Description: ${result.description.source}`
      : "Description: unavailable; selected against title + company only",
  );
  console.log(
    `Fragments: ${result.fragments.selected}/${result.fragments.available} mechanically selected`,
  );
  console.log(`Source: ${result.sourcePath}`);
  for (const htmlPath of result.htmlPaths) console.log(`Dummy HTML: ${htmlPath}`);
  for (const pdfPath of result.pdfPaths) console.log(`Dummy PDF: ${pdfPath}`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : error);
  process.exit(1);
}
