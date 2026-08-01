import { expect, test } from "bun:test";
import { executeFastRefreshCli } from "../../../scripts/fast-refresh";

test("fast-refresh help omits the retired direct limit option", async () => {
  const child = Bun.spawn(["bun", "scripts/fast-refresh.ts", "--help"], {
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
  expect(stdout).not.toContain("--direct-limit");
  expect(stdout).toContain("--source, --source-id");
  expect(stdout).toContain(
    '-q "AI engineer" -q "agentic AI" -q "LLM engineer" --jobserve-max-pages 2',
  );
  expect(stdout).toContain("Defaults to AI engineer, agentic AI, LLM engineer.");
  expect(stdout).toContain("Defaults to 2.");
  expect(stdout).toContain("Defaults to 5.");
});

test("fast-refresh rejects the retired direct limit option", async () => {
  const child = Bun.spawn(["bun", "scripts/fast-refresh.ts", "--direct-limit", "6"], {
    cwd: process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  expect(exitCode).toBe(1);
  expect(stdout).toBe("");
  expect(stderr).toContain("Unknown argument: --direct-limit");
});

test("fast-refresh closes PSQL clients when refresh fails", async () => {
  const events: string[] = [];

  await expect(
    executeFastRefreshCli([], {
      runFastRefresh: async () => {
        events.push("run");
        throw new Error("simulated refresh failure");
      },
      closePsqlClients: async () => {
        events.push("close");
      },
    }),
  ).rejects.toThrow("simulated refresh failure");

  expect(events).toEqual(["run", "close"]);
});
