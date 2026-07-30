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

const jobsradarRoot = resolve(requestedRoot);
if (!jobsradarRoot.startsWith("/Users/mcb/Claudelocal/careers/")) {
  throw new Error(`Refusing non-canonical jobsradar root: ${jobsradarRoot}`);
}
if (jobsradarRoot.includes("&") || jobsradarRoot.includes("<") || jobsradarRoot.includes(">")) {
  throw new Error(`Jobsradar root cannot be represented safely in XML: ${jobsradarRoot}`);
}

const template = await Bun.file(templatePath).text();
if (!template.includes("__JOBSRADAR_ROOT__")) {
  throw new Error(`Launchd template has no __JOBSRADAR_ROOT__ token: ${templatePath}`);
}
function executableToken(token: string, requested: string | undefined): string {
  if (!template.includes(token)) return "";
  if (!requested) throw new Error(`Launchd template requires ${token}`);
  const executable = resolve(requested);
  if (!executable.startsWith("/") || /[&<>]/.test(executable)) {
    throw new Error(`Executable cannot be represented safely for ${token}: ${executable}`);
  }
  return executable;
}

const replacements = new Map([
  ["__JOBSRADAR_ROOT__", jobsradarRoot],
  ["__CODEX_EXECUTABLE__", executableToken("__CODEX_EXECUTABLE__", requestedCodexExecutable)],
  ["__GIT_EXECUTABLE__", executableToken("__GIT_EXECUTABLE__", requestedGitExecutable)],
  ["__BUN_EXECUTABLE__", executableToken("__BUN_EXECUTABLE__", requestedBunExecutable)],
]);
let rendered = template;
for (const [token, value] of replacements) {
  if (rendered.includes(token)) rendered = rendered.replaceAll(token, value);
}
await mkdir(dirname(destinationPath), { recursive: true });
await Bun.write(destinationPath, rendered);
