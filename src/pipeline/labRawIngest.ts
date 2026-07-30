import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { listOrgJobs as listAshbyOrgJobs } from "../services/ats/ashby";
import { listOrgJobs as listGreenhouseOrgJobs } from "../services/ats/greenhouse";
import { listOrgJobs as listLeverOrgJobs } from "../services/ats/lever";
import type { AtsAcquisitionFailure, AtsOrgAcquisition, AtsOrgJob } from "../services/ats/types";
import {
  ingestNormalizedJobs,
  type NormalizedJobIngestInput,
  type NormalizedJobIngestResult,
  type NormalizedJobInput,
} from "./normalizedJobIngest";

type AtsKind = "ashby" | "greenhouse" | "lever";
type LabBoardLister = (org: string) => Promise<AtsOrgAcquisition>;

const targetSchema = z.record(
  z.string(),
  z.object({
    ats: z.enum(["ashby", "greenhouse", "lever"]).nullable(),
    company: z.string(),
  }),
);

interface LabRawOpening extends AtsOrgJob {
  company: string;
}

interface LabRawBoardReceipt {
  org: string;
  company: string;
  ats: AtsKind | null;
  status: "complete" | "failed" | "skipped";
  endpoint: string | null;
  discovered: number;
  attempts: number;
  elapsedMs: number;
  error: string | null;
}

export interface LabRawIngestInput {
  marketDir: string;
  timeoutMs?: number;
  now?: () => Date;
  makeRunId?: () => string;
  listers?: Record<AtsKind, LabBoardLister>;
  persist?: (input: NormalizedJobIngestInput) => Promise<NormalizedJobIngestResult>;
}

export interface LabRawIngestResult {
  id: "lab-ats";
  label: "Lab ATS";
  status: "complete" | "degraded" | "failed";
  runId: number | null;
  evidenceRunId: string;
  discovered: number;
  imported: number;
  evidencePath: string;
  receiptPath: string;
  boards: LabRawBoardReceipt[];
  errors: string[];
  elapsedMs: number;
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

function rawHealth(boards: LabRawBoardReceipt[]): "complete" | "degraded" | "failed" {
  const configured = boards.filter((board) => board.ats !== null);
  const completed = configured.filter((board) => board.status === "complete").length;
  if (completed === 0) return "failed";
  return completed === configured.length ? "complete" : "degraded";
}

function descriptionFromRaw(raw: unknown): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return "";
  const record = raw as Record<string, unknown>;
  for (const key of ["descriptionPlain", "descriptionBodyPlain", "content", "description"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function employmentTypeFromRaw(raw: unknown): string | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const categories = record.categories;
  if (categories && typeof categories === "object" && !Array.isArray(categories)) {
    const commitment = (categories as Record<string, unknown>).commitment;
    if (typeof commitment === "string" && commitment.trim()) return commitment.trim();
  }
  return null;
}

export function labRawOpeningToNormalizedJob(opening: LabRawOpening): NormalizedJobInput {
  return {
    sourceId: "lab-ats",
    sourceLabel: "Lab ATS",
    searchLabel: opening.company,
    searchTerm: opening.org,
    title: opening.title ?? "Untitled role",
    company: opening.company,
    url: opening.url,
    sourceUrl: opening.url,
    description: descriptionFromRaw(opening.raw),
    location:
      opening.locations.length > 0 ? opening.locations.join("; ") : opening.location || null,
    employmentType: employmentTypeFromRaw(opening.raw),
    compensation: null,
    raw: opening.raw,
  };
}

function evidenceJsonl(openings: LabRawOpening[]): string {
  if (openings.length === 0) return "";
  return `${openings
    .map((opening) =>
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
        raw: opening.raw,
      }),
    )
    .join("\n")}\n`;
}

export async function runLabRawIngest(input: LabRawIngestInput): Promise<LabRawIngestResult> {
  const started = Date.now();
  const now = input.now ?? (() => new Date());
  const evidenceRunId = input.makeRunId?.() ?? `${now().toISOString()}_${randomUUID()}`;
  const timeoutMs = input.timeoutMs ?? 20_000;
  const listers =
    input.listers ??
    ({
      ashby: (org) => listAshbyOrgJobs(org),
      greenhouse: (org) => listGreenhouseOrgJobs(org),
      lever: (org) => listLeverOrgJobs(org),
    } satisfies Record<AtsKind, LabBoardLister>);
  const persist = input.persist ?? ingestNormalizedJobs;
  const targets = targetSchema.parse(
    JSON.parse(await readFile(join(input.marketDir, "targets.json"), "utf8")),
  );
  const openings: LabRawOpening[] = [];
  const boards: LabRawBoardReceipt[] = [];

  for (const [org, target] of Object.entries(targets)) {
    if (!target.ats) {
      boards.push({
        org,
        company: target.company,
        ats: null,
        status: "skipped",
        endpoint: null,
        discovered: 0,
        attempts: 0,
        elapsedMs: 0,
        error: null,
      });
      continue;
    }
    const boardStarted = Date.now();
    let acquisition: AtsOrgAcquisition;
    try {
      acquisition = await listers[target.ats](org);
    } catch (error) {
      acquisition = {
        status: "failure",
        attempts: 1,
        durationMs: Date.now() - boardStarted,
        failure: {
          kind: "transport",
          endpoint: `${target.ats}:${org}`,
          message: error instanceof Error ? error.message : String(error),
          errorName: error instanceof Error ? error.name : "Error",
          errorCode: null,
          retryable: false,
        },
      };
    }
    if (acquisition.status === "failure") {
      boards.push({
        org,
        company: target.company,
        ats: target.ats,
        status: "failed",
        endpoint: acquisition.failure.endpoint,
        discovered: 0,
        attempts: acquisition.attempts,
        elapsedMs: acquisition.durationMs,
        error: failureMessage(acquisition.failure),
      });
      continue;
    }
    openings.push(...acquisition.jobs.map((job) => ({ ...job, company: target.company })));
    boards.push({
      org,
      company: target.company,
      ats: target.ats,
      status: "complete",
      endpoint: acquisition.endpoint,
      discovered: acquisition.jobs.length,
      attempts: acquisition.attempts,
      elapsedMs: acquisition.durationMs,
      error: null,
    });
  }

  openings.sort((left, right) =>
    `${left.company} ${left.title} ${left.id}`.localeCompare(
      `${right.company} ${right.title} ${right.id}`,
    ),
  );
  const rootDir = join(input.marketDir, "lab-raw-ingest");
  const stagingDir = join(rootDir, ".staging", evidenceRunId);
  const generationDir = join(rootDir, "runs", evidenceRunId);
  const evidencePath = join(generationDir, "openings.jsonl");
  const receiptPath = join(generationDir, "receipt.json");
  await mkdir(join(rootDir, ".staging"), { recursive: true });
  await mkdir(stagingDir, { recursive: false });
  await writeFile(join(stagingDir, "openings.jsonl"), evidenceJsonl(openings), "utf8");

  let status = rawHealth(boards);
  let runId: number | null = null;
  let imported = 0;
  const errors = boards.flatMap((board) =>
    board.error ? [`${board.company}: ${board.error}`] : [],
  );
  if (openings.length > 0) {
    try {
      const persisted = await persist({
        sourceId: "lab-ats",
        sourceLabel: "Lab ATS",
        keyword: "lab-ats",
        jobs: openings.map(labRawOpeningToNormalizedJob),
        timeoutMs,
      });
      runId = persisted.runId;
      imported = persisted.jobsPersisted;
      errors.push(...persisted.errors.map((error) => `${error.title}: ${error.error}`));
      if (persisted.errors.length > 0) {
        status = persisted.jobsPersisted > 0 ? "degraded" : "failed";
      }
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      status = "failed";
    }
  }

  const result: LabRawIngestResult = {
    id: "lab-ats",
    label: "Lab ATS",
    status,
    runId,
    evidenceRunId,
    discovered: openings.length,
    imported,
    evidencePath,
    receiptPath,
    boards,
    errors,
    elapsedMs: Date.now() - started,
  };
  await writeFile(join(stagingDir, "receipt.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  await mkdir(join(rootDir, "runs"), { recursive: true });
  try {
    await rename(stagingDir, generationDir);
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return result;
}
