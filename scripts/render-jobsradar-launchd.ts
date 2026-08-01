import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [
  templatePath,
  destinationPath,
  requestedRoot,
  requestedCodexExecutable,
  requestedGitExecutable,
  requestedBunExecutable,
] = process.argv.slice(2);
if (!templatePath || !destinationPath || !requestedRoot) {
  throw new Error(
    "Usage: bun scripts/render-jobsradar-launchd.ts <template> <destination> <jobsradar-root> [codex-executable] [git-executable] [bun-executable]",
  );
}

function xmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const jobsradarRoot = resolve(requestedRoot);
const jobsradarHome = process.env.HOME;
if (!jobsradarHome) {
  throw new Error("HOME is required to render a launchd template");
}

const resolvedTemplatePath = resolve(templatePath);
const resolvedDestinationPath = resolve(destinationPath);
const template = await Bun.file(resolvedTemplatePath).text();
if (!template.includes("__JOBSRADAR_ROOT__")) {
  throw new Error(`Launchd template has no __JOBSRADAR_ROOT__ token: ${resolvedTemplatePath}`);
}
function executableToken(token: string, requested: string | undefined): string {
  if (!template.includes(token)) return "";
  if (!requested) throw new Error(`Launchd template requires ${token}`);
  const executable = resolve(requested);
  return executable;
}

const replacements = new Map([
  ["__JOBSRADAR_ROOT__", xmlText(jobsradarRoot)],
  ["__JOBSRADAR_HOME__", xmlText(resolve(jobsradarHome))],
  ["__CODEX_EXECUTABLE__", xmlText(executableToken("__CODEX_EXECUTABLE__", requestedCodexExecutable))],
  ["__GIT_EXECUTABLE__", xmlText(executableToken("__GIT_EXECUTABLE__", requestedGitExecutable))],
  ["__BUN_EXECUTABLE__", xmlText(executableToken("__BUN_EXECUTABLE__", requestedBunExecutable))],
]);
let rendered = template;
for (const [token, value] of replacements) {
  if (rendered.includes(token)) rendered = rendered.replaceAll(token, value);
}
const unresolvedToken = rendered.match(/__[A-Z0-9_]+__/);
if (unresolvedToken) {
  throw new Error(`Launchd template has an unresolved token: ${unresolvedToken[0]}`);
}

await mkdir(dirname(resolvedDestinationPath), { recursive: true });
await Bun.write(resolvedDestinationPath, rendered);
