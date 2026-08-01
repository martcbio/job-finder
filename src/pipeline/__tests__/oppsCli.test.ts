import { expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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
  expect(stdout).toContain("deterministic Jobsradar raw ingest");
  expect(stdout).toContain("Default ingestion includes bounded, paced JobServe contracts");
  expect(stdout).toContain("does not rank, report, email, or fall back to a different scanner");
});

test("opps update invokes the default deterministic Jobsradar ingest without a hidden fallback", async () => {
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
    expect(args.trim().split("\n")).toEqual(["scripts/jobsradar.ts", "ingest"]);
    expect(args).not.toContain("list-latest-opportunities.ts");
    expect(args).not.toContain("--refresh-cloud-labs");
    expect(args).not.toContain("--source");
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});

test("opps resolves its repository from a symlinked executable", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "opps-symlink-test-"));
  const argsPath = join(fakeBin, "args");
  const workingDirectoryPath = join(fakeBin, "working-directory");
  const fakeBun = join(fakeBin, "bun");
  const linkedOpps = join(fakeBin, "opps");
  await writeFile(
    fakeBun,
    `#!/bin/sh\npwd > "${workingDirectoryPath}"\nprintf '%s\\n' "$@" > "${argsPath}"\n`,
  );
  await Promise.all([
    chmod(fakeBun, 0o755),
    symlink(join(process.cwd(), "scripts", "opps"), linkedOpps),
  ]);

  try {
    const child = Bun.spawn(["bash", linkedOpps, "update"], {
      cwd: process.cwd(),
      env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(await readFile(workingDirectoryPath, "utf8")).toBe(`${process.cwd()}\n`);
    expect(await readFile(argsPath, "utf8")).toBe("scripts/jobsradar.ts\ningest\n");
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

test("opps doctor bypasses proxies for local checks and does not require Modal", async () => {
  const fakeBin = await mkdtemp(join(tmpdir(), "opps-doctor-test-"));
  const fakePg = join(fakeBin, "pg_isready");
  const fakeCurl = join(fakeBin, "curl");
  const proxyPath = join(fakeBin, "proxy");
  await writeFile(fakePg, "#!/bin/sh\nexit 0\n");
  await writeFile(
    fakeCurl,
    `#!/bin/sh\nprintf '%s\\n%s\\n' "$NO_PROXY" "$no_proxy" > "${proxyPath}"\nprintf '%s\\n' '{}'\n`,
  );
  await Promise.all([chmod(fakePg, 0o755), chmod(fakeCurl, 0o755)]);

  try {
    const child = Bun.spawn(["bash", "scripts/opps", "doctor"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NO_PROXY: "existing.example,localhost",
        no_proxy: "legacy.example,127.0.0.1,::1",
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      },
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
    expect(stdout).toContain("database  ok");
    expect(stdout).toContain("api       ok");
    expect(stdout).toContain("ui        http://127.0.0.1:32002/");
    expect(stdout).not.toContain("modal");
    expect(await readFile(proxyPath, "utf8")).toBe(
      "existing.example,localhost,127.0.0.1,::1\nlegacy.example,127.0.0.1,::1,localhost\n",
    );
  } finally {
    await rm(fakeBin, { recursive: true, force: true });
  }
});
