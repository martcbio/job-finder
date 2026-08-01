import { createHash, randomUUID } from "node:crypto";
import { accessSync, constants, statSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { hostname as systemHostname } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { logger } from "../logger";
import { listOrgJobs as listAshbyOrgJobs } from "../services/ats/ashby";
import { listOrgJobs as listGreenhouseOrgJobs } from "../services/ats/greenhouse";
import { listOrgJobs as listLeverOrgJobs } from "../services/ats/lever";
import type { AtsAcquisitionFailure, AtsOrgAcquisition, AtsOrgJob } from "../services/ats/types";
import {
  createFreshnessStore,
  type FreshnessReport,
  type OutputArtifact,
  type ProjectionId,
  type ProjectionRunRecord,
} from "./freshness";
import { classifyLabOpening, type LabOpeningDecision } from "./labOpeningDecisions";

const log = logger.child({ component: "pipeline/lab-openings" });

function projectDirForModule(moduleDir: string): string {
  return resolve(moduleDir, "..", "..");
}

function marketDirForProject(projectDir: string): string {
  let ancestor = resolve(projectDir);
  while (true) {
    const marketDir = join(ancestor, "market");
    if (isReadable(join(marketDir, "targets.json"))) return marketDir;

    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }

  throw new Error(
    `Cannot find market/targets.json from project directory ${projectDir}. Set CAREERS_MARKET_DIR explicitly.`,
  );
}

function isReadable(path: string): boolean {
  try {
    accessSync(path, constants.R_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function projectDirForEnvironment(env: Readonly<Record<string, string | undefined>>): string {
  return env.CAREERS_PROJECT_DIR || DEFAULT_PROJECT_DIR;
}

function marketDirForEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  projectDir: string,
): string {
  return env.CAREERS_MARKET_DIR || marketDirForProject(projectDir);
}

const DEFAULT_PROJECT_DIR = projectDirForModule(import.meta.dir);
const PACKAGE_VERSION = "2026.05.02.1";
const IMPLEMENTATION_REVISION = "lab-openings-v1";
const FRESH_FOR_MS = 30 * 60 * 60 * 1000;
const DEAD_PID_GRACE_MS = 60_000;
const OWNERLESS_LOCK_GRACE_MS = 5 * 60 * 1000;
const UNKNOWN_HOST_LOCK_GRACE_MS = 24 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_INTERVAL_MS = 60_000;
const MAX_HEARTBEAT_AGE_MS = 30 * 60 * 1000;

const targetSchema = z.record(
  z.string(),
  z.object({
    ats: z.enum(["ashby", "greenhouse", "lever"]).nullable(),
    company: z.string(),
  }),
);

const lockOwnerSchema = z.object({
  schemaVersion: z.literal(1),
  ownerToken: z.string().uuid(),
  runId: z.string().min(1),
  pid: z.number().int().positive(),
  hostname: z.string().min(1),
  acquiredAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  cwd: z.string().min(1),
  argv: z.array(z.string()),
});

type AtsKind = "ashby" | "greenhouse" | "lever";
type LockOwner = z.infer<typeof lockOwnerSchema>;

type LabBoardRun =
  | {
      status: "success";
      org: string;
      company: string;
      ats: AtsKind;
      endpoint: string;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      attempts: number;
      totalOpenings: number;
      eligibleOpenings: number;
      suitableOpenings: number;
      matchedOpenings: number;
    }
  | {
      status: "failure";
      org: string;
      company: string;
      ats: AtsKind;
      startedAt: string;
      completedAt: string;
      durationMs: number;
      attempts: number;
      failure: AtsAcquisitionFailure;
    }
  | {
      status: "skipped";
      org: string;
      company: string;
      ats: null;
      reason: "no_verified_public_ats_slug";
    };

interface Opening extends AtsOrgJob, LabOpeningDecision {
  company: string;
}

interface LabOpeningsSummary {
  targetCount: number;
  configuredAtsBoards: number;
  successfulBoards: number;
  failedBoards: number;
  skippedBoards: number;
  acquiredJobs: number;
  rawOpenings: number;
  eligibleOpenings: number;
  suitableOpenings: number;
  unsuitableLocationOpenings: number;
  unsuitableRoleOpenings: number;
  undecidedOpenings: number;
  matchedOpenings: number;
}

interface LabOpeningsStatusFile {
  schemaVersion: 1;
  projectionId: "lab-openings";
  runId: string;
  trigger: "manual" | "scheduled";
  scheduledAt: string;
  startedAt: string;
  completedAt: string;
  timezone: string;
  status: "complete" | "degraded" | "failed";
  summary: LabOpeningsSummary;
  boards: LabBoardRun[];
  diagnostics: string[];
}

export type LabOpeningsRecordResult =
  | {
      status: "complete" | "degraded" | "failed";
      runId: string;
      startedAt: string;
      completedAt: string;
      record: ProjectionRunRecord;
      generationDir: string;
      legacyWarnings: string[];
    }
  | {
      status: "locked";
      runId: string;
      startedAt: string;
      completedAt: string;
      owner: LockOwner | null;
    };

export interface LabOpeningsRecordInput {
  trigger?: "manual" | "scheduled";
  scheduledAt?: string;
}

type LabBoardLister = (org: string) => Promise<AtsOrgAcquisition>;

type ProcessState = "alive" | "missing" | "unknown";

export interface LabOpeningsModuleOptions {
  marketDir?: string;
  projectDir?: string;
  now?: () => Date;
  makeRunId?: (startedAt: Date) => string;
  listers?: Record<AtsKind, LabBoardLister>;
  pid?: number;
  hostname?: string;
  cwd?: string;
  argv?: string[];
  processState?: (pid: number) => ProcessState;
  beforeStateCommit?: (record: ProjectionRunRecord) => Promise<void> | void;
}

export interface LabOpeningsModule {
  record(input?: LabOpeningsRecordInput): Promise<LabOpeningsRecordResult>;
  inspect(ids?: ProjectionId[]): Promise<FreshnessReport>;
}

export function resolveLabOpeningsPaths(
  env: Readonly<Record<string, string | undefined>> = process.env,
): { marketDir: string; projectDir: string } {
  const projectDir = projectDirForEnvironment(env);
  return {
    marketDir: marketDirForEnvironment(env, projectDir),
    projectDir,
  };
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return undefined;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function defaultRunId(startedAt: Date): string {
  const timestamp = startedAt.toISOString().replace(/[-:.]/g, "");
  return `${timestamp}_${randomUUID()}`;
}

function defaultProcessState(pid: number): ProcessState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errorCode(error);
    if (code === "ESRCH") return "missing";
    return "unknown";
  }
}

function parseTimestamp(value: string, label: string): string {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.getTime()))
    throw new Error(`${label} must be an ISO-8601 timestamp`);
  return timestamp.toISOString();
}

function formatLocation(job: AtsOrgJob): string {
  if (job.locations.length > 0) return job.locations.join("; ");
  return job.location || "";
}

function failureMessage(failure: AtsAcquisitionFailure): string {
  switch (failure.kind) {
    case "transport":
      return `transport failure: ${failure.message}`;
    case "http":
      return `HTTP ${failure.status}${failure.statusText ? ` ${failure.statusText}` : ""}`;
    case "parse":
      return `JSON parse failure: ${failure.message}`;
    case "schema":
      return `schema failure: ${failure.issues.map((issue) => issue.message).join("; ")}`;
  }
}

function markdownFor(
  date: string,
  runId: string,
  runs: LabBoardRun[],
  openings: Opening[],
): string {
  const lines = [
    `# AI Lab Openings - ${date}`,
    "",
    `Run: \`${runId}\``,
    "",
    "## Board Status",
    "",
    "| org | company | ats | status | live | eligible | suitable | error |",
    "| --- | --- | --- | --- | ---: | ---: | ---: | --- |",
  ];

  for (const run of runs) {
    const totalOpenings = run.status === "success" ? run.totalOpenings : 0;
    const eligibleOpenings = run.status === "success" ? run.eligibleOpenings : 0;
    const suitableOpenings = run.status === "success" ? run.suitableOpenings : 0;
    const error =
      run.status === "failure"
        ? failureMessage(run.failure)
        : run.status === "skipped"
          ? "no verified public ATS slug"
          : "";
    lines.push(
      `| ${run.org} | ${run.company} | ${run.ats ?? "null"} | ${run.status} | ${totalOpenings} | ${eligibleOpenings} | ${suitableOpenings} | ${error.replaceAll("|", "\\|")} |`,
    );
  }

  lines.push("", "## Openings", "");
  if (openings.length === 0) {
    lines.push("No openings.");
    return lines.join("\n");
  }

  let currentOrg = "";
  for (const opening of openings) {
    if (opening.org !== currentOrg) {
      currentOrg = opening.org;
      lines.push(`### ${opening.company} (${opening.org})`, "");
    }
    const location = formatLocation(opening) || "Unspecified";
    const posted = opening.postedAt ? ` - ${opening.postedAt}` : "";
    lines.push(
      `- [${opening.title ?? "Untitled"}](${opening.url}) - ${location}${posted} — ${opening.disposition}`,
    );
  }

  return lines.join("\n");
}

function jsonlFor(openings: Opening[]): string {
  const lines = openings.map((opening) =>
    JSON.stringify({
      org: opening.org,
      company: opening.company,
      ats: opening.source,
      id: opening.id,
      title: opening.title,
      location: opening.location,
      locations: opening.locations,
      url: opening.url,
      postedAt: opening.postedAt,
      locationEligibility: opening.locationEligibility,
      roleRelevance: opening.roleRelevance,
      disposition: opening.disposition,
      raw: opening.raw,
    }),
  );
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

function artifactDescriptor(
  marketDir: string,
  absolutePath: string,
  mediaType: string,
  content: string,
): OutputArtifact {
  return {
    path: relative(marketDir, absolutePath),
    mediaType,
    byteLength: Buffer.byteLength(content),
    sha256: sha256Hex(content),
  };
}

async function verifyArtifacts(marketDir: string, outputs: OutputArtifact[]): Promise<void> {
  for (const output of outputs) {
    const content = await readFile(join(marketDir, output.path));
    if (content.byteLength !== output.byteLength) {
      throw new Error(`Artifact byte length changed before publication: ${output.path}`);
    }
    if (createHash("sha256").update(content).digest("hex") !== output.sha256) {
      throw new Error(`Artifact digest changed before publication: ${output.path}`);
    }
  }
}

async function writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, content, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function copyFileAtomic(source: string, destination: string): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = `${destination}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, destination);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readLockOwner(path: string): Promise<LockOwner | null> {
  try {
    return lockOwnerSchema.parse(await readJson(path));
  } catch {
    return null;
  }
}

interface LockHandle {
  owner: LockOwner;
  release(): Promise<void>;
}

async function acquireLock(input: {
  lockDir: string;
  runId: string;
  now: () => Date;
  pid: number;
  hostname: string;
  cwd: string;
  argv: string[];
  processState: (pid: number) => ProcessState;
}): Promise<
  { status: "acquired"; handle: LockHandle } | { status: "locked"; owner: LockOwner | null }
> {
  const ownerPath = join(input.lockDir, "owner.json");

  const create = async (): Promise<LockHandle | null> => {
    const acquiredAt = input.now().toISOString();
    let owner: LockOwner = {
      schemaVersion: 1,
      ownerToken: randomUUID(),
      runId: input.runId,
      pid: input.pid,
      hostname: input.hostname,
      acquiredAt,
      heartbeatAt: acquiredAt,
      cwd: input.cwd,
      argv: input.argv,
    };
    const candidatePath = `${input.lockDir}.candidate.${input.runId}.${randomUUID()}.json`;
    await writeTextAtomic(candidatePath, `${JSON.stringify(owner, null, 2)}\n`);
    try {
      await mkdir(input.lockDir);
    } catch (error) {
      await rm(candidatePath, { force: true }).catch(() => undefined);
      if (errorCode(error) === "EEXIST") return null;
      throw error;
    }
    try {
      await rename(candidatePath, ownerPath);
    } catch (error) {
      await Promise.all([
        rm(candidatePath, { force: true }).catch(() => undefined),
        rm(input.lockDir, { recursive: true, force: true }).catch(() => undefined),
      ]);
      throw error;
    }

    let heartbeatRunning = false;
    const heartbeat = setInterval(() => {
      if (heartbeatRunning) return;
      heartbeatRunning = true;
      void (async () => {
        try {
          const current = await readLockOwner(ownerPath);
          if (current?.ownerToken !== owner.ownerToken) return;
          owner = { ...owner, heartbeatAt: input.now().toISOString() };
          await writeTextAtomic(ownerPath, `${JSON.stringify(owner, null, 2)}\n`);
        } catch (error) {
          log.warn({ error, runId: owner.runId }, "could not update lab openings lock heartbeat");
        } finally {
          heartbeatRunning = false;
        }
      })();
    }, LOCK_HEARTBEAT_INTERVAL_MS);

    return {
      owner,
      async release() {
        clearInterval(heartbeat);
        const current = await readLockOwner(ownerPath);
        if (current?.ownerToken === owner.ownerToken) {
          await rm(input.lockDir, { recursive: true, force: true });
        }
      },
    };
  };

  const initial = await create();
  if (initial) return { status: "acquired", handle: initial };

  const [owner, lockStat] = await Promise.all([
    readLockOwner(ownerPath),
    stat(input.lockDir).catch(() => null),
  ]);
  if (!lockStat) return acquireLock(input);

  const checkedAt = input.now().getTime();
  const ageMs = checkedAt - lockStat.mtimeMs;
  let stale = false;
  if (owner?.hostname === input.hostname) {
    const processState = input.processState(owner.pid);
    const heartbeatAgeMs = checkedAt - new Date(owner.heartbeatAt).getTime();
    stale =
      (processState === "missing" && ageMs >= DEAD_PID_GRACE_MS) ||
      heartbeatAgeMs >= MAX_HEARTBEAT_AGE_MS;
  } else if (!owner) {
    stale = ageMs >= OWNERLESS_LOCK_GRACE_MS;
  } else {
    stale = ageMs >= UNKNOWN_HOST_LOCK_GRACE_MS;
  }

  if (!stale) return { status: "locked", owner };

  const tombstone = `${input.lockDir}.stale.${input.runId}`;
  try {
    await rename(input.lockDir, tombstone);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return acquireLock(input);
    throw error;
  }

  const movedOwner = await readLockOwner(join(tombstone, "owner.json"));
  if (owner && movedOwner?.ownerToken !== owner.ownerToken) {
    try {
      await rename(tombstone, input.lockDir);
    } catch {
      // Another invocation changed the lock while we inspected it. Leave both paths untouched.
    }
    return { status: "locked", owner: movedOwner };
  }
  await rm(tombstone, { recursive: true, force: true });

  const reclaimed = await create();
  if (reclaimed) return { status: "acquired", handle: reclaimed };
  return { status: "locked", owner: await readLockOwner(ownerPath) };
}

function unexpectedFailure(endpoint: string, error: unknown): AtsAcquisitionFailure {
  const normalized = error instanceof Error ? error : new Error(String(error));
  return {
    kind: "transport",
    endpoint,
    message: normalized.message,
    errorName: normalized.name,
    errorCode: errorCode(error) ?? null,
    retryable: false,
  };
}

function summaryFor(runs: LabBoardRun[], openings: Opening[]): LabOpeningsSummary {
  const successful = runs.filter((run) => run.status === "success");
  const suitableOpenings = openings.filter((opening) => opening.disposition === "suitable").length;
  return {
    targetCount: runs.length,
    configuredAtsBoards: runs.filter((run) => run.ats !== null).length,
    successfulBoards: successful.length,
    failedBoards: runs.filter((run) => run.status === "failure").length,
    skippedBoards: runs.filter((run) => run.status === "skipped").length,
    acquiredJobs: successful.reduce((total, run) => total + run.totalOpenings, 0),
    rawOpenings: openings.length,
    eligibleOpenings: openings.filter(
      (opening) => opening.locationEligibility.status === "eligible",
    ).length,
    suitableOpenings,
    unsuitableLocationOpenings: openings.filter(
      (opening) => opening.disposition === "unsuitable_location",
    ).length,
    unsuitableRoleOpenings: openings.filter((opening) => opening.disposition === "unsuitable_role")
      .length,
    undecidedOpenings: openings.filter((opening) => opening.disposition === "undecided").length,
    matchedOpenings: suitableOpenings,
  };
}

function healthFor(summary: LabOpeningsSummary): "complete" | "degraded" | "failed" {
  if (summary.successfulBoards === 0) return "failed";
  if (summary.failedBoards > 0) return "degraded";
  return "complete";
}

function legacyRuns(boardRuns: LabBoardRun[]) {
  return boardRuns.map((run) => ({
    org: run.org,
    company: run.company,
    ats: run.ats,
    status: run.status === "success" ? "hit" : run.status === "failure" ? "miss" : "skipped",
    totalOpenings: run.status === "success" ? run.totalOpenings : 0,
    eligibleOpenings: run.status === "success" ? run.eligibleOpenings : 0,
    suitableOpenings: run.status === "success" ? run.suitableOpenings : 0,
    matchedOpenings: run.status === "success" ? run.matchedOpenings : 0,
    error:
      run.status === "failure"
        ? failureMessage(run.failure)
        : run.status === "skipped"
          ? "no verified public ATS slug"
          : undefined,
  }));
}

async function publishLegacyAttempt(input: {
  marketDir: string;
  generationDir: string;
  runId: string;
  previousCurrentRun: string | null;
  scheduledAt: string;
  startedAt: string;
  completedAt: string;
  status: "complete" | "degraded" | "failed";
  summary: LabOpeningsSummary;
  boardRuns: LabBoardRun[];
  diagnostics: string[];
}): Promise<void> {
  const date = input.completedAt.slice(0, 10);
  const legacyStatusPath = join(input.marketDir, `openings-${date}.status.json`);
  const statusBase = {
    date,
    runs: legacyRuns(input.boardRuns),
    openings: input.summary.matchedOpenings,
    schemaVersion: 1,
    runId: input.runId,
    scheduledAt: input.scheduledAt,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    health: input.status,
    rawOpenings: input.summary.rawOpenings,
    eligibleOpenings: input.summary.eligibleOpenings,
    suitableOpenings: input.summary.suitableOpenings,
    unsuitableLocationOpenings: input.summary.unsuitableLocationOpenings,
    unsuitableRoleOpenings: input.summary.unsuitableRoleOpenings,
    undecidedOpenings: input.summary.undecidedOpenings,
    diagnostics: input.diagnostics,
  };

  if (input.status !== "complete") {
    await writeTextAtomic(
      legacyStatusPath,
      `${JSON.stringify(
        {
          ...statusBase,
          publication: "retained",
          publishedRunId: input.previousCurrentRun,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  await writeTextAtomic(
    legacyStatusPath,
    `${JSON.stringify(
      {
        ...statusBase,
        publication: "publishing",
        publishedRunId: input.previousCurrentRun,
      },
      null,
      2,
    )}\n`,
  );
  await copyFileAtomic(
    join(input.generationDir, "openings.md"),
    join(input.marketDir, `openings-${date}.md`),
  );
  await copyFileAtomic(
    join(input.generationDir, "openings.jsonl"),
    join(input.marketDir, `openings-${date}.jsonl`),
  );
  await writeTextAtomic(
    legacyStatusPath,
    `${JSON.stringify(
      {
        ...statusBase,
        publication: "complete",
        publishedRunId: input.runId,
      },
      null,
      2,
    )}\n`,
  );
}

export function createLabOpeningsModule(options: LabOpeningsModuleOptions = {}): LabOpeningsModule {
  const projectDir = options.projectDir ?? projectDirForEnvironment(process.env);
  const marketDir = options.marketDir ?? marketDirForEnvironment(process.env, projectDir);
  const now = options.now ?? (() => new Date());
  const makeRunId = options.makeRunId ?? defaultRunId;
  const listers =
    options.listers ??
    ({
      ashby: (org) => listAshbyOrgJobs(org),
      greenhouse: (org) => listGreenhouseOrgJobs(org),
      lever: (org) => listLeverOrgJobs(org),
    } satisfies Record<AtsKind, LabBoardLister>);
  const pid = options.pid ?? process.pid;
  const hostname = options.hostname ?? systemHostname();
  const cwd = options.cwd ?? process.cwd();
  const argv = options.argv ?? process.argv;
  const processState = options.processState ?? defaultProcessState;
  const projectionDir = join(marketDir, "lab-openings");
  const freshnessStore = createFreshnessStore({
    rootDir: join(marketDir, "freshness"),
    repairs: {
      "lab-openings": {
        cwd: projectDir,
        argv: ["bun", "run", "labs:openings", "--", "record"],
      },
    },
    now,
  });

  return {
    async record(input = {}) {
      const startedAtDate = now();
      const startedAt = startedAtDate.toISOString();
      const runId = makeRunId(startedAtDate);
      const trigger = input.trigger ?? "manual";
      const scheduledAt = parseTimestamp(input.scheduledAt ?? startedAt, "scheduledAt");
      await mkdir(projectionDir, { recursive: true });
      const lock = await acquireLock({
        lockDir: join(projectionDir, ".record.lock"),
        runId,
        now,
        pid,
        hostname,
        cwd,
        argv,
        processState,
      });
      if (lock.status === "locked") {
        return {
          status: "locked",
          runId,
          startedAt,
          completedAt: now().toISOString(),
          owner: lock.owner,
        };
      }

      try {
        const targetsPath = join(marketDir, "targets.json");
        const targets = targetSchema.parse(await readJson(targetsPath));
        const previousInspection = await freshnessStore.inspect(["lab-openings"]);
        const previousProjection = previousInspection.projections[0];
        const previousSuccessfulRun = previousProjection?.lastHealthy?.runId ?? null;
        const previousCurrentRun = previousProjection?.current?.runId ?? null;
        const stagingRoot = join(projectionDir, ".staging");
        const stagingDir = join(stagingRoot, runId);
        const runsDir = join(projectionDir, "runs");
        const generationDir = join(runsDir, runId);
        await Promise.all([
          mkdir(stagingRoot, { recursive: true }),
          mkdir(runsDir, { recursive: true }),
        ]);
        await mkdir(stagingDir, { recursive: false });

        const boardRuns: LabBoardRun[] = [];
        const openings: Opening[] = [];

        for (const [org, target] of Object.entries(targets)) {
          if (!target.ats) {
            boardRuns.push({
              status: "skipped",
              org,
              company: target.company,
              ats: null,
              reason: "no_verified_public_ats_slug",
            });
            continue;
          }

          const boardStartedAt = now().toISOString();
          let acquisition: AtsOrgAcquisition;
          try {
            acquisition = await listers[target.ats](org);
          } catch (error) {
            acquisition = {
              status: "failure",
              attempts: 1,
              durationMs: 0,
              failure: unexpectedFailure(`${target.ats}:${org}`, error),
            };
          }
          const boardCompletedAt = now().toISOString();

          if (acquisition.status === "failure") {
            boardRuns.push({
              status: "failure",
              org,
              company: target.company,
              ats: target.ats,
              startedAt: boardStartedAt,
              completedAt: boardCompletedAt,
              durationMs: acquisition.durationMs,
              attempts: acquisition.attempts,
              failure: acquisition.failure,
            });
            continue;
          }

          const classified = acquisition.jobs.map((job) => ({
            ...job,
            company: target.company,
            ...classifyLabOpening(job),
          }));
          openings.push(...classified);
          const eligibleOpenings = classified.filter(
            (opening) => opening.locationEligibility.status === "eligible",
          ).length;
          const suitableOpenings = classified.filter(
            (opening) => opening.disposition === "suitable",
          ).length;
          boardRuns.push({
            status: "success",
            org,
            company: target.company,
            ats: target.ats,
            endpoint: acquisition.endpoint,
            startedAt: boardStartedAt,
            completedAt: boardCompletedAt,
            durationMs: acquisition.durationMs,
            attempts: acquisition.attempts,
            totalOpenings: acquisition.jobs.length,
            eligibleOpenings,
            suitableOpenings,
            matchedOpenings: suitableOpenings,
          });
        }

        openings.sort((left, right) =>
          `${left.company} ${left.title}`.localeCompare(`${right.company} ${right.title}`),
        );
        const summary = summaryFor(boardRuns, openings);
        const status = healthFor(summary);
        const completedAt = now().toISOString();
        const freshUntil =
          status === "failed"
            ? null
            : new Date(new Date(completedAt).getTime() + FRESH_FOR_MS).toISOString();
        const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
        const diagnostics = boardRuns
          .filter(
            (run): run is Extract<LabBoardRun, { status: "failure" }> => run.status === "failure",
          )
          .map((run) => `${run.company}: ${failureMessage(run.failure)}`);
        if (summary.successfulBoards === 0) {
          diagnostics.unshift("No configured ATS board returned a valid payload.");
        }

        const statusFile: LabOpeningsStatusFile = {
          schemaVersion: 1,
          projectionId: "lab-openings",
          runId,
          trigger,
          scheduledAt,
          startedAt,
          completedAt,
          timezone,
          status,
          summary,
          boards: boardRuns,
          diagnostics,
        };
        const statusContent = `${JSON.stringify(statusFile, null, 2)}\n`;
        const statusPath = join(stagingDir, "status.json");
        await writeFile(statusPath, statusContent, "utf8");

        const outputs: OutputArtifact[] = [
          artifactDescriptor(marketDir, statusPath, "application/json", statusContent),
        ];
        if (status !== "failed") {
          const date = completedAt.slice(0, 10);
          const markdownContent = `${markdownFor(date, runId, boardRuns, openings)}\n`;
          const jsonlContent = jsonlFor(openings);
          const markdownPath = join(stagingDir, "openings.md");
          const jsonlPath = join(stagingDir, "openings.jsonl");
          await Promise.all([
            writeFile(markdownPath, markdownContent, "utf8"),
            writeFile(jsonlPath, jsonlContent, "utf8"),
          ]);
          outputs.push(
            artifactDescriptor(marketDir, markdownPath, "text/markdown", markdownContent),
            artifactDescriptor(marketDir, jsonlPath, "application/x-ndjson", jsonlContent),
          );
        }

        await verifyArtifacts(marketDir, outputs);

        const generationManifest = {
          schemaVersion: 1,
          projectionId: "lab-openings",
          runId,
          status,
          scheduledAt,
          startedAt,
          completedAt,
          freshUntil,
          summary,
          outputs: outputs.map((output) => ({
            ...output,
            path: output.path.replace(relative(marketDir, stagingDir), "."),
          })),
        };
        await writeFile(
          join(stagingDir, "manifest.json"),
          `${JSON.stringify(generationManifest, null, 2)}\n`,
          "utf8",
        );
        await rename(stagingDir, generationDir);

        const finalOutputs = outputs.map((output) => ({
          ...output,
          path: output.path.replace(
            relative(marketDir, stagingDir),
            relative(marketDir, generationDir),
          ),
        }));
        const record: ProjectionRunRecord = {
          schemaVersion: 1,
          projectionId: "lab-openings",
          runId,
          trigger,
          scheduledAt,
          startedAt,
          completedAt,
          timezone,
          status,
          freshUntil,
          implementation: {
            name: "jobsradar",
            version: PACKAGE_VERSION,
            revision: IMPLEMENTATION_REVISION,
          },
          configuration: {
            path: relative(marketDir, targetsPath),
            sha256: sha256Hex(stableJson(targets)),
          },
          dependencies: boardRuns,
          outputs: finalOutputs,
          previousSuccessfulRun,
          diagnostics,
          repair: {
            cwd: projectDir,
            argv: ["bun", "run", "labs:openings", "--", "record"],
          },
        };

        await publishLegacyAttempt({
          marketDir,
          generationDir,
          runId,
          previousCurrentRun,
          scheduledAt,
          startedAt,
          completedAt,
          status,
          summary,
          boardRuns,
          diagnostics,
        });
        await options.beforeStateCommit?.(record);
        await freshnessStore.record(record);

        return {
          status,
          runId,
          startedAt,
          completedAt,
          record,
          generationDir,
          legacyWarnings: [],
        };
      } finally {
        await lock.handle.release();
      }
    },

    inspect(ids = ["lab-openings"]) {
      return freshnessStore.inspect(ids);
    },
  };
}
