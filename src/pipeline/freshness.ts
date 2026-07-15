import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

export const PROJECTION_IDS = ["lab-openings"] as const;
export type ProjectionId = (typeof PROJECTION_IDS)[number];

export const PROJECTION_RUN_STATUSES = ["complete", "degraded", "failed"] as const;
export type ProjectionRunStatus = (typeof PROJECTION_RUN_STATUSES)[number];

const repairCommandSchema = z.object({
  cwd: z.string().min(1),
  argv: z.array(z.string().min(1)).min(1),
});

const outputArtifactSchema = z.object({
  path: z.string().min(1),
  mediaType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});

export const projectionRunRecordSchema = z.object({
  schemaVersion: z.literal(1),
  projectionId: z.enum(PROJECTION_IDS),
  runId: z.string().min(1),
  trigger: z.enum(["manual", "scheduled"]),
  scheduledAt: z.string().datetime(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime(),
  timezone: z.string().min(1),
  status: z.enum(PROJECTION_RUN_STATUSES),
  freshUntil: z.string().datetime().nullable(),
  implementation: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    revision: z.string().min(1),
  }),
  configuration: z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  dependencies: z.array(z.unknown()),
  outputs: z.array(outputArtifactSchema),
  previousSuccessfulRun: z.string().min(1).nullable(),
  diagnostics: z.array(z.string()),
  repair: repairCommandSchema,
});

export type RepairCommand = z.infer<typeof repairCommandSchema>;
export type OutputArtifact = z.infer<typeof outputArtifactSchema>;
export type ProjectionRunRecord = z.infer<typeof projectionRunRecordSchema>;

const runReferenceSchema = z.object({
  runId: z.string().min(1),
  status: z.enum(PROJECTION_RUN_STATUSES),
  completedAt: z.string().datetime(),
  recordPath: z.string().min(1),
});

const projectionStateSchema = z.object({
  schemaVersion: z.literal(1),
  projectionId: z.enum(PROJECTION_IDS),
  updatedAt: z.string().datetime(),
  latestAttempt: runReferenceSchema.nullable(),
  current: runReferenceSchema.nullable(),
  lastHealthy: runReferenceSchema.nullable(),
});

type ProjectionRunReference = z.infer<typeof runReferenceSchema>;
type ProjectionState = z.infer<typeof projectionStateSchema>;

export type FreshnessDiagnosisCode =
  | "healthy"
  | "degraded"
  | "latest_attempt_failed"
  | "stale"
  | "never_published"
  | "manifest_corrupt";

export interface ProjectionFreshnessInspection {
  projectionId: ProjectionId;
  diagnosis: {
    code: FreshnessDiagnosisCode;
    severity: "ok" | "warning" | "error";
    message: string;
    causes: string[];
  };
  latestAttempt: ProjectionRunRecord | null;
  current: ProjectionRunRecord | null;
  lastHealthy: ProjectionRunRecord | null;
  repair: RepairCommand;
}

export interface FreshnessReport {
  checkedAt: string;
  projections: ProjectionFreshnessInspection[];
}

export interface FreshnessStore {
  record(run: ProjectionRunRecord): Promise<void>;
  inspect(ids?: ProjectionId[]): Promise<FreshnessReport>;
}

interface FreshnessStoreOptions {
  rootDir: string;
  repairs: Record<ProjectionId, RepairCommand>;
  now?: () => Date;
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return undefined;
}

async function readJsonIfPresent(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rename(temporaryPath, path);
  } catch (error) {
    try {
      const { rm } = await import("node:fs/promises");
      await rm(temporaryPath, { force: true });
    } catch {
      // Preserve the publication error. A leftover temp file is not authoritative state.
    }
    throw error;
  }
}

function runReference(run: ProjectionRunRecord, recordPath: string): ProjectionRunReference {
  return {
    runId: run.runId,
    status: run.status,
    completedAt: run.completedAt,
    recordPath,
  };
}

async function readRun(rootDir: string, reference: ProjectionRunReference | null) {
  if (!reference) return null;
  const absolutePath = join(rootDir, reference.recordPath);
  const raw = await readJsonIfPresent(absolutePath);
  if (raw === null) throw new Error(`Missing run record: ${absolutePath}`);
  return projectionRunRecordSchema.parse(raw);
}

function corruptInspection(
  projectionId: ProjectionId,
  repair: RepairCommand,
  message: string,
): ProjectionFreshnessInspection {
  return {
    projectionId,
    diagnosis: {
      code: "manifest_corrupt",
      severity: "error",
      message,
      causes: [message],
    },
    latestAttempt: null,
    current: null,
    lastHealthy: null,
    repair,
  };
}

function diagnose(
  projectionId: ProjectionId,
  repair: RepairCommand,
  now: Date,
  latestAttempt: ProjectionRunRecord | null,
  current: ProjectionRunRecord | null,
  lastHealthy: ProjectionRunRecord | null,
): ProjectionFreshnessInspection {
  if (!current) {
    return {
      projectionId,
      diagnosis: {
        code: "never_published",
        severity: "error",
        message: "No usable lab-opening generation has been published yet.",
        causes: latestAttempt?.diagnostics ?? [],
      },
      latestAttempt,
      current,
      lastHealthy,
      repair,
    };
  }

  const stale = current.freshUntil !== null && new Date(current.freshUntil).getTime() < now.getTime();
  if (latestAttempt?.status === "failed" && latestAttempt.runId !== current.runId) {
    const causes = [...latestAttempt.diagnostics];
    if (stale) causes.push(`The current generation expired at ${current.freshUntil}.`);
    return {
      projectionId,
      diagnosis: {
        code: "latest_attempt_failed",
        severity: "error",
        message:
          "The latest run had no successful ATS acquisitions. The previous generation remains current.",
        causes,
      },
      latestAttempt,
      current,
      lastHealthy,
      repair,
    };
  }

  if (latestAttempt?.status === "degraded" && latestAttempt.runId !== current.runId) {
    const causes = [...latestAttempt.diagnostics];
    if (stale) causes.push(`The retained generation expired at ${current.freshUntil}.`);
    return {
      projectionId,
      diagnosis: {
        code: "degraded",
        severity: "warning",
        message:
          "The latest run had one or more failed ATS acquisitions. The previous complete generation remains current.",
        causes,
      },
      latestAttempt,
      current,
      lastHealthy,
      repair,
    };
  }

  if (stale) {
    return {
      projectionId,
      diagnosis: {
        code: "stale",
        severity: "error",
        message: `The current generation expired at ${current.freshUntil}.`,
        causes: current.diagnostics,
      },
      latestAttempt,
      current,
      lastHealthy,
      repair,
    };
  }

  if (current.status === "degraded") {
    return {
      projectionId,
      diagnosis: {
        code: "degraded",
        severity: "warning",
        message: "The current generation was published with one or more failed ATS acquisitions.",
        causes: current.diagnostics,
      },
      latestAttempt,
      current,
      lastHealthy,
      repair,
    };
  }

  return {
    projectionId,
    diagnosis: {
      code: "healthy",
      severity: "ok",
      message: `The current generation is complete and remains fresh until ${current.freshUntil}.`,
      causes: [],
    },
    latestAttempt,
    current,
    lastHealthy,
    repair,
  };
}

export function createFreshnessStore(options: FreshnessStoreOptions): FreshnessStore {
  const now = options.now ?? (() => new Date());

  return {
    async record(input) {
      const run = projectionRunRecordSchema.parse(input);
      const projectionDir = join(options.rootDir, run.projectionId);
      const recordPath = join("runs", `${run.runId}.json`);
      const absoluteRecordPath = join(projectionDir, recordPath);
      await writeJsonAtomic(absoluteRecordPath, run);

      const statePath = join(projectionDir, "state.json");
      const rawState = await readJsonIfPresent(statePath);
      const previousState = rawState === null ? null : projectionStateSchema.parse(rawState);
      const reference = runReference(run, relative(options.rootDir, absoluteRecordPath));
      const nextState: ProjectionState = {
        schemaVersion: 1,
        projectionId: run.projectionId,
        updatedAt: now().toISOString(),
        latestAttempt: reference,
        current: run.status === "complete" ? reference : (previousState?.current ?? null),
        lastHealthy:
          run.status === "complete" ? reference : (previousState?.lastHealthy ?? null),
      };
      await writeJsonAtomic(statePath, nextState);
    },

    async inspect(ids = [...PROJECTION_IDS]) {
      const checkedAt = now().toISOString();
      const projections = await Promise.all(
        ids.map(async (projectionId): Promise<ProjectionFreshnessInspection> => {
          const repair = options.repairs[projectionId];
          const statePath = join(options.rootDir, projectionId, "state.json");
          try {
            const rawState = await readJsonIfPresent(statePath);
            if (rawState === null) {
              return diagnose(projectionId, repair, now(), null, null, null);
            }
            const state = projectionStateSchema.parse(rawState);
            const [latestAttempt, current, lastHealthy] = await Promise.all([
              readRun(options.rootDir, state.latestAttempt),
              readRun(options.rootDir, state.current),
              readRun(options.rootDir, state.lastHealthy),
            ]);
            return diagnose(
              projectionId,
              repair,
              now(),
              latestAttempt,
              current,
              lastHealthy,
            );
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return corruptInspection(
              projectionId,
              repair,
              `Could not read the freshness manifest: ${message}`,
            );
          }
        }),
      );
      return { checkedAt, projections };
    },
  };
}
