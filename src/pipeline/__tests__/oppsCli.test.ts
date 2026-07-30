import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("opps exposes the short safe workflow", async () => {
  const child = Bun.spawn(["bash", "scripts/opps", "--help"], {
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
  expect(stdout).toContain("opps update");
  expect(stdout).toContain("all configured sources");
  expect(stdout).toContain("JobServe contracts");
  expect(stdout).toContain("Selections are always emailed through Resend");
});

test("opps update refreshes every configured source without a JobServe flag", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "opps-test-"));
  const argsPath = join(fakeBin, "args");
  const fakeBun = join(fakeBin, "bun");
  await writeFile(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsPath}"\n`);
  await chmod(fakeBun, 0o755);

  try {
    const child = Bun.spawn(["bash", "scripts/opps", "update"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    const args = await readFile(argsPath, "utf8");

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(args).toContain("--refresh-cloud-labs");
    expect(args).toContain("--refresh-direct");
    expect(args).toContain("--refresh-signals");
    expect(args).toContain("--refresh-jobserve");
    expect(args).toContain("--strict-source-health");
    expect(args).toContain("--email");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("opps list always sends the displayed selection through Resend", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "opps-list-test-"));
  const argsPath = join(fakeBin, "args");
  const fakeBun = join(fakeBin, "bun");
  await writeFile(fakeBun, `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsPath}"\n`);
  await chmod(fakeBun, 0o755);

  try {
    const child = Bun.spawn(["bash", "scripts/opps", "list"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await child.exited;
    const args = await readFile(argsPath, "utf8");

    expect(exitCode).toBe(0);
    expect(args).toContain("--email");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("opps doctor verifies the healthy Modal careers dependency", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "opps-doctor-test-"));
  const fakePg = join(fakeBin, "pg_isready");
  const fakeCurl = join(fakeBin, "curl");
  await writeFile(fakePg, "#!/bin/sh\nexit 0\n");
  await writeFile(
    fakeCurl,
    `#!/bin/sh
for arg in "$@"; do url="$arg"; done
case "$url" in
  */api/cloud/ops)
    printf '%s\\n' '{"ok":true,"data":{"doctor":{"status":"available","rows":[{"task":"jobsradar","substrate":"modal","stale":false,"unhealthy":false,"latest_success_at":"2026-07-25T06:41:17Z"}]}}}'
    ;;
  *) printf '%s\\n' '{}';;
esac
`,
  );
  await Promise.all([chmod(fakePg, 0o755), chmod(fakeCurl, 0o755)]);

  try {
    const child = Bun.spawn(["bash", "scripts/opps", "doctor"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
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
    expect(stdout).toContain("modal     ok 2026-07-25T06:41:17Z");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});
