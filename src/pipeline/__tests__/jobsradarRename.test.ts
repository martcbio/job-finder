import { describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..");

const operationalFiles = [
  "package.json",
  "cloud/modal_app.py",
  "src/pipeline/labOpenings.ts",
  "scripts/lab-openings-scheduled.sh",
  "scripts/opps",
  "scripts/jobsradar",
  "scripts/scheduled-fast-refresh.sh",
  "scripts/lib/jobsradar-runtime.sh",
  "scripts/render-jobsradar-launchd.ts",
  "launchd/com.mcb.jobsradar.doctor.plist.template",
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

  test("renders every launchd template from an arbitrary checkout root", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "jobsradar-launchd-test-"));
    const relocatedRoot = join(temporaryDirectory, "relocated jobsradar");
    const templates: ReadonlyArray<readonly [template: string, filename: string]> = [
      ["scripts/com.mcb.jobsradar-api.plist.template", "api.plist"],
      ["prototypes/ui/scripts/com.mcb.jobsradar-ui.plist.template", "ui.plist"],
      ["launchd/com.mcb.jobsradar.fast-refresh.plist.template", "fast-refresh.plist"],
      ["launchd/com.mcb.jobsradar.doctor.plist.template", "doctor.plist"],
    ];
    try {
      for (const [template, filename] of templates) {
        const destination = join(temporaryDirectory, filename);
        const child = Bun.spawn(
          [
            "bun",
            "scripts/render-jobsradar-launchd.ts",
            template,
            destination,
            relocatedRoot,
            process.execPath,
            process.execPath,
            process.execPath,
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
        expect(rendered).toContain(relocatedRoot);
        expect(rendered).toContain("<key>NO_PROXY</key>");
        expect(rendered).toContain("<key>no_proxy</key>");
        expect(rendered).toContain("127.0.0.1,localhost,::1");
        expect(rendered).not.toMatch(/__[A-Z0-9_]+__/);

        const plist = Bun.spawn(["plutil", "-lint", destination], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const [plistExitCode, plistStderr] = await Promise.all([
          plist.exited,
          new Response(plist.stderr).text(),
        ]);
        expect(plistStderr).toBe("");
        expect(plistExitCode).toBe(0);
      }

      const api = await readFile(join(temporaryDirectory, "api.plist"), "utf8");
      expect(api).not.toContain(`"$1" run db:migrate`);
      expect(api).toContain(`exec "$1" run api`);
      expect(api).toContain("jobsradar_configure_database_url");
      expect(api).toContain(`<string>${process.execPath}</string>`);

      const fastRefresh = await readFile(join(temporaryDirectory, "fast-refresh.plist"), "utf8");
      expect(fastRefresh).toContain("<string>/bin/bash</string>");
      expect(fastRefresh).not.toContain("/bin/zsh");
      expect(fastRefresh).not.toContain("-lc");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test("installer accepts --yes while keeping confirmation as the default", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "jobsradar-installer-test-"));
    const home = join(temporaryDirectory, "home");
    const bin = join(temporaryDirectory, "bin");
    const bunCalls = join(temporaryDirectory, "bun-calls");
    await Promise.all([mkdir(home), mkdir(bin)]);
    const fakeBun = join(bin, "bun");
    const fakeLaunchctl = join(bin, "launchctl");
    await Promise.all([
      writeFile(fakeBun, `#!/bin/sh\nprintf 'render\\n' >> "${bunCalls}"\n`),
      writeFile(fakeLaunchctl, "#!/bin/sh\nexit 0\n"),
    ]);
    await Promise.all([chmod(fakeBun, 0o755), chmod(fakeLaunchctl, 0o755)]);
    const environment = {
      ...process.env,
      HOME: home,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
    };

    try {
      const noninteractive = Bun.spawn(
        ["bash", "scripts/install-jobsradar-launchd.sh", "--yes", "api"],
        { cwd: root, env: environment, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      );
      const [noninteractiveExit, noninteractiveStdout, noninteractiveStderr] = await Promise.all([
        noninteractive.exited,
        new Response(noninteractive.stdout).text(),
        new Response(noninteractive.stderr).text(),
      ]);
      expect(noninteractiveExit).toBe(0);
      expect(noninteractiveStderr).toBe("");
      expect(noninteractiveStdout).toContain("installed jobsradar API");
      expect(await readFile(bunCalls, "utf8")).toBe("render\n");

      const interactive = Bun.spawn(
        ["bash", "-c", "printf 'no\\n' | bash scripts/install-jobsradar-launchd.sh api"],
        { cwd: root, env: environment, stdout: "pipe", stderr: "pipe" },
      );
      const [interactiveExit, interactiveStderr] = await Promise.all([
        interactive.exited,
        new Response(interactive.stderr).text(),
      ]);
      expect(interactiveExit).toBe(1);
      expect(interactiveStderr).toContain("aborted");
      expect(await readFile(bunCalls, "utf8")).toBe("render\n");
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });
});
