import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const [templatePath, destinationPath, requestedRoot] = process.argv.slice(2);
if (!templatePath || !destinationPath || !requestedRoot) {
  throw new Error(
    "Usage: bun scripts/render-jobsradar-launchd.ts <template> <destination> <jobsradar-root>",
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
const rendered = template.replaceAll("__JOBSRADAR_ROOT__", jobsradarRoot);
await mkdir(dirname(destinationPath), { recursive: true });
await Bun.write(destinationPath, rendered);
