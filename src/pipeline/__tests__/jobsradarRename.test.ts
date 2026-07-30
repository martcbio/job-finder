import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

const operationalFiles = [
  "package.json",
  "cloud/modal_app.py",
  "src/pipeline/labOpenings.ts",
  "scripts/lab-openings-scheduled.sh",
  "scripts/opps",
  "scripts/render-jobsradar-launchd.ts",
  "launchd/com.mcb.jobsradar.fast-refresh.plist.template",
  "scripts/com.mcb.jobsradar-api.plist.template",
  "prototypes/ui/scripts/com.mcb.jobsradar-ui.plist.template",
];

describe("jobsradar rename contract", () => {
  test("keeps operational configuration independent of the retired checkout name", async () => {
    for (const relativePath of operationalFiles) {
      const file = Bun.file(join(root, relativePath));
      expect(await file.exists(), relativePath).toBe(true);
      const content = await file.text();
      expect(content, relativePath).not.toContain("job-finder-cursor-party");
      expect(content, relativePath).not.toContain(
        "/Users/mcb/Claudelocal/careers/resume2/projects/job-finder",
      );
      expect(content, relativePath).not.toContain("com.mcb.job-finder");
    }
  });

  test("retires the old launchd source filenames", async () => {
    for (const relativePath of [
      "launchd/com.mcb.job-finder.fast-refresh.plist",
      "scripts/com.mcb.job-finder-api.plist",
      "prototypes/ui/scripts/com.mcb.job-finder-ui.plist",
    ]) {
      expect(await Bun.file(join(root, relativePath)).exists(), relativePath).toBe(false);
    }
  });

  test("keeps retired launchd labels only in the explicit cutover installer", async () => {
    const installer = await Bun.file(join(root, "scripts/install-jobsradar-launchd.sh")).text();
    expect(installer).not.toContain("job-finder-cursor-party");
    expect(installer).toContain("com.mcb.job-finder-api");
    expect(installer).toContain("com.mcb.job-finder-ui");
    expect(installer).toContain("com.mcb.job-finder.fast-refresh");
  });

  test("renders launchd templates from the post-move checkout root", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "jobsradar-launchd-test-"));
    const destination = join(temporaryDirectory, "api.plist");
    try {
      const child = Bun.spawn(
        [
          "bun",
          "scripts/render-jobsradar-launchd.ts",
          "scripts/com.mcb.jobsradar-api.plist.template",
          destination,
          "/Users/mcb/Claudelocal/careers/jobsradar",
        ],
        { cwd: root, stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ]);
      expect(stderr).toBe("");
      expect(exitCode).toBe(0);
      const rendered = await readFile(destination, "utf8");
      expect(rendered).toContain("<string>/Users/mcb/Claudelocal/careers/jobsradar</string>");
      expect(rendered).not.toContain("__JOBSRADAR_ROOT__");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
