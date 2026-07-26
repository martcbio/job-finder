import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildCompanySignalArtifact,
  isHiringThread,
  type BookmarkQueryPayload,
  type TwitterReply,
} from "../src/pipeline/companySignals";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BOOKMARKS_ROOT =
  process.env.BOOKMARKS_REPO ?? "/Users/mcb/Claudelocal/bookmarks";
const OUTPUT_PATH = resolve(
  process.env.CAREERS_COMPANY_SIGNALS_PATH ??
    resolve(REPO_ROOT, "../../../market/company-signals/latest.json"),
);
const QUERY_DAYS = process.env.CAREERS_COMPANY_SIGNALS_DAYS ?? "45";
const QUERY_LIMIT = process.env.CAREERS_COMPANY_SIGNALS_LIMIT ?? "200";

const doctorExitCode = await run(
  ["uv", "run", "python3", "query_bookmarks.py", "--doctor"],
  BOOKMARKS_ROOT,
  new Set([0, 12]),
);
const queries = await Promise.all([
  queryBookmarks(
    "\\b((just|recently|we|has|have|company)?[ ]*rais(ed|es)[ ]+(a[ ]+)?([£€$][ ]?[0-9,.]+[ ]*(m|million|bn|billion)?|[0-9]+(\\.[0-9]+)?[ ]*(m|million|bn|billion)|pre[- ]?seed|seed|series[ ]+[a-e])|(announced|closed|secured).{0,80}(funding|fundraise|pre[- ]?seed|seed round|series[ ]+[a-e]))\\b",
  ),
  queryBookmarks(
    "\\b(hiring|we.re hiring|we are hiring|open roles?|openings|join (us|our team)|come work)\\b",
  ),
]);

const threadReplies = new Map<string, TwitterReply[]>();
const hiringThreads = deduplicateRows(queries.flatMap((query) => query.rows)).filter(
  isHiringThread,
);
for (const thread of hiringThreads) {
  if (!thread.tweet_url) throw new Error(`Hiring thread ${thread.status_id} has no URL`);
  const payload = await runJson<{ tweets?: TwitterReply[] }>(
    [
      "bird",
      "replies",
      thread.tweet_url,
      "--max-pages",
      "3",
      "--delay",
      "1000",
      "--json",
    ],
    REPO_ROOT,
  );
  if (!Array.isArray(payload.tweets)) {
    throw new Error(`bird replies returned no tweets array for ${thread.tweet_url}`);
  }
  threadReplies.set(thread.status_id, payload.tweets);
}

const artifact = buildCompanySignalArtifact({
  generatedAt: new Date().toISOString(),
  queries,
  threadReplies,
});
await writeArtifact(OUTPUT_PATH, artifact);
process.stdout.write(
  `${JSON.stringify({
    output: OUTPUT_PATH,
    signals: artifact.signals.length,
    funding: artifact.signals.filter((signal) => signal.kinds.includes("funding")).length,
    hiring: artifact.signals.filter((signal) => signal.kinds.includes("hiring")).length,
    hiringThreads: hiringThreads.length,
    doctorExitCode,
    diagnostics: artifact.diagnostics,
  })}\n`,
);

async function queryBookmarks(contains: string): Promise<BookmarkQueryPayload> {
  return runJson<BookmarkQueryPayload>(
    [
      "uv",
      "run",
      "python3",
      "query_bookmarks.py",
      "--days",
      QUERY_DAYS,
      "--contains",
      contains,
      "--limit",
      QUERY_LIMIT,
      "--format",
      "json",
    ],
    BOOKMARKS_ROOT,
  );
}

async function runJson<T>(argv: string[], cwd: string): Promise<T> {
  const child = Bun.spawn(argv, { cwd, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `Command failed (${exitCode}): ${argv.join(" ")}\n${stderr.trim() || stdout.trim()}`,
    );
  }
  try {
    return JSON.parse(stdout) as T;
  } catch (error) {
    throw new Error(`Command returned invalid JSON: ${argv.join(" ")}\n${stdout.slice(0, 1000)}`, {
      cause: error,
    });
  }
}

async function run(
  argv: string[],
  cwd: string,
  allowedExitCodes: ReadonlySet<number> = new Set([0]),
): Promise<number> {
  const child = Bun.spawn(argv, { cwd, env: process.env, stdout: "inherit", stderr: "inherit" });
  const exitCode = await child.exited;
  if (!allowedExitCodes.has(exitCode)) {
    throw new Error(`Command failed (${exitCode}): ${argv.join(" ")}`);
  }
  return exitCode;
}

async function writeArtifact(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

function deduplicateRows<T extends { status_id: string }>(rows: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const row of rows) byId.set(row.status_id, row);
  return [...byId.values()];
}
