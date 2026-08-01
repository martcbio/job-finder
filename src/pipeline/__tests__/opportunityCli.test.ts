import { expect, test } from "bun:test";
import {
  buildRefreshCommands,
  deadUrlReviewEventNote,
  groupDeadUrlsForStaling,
  runRefreshCommands,
} from "../../../scripts/list-latest-opportunities";

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

test("opportunity refresh uses raw ingest without the fast-refresh direct cap", () => {
  const commands = buildRefreshCommands({
    refreshCloudLabs: false,
    refreshLabs: false,
    refreshDirect: true,
    refreshSignals: false,
    refreshJobServe: true,
  });

  expect(commands).toEqual([
    [
      "bun",
      "scripts/jobsradar.ts",
      "ingest",
      "--source",
      "linear-careers",
      "--source",
      "google-careers",
    ],
    ["bun", "scripts/jobsradar.ts", "ingest", "--source", "jobserve"],
  ]);
});

test("cloud refresh failure does not fall back to the native scanner", async () => {
  const calls: string[][] = [];
  await expect(
    runRefreshCommands(
      {
        refreshCloudLabs: true,
        refreshLabs: true,
        refreshDirect: false,
        refreshSignals: false,
        refreshJobServe: false,
      },
      async (command) => {
        calls.push(command);
        throw new Error("cloud unavailable");
      },
    ),
  ).rejects.toThrow("cloud unavailable");

  expect(calls).toEqual([["bun", "run", "labs:sync-cloud"]]);
});

test("dead URL review events retain each exact verification reason deterministically", () => {
  const groups = groupDeadUrlsForStaling([
    { url: "https://jobs.example/z", reason: "HTTP 410" },
    { url: "https://jobs.example/b", reason: "HTTP 404" },
    { url: "https://jobs.example/a", reason: "HTTP 404" },
    { url: "https://jobs.example/b", reason: "HTTP 404" },
  ]);

  expect(groups).toEqual([
    {
      reason: "HTTP 404",
      urls: ["https://jobs.example/a", "https://jobs.example/b"],
    },
    { reason: "HTTP 410", urls: ["https://jobs.example/z"] },
  ]);
  expect(groups.map((group) => deadUrlReviewEventNote(group.reason))).toEqual([
    "Live URL verification found the role unavailable: HTTP 404",
    "Live URL verification found the role unavailable: HTTP 410",
  ]);
});
