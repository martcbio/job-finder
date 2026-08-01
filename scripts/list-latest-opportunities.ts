import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { getDatabaseUrl } from "../src/db/config";
import { runPsqlJson, withPsqlClientCleanup } from "../src/db/psql";
import {
  buildOpportunityReport,
  renderOpportunityHtml,
  renderOpportunityMarkdown,
} from "../src/pipeline/opportunityReport";
import {
  loadOpportunityReport,
  readOpportunityReportPolicy,
  type OpportunityReportPolicy,
} from "../src/pipeline/opportunityReportData";
import {
  verifyOpportunityUrls,
  type OpportunityUrlCheck,
} from "../src/pipeline/opportunityUrlVerification";
import {
  buildMarkJobsStaleByCanonicalUrlsSql,
  type ExpireJobRow,
} from "../src/pipeline/jobExpiry";

interface CliOptions extends OpportunityReportPolicy {
  format: "markdown" | "json";
  output: string | null;
  policyPath: string;
  refreshCloudLabs: boolean;
  refreshLabs: boolean;
  refreshDirect: boolean;
  refreshSignals: boolean;
  refreshJobServe: boolean;
  strictSourceHealth: boolean;
  quiet: boolean;
  email: boolean;
}

type OpportunityReport = Awaited<ReturnType<typeof loadOpportunityReport>>;

export interface DeadUrlStaleGroup {
  readonly reason: string;
  readonly urls: readonly string[];
}

type RefreshOptions = Pick<
  CliOptions,
  "refreshCloudLabs" | "refreshLabs" | "refreshDirect" | "refreshSignals" | "refreshJobServe"
>;

const compareText = (left: string, right: string): number =>
  left === right ? 0 : left < right ? -1 : 1;

export function groupDeadUrlsForStaling(
  deadUrls: readonly OpportunityUrlCheck[],
): DeadUrlStaleGroup[] {
  const urlsByReason = new Map<string, Set<string>>();
  for (const { url: rawUrl, reason: rawReason } of deadUrls) {
    const url = rawUrl.trim();
    const reason = rawReason.trim();
    if (!url) continue;
    if (!reason) throw new Error(`Dead URL ${url} has no verification reason`);
    const urls = urlsByReason.get(reason) ?? new Set<string>();
    urls.add(url);
    urlsByReason.set(reason, urls);
  }
  return [...urlsByReason]
    .sort(([left], [right]) => compareText(left, right))
    .map(([reason, urls]) => ({ reason, urls: [...urls].sort(compareText) }));
}

export function deadUrlReviewEventNote(reason: string): string {
  return `Live URL verification found the role unavailable: ${reason}`;
}

export function buildRefreshCommands(
  options: RefreshOptions,
): string[][] {
  const commands: string[][] = [];
  if (options.refreshCloudLabs) {
    commands.push(["bun", "run", "labs:sync-cloud"]);
  } else if (options.refreshLabs) {
    commands.push(["bun", "run", "labs:openings"]);
  }
  if (options.refreshDirect) {
    commands.push([
      "bun",
      "scripts/jobsradar.ts",
      "ingest",
      "--source",
      "linear-careers",
      "--source",
      "google-careers",
    ]);
  }
  if (options.refreshSignals) commands.push(["bun", "run", "company:signals"]);
  if (options.refreshJobServe) {
    commands.push(["bun", "scripts/jobsradar.ts", "ingest", "--source", "jobserve"]);
  }
  return commands;
}

export async function runRefreshCommands(
  options: RefreshOptions,
  runner: (argv: string[]) => Promise<void> = runCommand,
): Promise<void> {
  for (const command of buildRefreshCommands(options)) await runner(command);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return;
  }

  const policyPath = resolve(readStringFlag(args, "--policy") ?? "config/opportunity-report.json");
  const policy = await readOpportunityReportPolicy(policyPath);
  const options = parseOptions(args, policyPath, policy);
  getDatabaseUrl();

  await runRefreshCommands(options);

  const reportNow = new Date();
  const candidateReport = await loadOpportunityReport({
    query: (sql) => runPsqlJson(sql),
    now: reportNow,
    env: process.env,
    policyPath,
    limit: Math.min(30, options.limit + 5),
    maxAgeDays: options.maxAgeDays,
    pickCount: options.pickCount,
    staleAfterHours: options.staleAfterHours,
  });
  const urlChecks = await verifyOpportunityUrls(candidateReport.rows, {
    timeoutMs: 12_000,
    concurrency: 6,
  });
  const deadUrlGroups = groupDeadUrlsForStaling(urlChecks.dead);
  const staleRows: ExpireJobRow[] = [];
  for (const group of deadUrlGroups) {
    staleRows.push(
      ...(await runPsqlJson<ExpireJobRow[]>(
        buildMarkJobsStaleByCanonicalUrlsSql(group.urls, deadUrlReviewEventNote(group.reason)),
      )),
    );
  }
  for (const group of deadUrlGroups) {
    for (const url of group.urls) {
      console.error(`Excluded unavailable job URL: ${url} (${group.reason})`);
    }
  }
  for (const stale of staleRows) {
    console.error(`Marked stale from live URL verification: ${stale.id}: ${stale.title}`);
  }
  for (const unverified of urlChecks.unverified) {
    console.error(`Job URL could not be live-verified: ${unverified.url} (${unverified.reason})`);
  }
  const verifiedReport = buildOpportunityReport(urlChecks.rows, {
    now: reportNow,
    limit: options.limit,
    maxAgeDays: options.maxAgeDays,
    pickCount: options.pickCount,
  });
  const report = {
    ...verifiedReport,
    sourceHealth: candidateReport.sourceHealth,
    labMissingBodyCount: candidateReport.labMissingBodyCount,
  };
  const output =
    options.format === "json"
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderOpportunityMarkdown(report);
  if (!options.quiet) await writeOrPrint(output, options.output);
  if (options.email) await sendSelectionEmail(report);

  if (options.strictSourceHealth) {
    const unhealthySources = report.sourceHealth.filter((health) => health.status !== "current");
    for (const health of unhealthySources) {
      console.error(`Opportunity source unhealthy: ${health.message}`);
    }
    if (report.labMissingBodyCount > 0) {
      console.error(
        `Lab ATS body coverage failed: ${report.labMissingBodyCount} current rows lack full job bodies`,
      );
    }
    if (unhealthySources.length > 0 || report.labMissingBodyCount > 0) process.exitCode = 2;
  }
}

function parseOptions(
  args: string[],
  policyPath: string,
  policy: OpportunityReportPolicy,
): CliOptions {
  const format = readStringFlag(args, "--format") ?? "markdown";
  if (format !== "markdown" && format !== "json") {
    throw new Error("--format must be markdown or json");
  }
  const refreshAll = args.includes("--refresh");
  return {
    limit: readSelectionLimitFlag(args, "--limit", policy.limit),
    maxAgeDays: readPositiveIntegerFlag(args, "--max-age-days", policy.maxAgeDays),
    pickCount: readPositiveIntegerFlag(args, "--pick-count", policy.pickCount),
    staleAfterHours: readPositiveIntegerFlag(
      args,
      "--stale-after-hours",
      policy.staleAfterHours,
    ),
    expectedSources: policy.expectedSources,
    format,
    output: readStringFlag(args, "--output"),
    policyPath,
    refreshCloudLabs: args.includes("--refresh-cloud-labs"),
    refreshLabs: refreshAll || args.includes("--refresh-labs"),
    refreshDirect: refreshAll || args.includes("--refresh-direct"),
    refreshSignals: refreshAll || args.includes("--refresh-signals"),
    refreshJobServe: refreshAll || args.includes("--refresh-jobserve"),
    strictSourceHealth: args.includes("--strict-source-health"),
    quiet: args.includes("--quiet"),
    email: args.includes("--email"),
  };
}

function readSelectionLimitFlag(args: string[], name: string, fallback: number): number {
  const limit = readPositiveIntegerFlag(args, name, fallback);
  if (limit < 20 || limit > 30) {
    throw new Error(`${name} must be between 20 and 30 for a selection`);
  }
  return limit;
}

async function runCommand(argv: string[]): Promise<void> {
  const child = Bun.spawn(argv, {
    cwd: process.cwd(),
    env: process.env,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${argv.join(" ")}`);
  }
}

async function writeOrPrint(content: string, outputPath: string | null): Promise<void> {
  if (!outputPath) {
    process.stdout.write(content);
    return;
  }
  const absolute = resolve(outputPath);
  const repoRoot = `${resolve(process.cwd())}/`;
  if (!absolute.startsWith(repoRoot)) {
    throw new Error("--output must be inside the repository");
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(absolute, content, "utf8");
  console.error(`Wrote ${absolute}`);
}

function readStringFlag(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function readPositiveIntegerFlag(args: string[], name: string, fallback: number): number {
  const value = readStringFlag(args, name);
  return value === null ? fallback : positiveInteger(Number.parseInt(value, 10), name);
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function sendSelectionEmail(report: OpportunityReport): Promise<void> {
  if (report.rows.length === 0) throw new Error("Refusing to email an empty opportunity selection");
  const artifactDir = resolve("artifacts/opportunities");
  const htmlPath = resolve(artifactDir, "latest-selection.html");
  const textPath = resolve(artifactDir, "latest-selection.txt");
  const receiptPath = resolve(artifactDir, "latest-email.json");
  const subject = `Latest ${report.rows.length} verified engineering opportunities — ${report.generatedAt.slice(0, 10)}`;
  await mkdir(artifactDir, { recursive: true });
  await Promise.all([
    writeFile(htmlPath, renderOpportunityHtml(report), "utf8"),
    writeFile(textPath, renderOpportunityMarkdown(report), "utf8"),
  ]);
  const child = Bun.spawn(
    [
      "python3",
      resolve(process.env.HOME ?? "", ".codex/skills/resend-email/scripts/resend_email.py"),
      "--subject",
      subject,
      "--html-file",
      htmlPath,
      "--text-file",
      textPath,
      "--preheader",
      "Verified current engineering roles, caveats, disqualifications, and ChatGPT Picks.",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Resend delivery failed (${exitCode}): ${stderr.trim() || stdout.trim()}`);
  }
  const result = JSON.parse(stdout.trim()) as { ok?: boolean; id?: string };
  if (!result.ok || !result.id) throw new Error(`Resend returned no message ID: ${stdout.trim()}`);
  await writeFile(
    receiptPath,
    `${JSON.stringify({ sentAt: new Date().toISOString(), subject, messageId: result.id }, null, 2)}\n`,
    "utf8",
  );
  console.error(`Emailed selection through Resend: ${result.id}`);
}

function printUsage(): void {
  console.log(`Usage:
  bun run jobs:opportunities
  bun run jobs:opportunities -- --refresh-cloud-labs --limit 25 --email
  bun run jobs:opportunities -- --refresh --strict-source-health --email

Options:
  --refresh                  Refresh lab ATS boards, direct careers, and bounded JobServe, then report.
  --refresh-cloud-labs       Sync a fresh complete Modal run. Failure exits non-zero.
  --refresh-labs             Refresh only native lab ATS boards.
  --refresh-direct           Refresh first-class direct sources: Linear and Google Careers.
  --refresh-signals          Refresh hiring/funding signals from the bookmark corpus.
  --refresh-jobserve         Run the bounded, paced JobServe refresh.
  --limit N                  Selection size; must be 20–30. Defaults to 25.
  --max-age-days N           Override the opportunity window.
  --pick-count N             Override ChatGPT Pick count.
  --stale-after-hours N      Source acquisition age allowed before STALE.
  --strict-source-health     Exit 2 when a source is stale/missing or Lab ATS bodies are absent.
  --quiet                    Refresh and validate without printing the report.
  --email                    Send the verified selection through configured Resend.
  --format markdown|json     Output format.
  --output PATH              Write inside this repository instead of stdout.
  --policy PATH              Report-policy JSON. Defaults to config/opportunity-report.json.

Uses DATABASE_URL when supplied; otherwise targets local Postgres at postgres://$USER@localhost:5432/jobs. JobServe is never contacted unless --refresh-jobserve or --refresh is supplied.`);
}

if (import.meta.main) {
  withPsqlClientCleanup(main).catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
