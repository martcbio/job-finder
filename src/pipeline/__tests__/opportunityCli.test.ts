import { expect, test } from "bun:test";

test("opportunity CLI exposes refresh safety and machine-readable output", async () => {
  const child = Bun.spawn(["bun", "scripts/list-latest-opportunities.ts", "--help"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(stdout).toContain("--refresh-cloud-labs");
  expect(stdout).toContain("--refresh-labs");
  expect(stdout).toContain("--refresh-direct");
  expect(stdout).toContain("--refresh-signals");
  expect(stdout).toContain("--refresh-jobserve");
  expect(stdout).toContain("--strict-source-health");
  expect(stdout).toContain("--format markdown|json");
  expect(stdout).toContain("--email");
  expect(stdout).toContain("20–30");
  expect(stdout).toContain("--quiet");
  expect(stdout).toContain("JobServe is never contacted unless");
});
