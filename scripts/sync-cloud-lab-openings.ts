import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  buildCloudLabSnapshot,
  type CloudLabOpening,
  type CloudLabRun,
} from "../src/pipeline/cloudLabSnapshot";

const REPO_ROOT = resolve(import.meta.dir, "..");
const API_BASE_URL = (process.env.OPPS_API_BASE_URL ?? "http://127.0.0.1:3737").replace(/\/$/, "");
const RUNS_DIR = resolve(
  process.env.LAB_OPENINGS_RUNS_DIR ?? resolve(REPO_ROOT, "../../../market/lab-openings/runs"),
);
const MAX_AGE_HOURS = positiveNumber(process.env.OPPS_MODAL_MAX_AGE_HOURS ?? "4");

const runsPayload = await fetchData<{
  status: "available" | "cloud_unavailable";
  rows?: CloudLabRun[];
  reason?: { message?: string };
}>("/api/cloud/runs?limit=30");
if (runsPayload.status !== "available" || !Array.isArray(runsPayload.rows)) {
  throw new Error(
    `Modal careers runs unavailable: ${runsPayload.reason?.message ?? runsPayload.status}`,
  );
}
const run = runsPayload.rows.find(
  (candidate) => candidate.substrate === "modal" && candidate.health === "complete",
);
if (!run) throw new Error("No complete Modal jobsradar run is available");
const ageHours = (Date.now() - new Date(run.completed_at).getTime()) / 3_600_000;
if (!Number.isFinite(ageHours) || ageHours < 0 || ageHours > MAX_AGE_HOURS) {
  throw new Error(
    `Latest complete Modal careers run is ${ageHours.toFixed(1)}h old; maximum is ${MAX_AGE_HOURS}h`,
  );
}

const query = new URLSearchParams({
  run_id: run.run_id,
  limit: "2000",
  include_raw: "1",
  workable_locations_only: "1",
});
const openingsPayload = await fetchData<{
  status: "available" | "cloud_unavailable";
  rows?: CloudLabOpening[];
  reason?: { message?: string };
}>(`/api/cloud/openings?${query}`);
if (openingsPayload.status !== "available" || !Array.isArray(openingsPayload.rows)) {
  throw new Error(
    `Modal careers openings unavailable: ${
      openingsPayload.reason?.message ?? openingsPayload.status
    }`,
  );
}

const snapshot = buildCloudLabSnapshot(run, openingsPayload.rows);
const finalDirectory = resolve(RUNS_DIR, run.run_id);
const temporaryDirectory = resolve(RUNS_DIR, `.${run.run_id}.sync-${process.pid}`);
await mkdir(RUNS_DIR, { recursive: true });
try {
  const existingStatus = JSON.parse(await readFile(resolve(finalDirectory, "status.json"), "utf8")) as {
    runId?: string;
    status?: string;
  };
  if (existingStatus.runId !== run.run_id || existingStatus.status !== "complete") {
    throw new Error(`Existing cloud snapshot ${finalDirectory} is incomplete or inconsistent`);
  }
  process.stdout.write(
    `${JSON.stringify({ source: "modal", runId: run.run_id, rows: snapshot.rows.length, reused: true })}\n`,
  );
  process.exit(0);
} catch (error) {
  if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) {
    throw error;
  }
}

await rm(temporaryDirectory, { recursive: true, force: true });
await mkdir(temporaryDirectory);
try {
  await Promise.all([
    writeFile(
      resolve(temporaryDirectory, "status.json"),
      `${JSON.stringify(snapshot.status, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      resolve(temporaryDirectory, "openings.jsonl"),
      `${snapshot.rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    ),
  ]);
  await rename(temporaryDirectory, finalDirectory);
} catch (error) {
  await rm(temporaryDirectory, { recursive: true, force: true });
  throw error;
}

process.stdout.write(
  `${JSON.stringify({ source: "modal", runId: run.run_id, rows: snapshot.rows.length, reused: false })}\n`,
);

async function fetchData<T>(path: string): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`Opportunity API ${path} returned HTTP ${response.status}`);
  const payload = (await response.json()) as { ok?: boolean; data?: T };
  if (payload.ok !== true || payload.data === undefined) {
    throw new Error(`Opportunity API ${path} returned an invalid envelope`);
  }
  return payload.data;
}

function positiveNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("OPPS_MODAL_MAX_AGE_HOURS must be a positive number");
  }
  return parsed;
}
