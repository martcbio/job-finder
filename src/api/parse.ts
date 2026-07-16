import { z } from "zod/v4";
import {
  APPLICATION_STATUSES,
  type ApplicationStatus,
  isApplicationStatus,
} from "../pipeline/jobApplications";
import { type DuplicateCandidateState, isDuplicateCandidateState } from "../pipeline/jobDuplicates";
import {
  isReviewActor,
  isReviewState,
  REVIEW_ACTORS,
  REVIEW_STATES,
  type ReviewActor,
  type ReviewState,
} from "../pipeline/jobReview";
import { isPipelineStepName, type PipelineStepName } from "../pipeline/pipelinePlan";
import { isTimeFilter, type TimeFilter } from "../pipeline/searchEngines";
import { parseSourceLaneIds, SOURCE_LANES } from "../pipeline/sourceLanes";
import { DEFAULT_QUEUE_STATES } from "./constants";
import { ApiError } from "./errors";
import { fastRefreshSourceId } from "./refreshApi";

const MAX_POSTGRES_BIGINT = 9_223_372_036_854_775_807n;
const isoTimestamp = z.iso.datetime({ offset: true });

export async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    throw new ApiError(415, "unsupported_media_type", "POST requests must use application/json");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "invalid_body", "Request body must be a JSON object");
  }
  return parsed as Record<string, unknown>;
}

export function firstRecord(value: unknown[]): Record<string, unknown> {
  const first = value[0];
  return first && typeof first === "object" && !Array.isArray(first)
    ? (first as Record<string, unknown>)
    : {};
}

export function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

export function stringOrNumberField(value: unknown): string | number | null {
  if (typeof value === "string" || typeof value === "number") return value;
  return null;
}
export function reviewStatesFromSearch(search: URLSearchParams): ReviewState[] {
  const values = search.getAll("state").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (values.length === 0) return [...DEFAULT_QUEUE_STATES];
  return [...new Set(values.map((value) => requiredReviewState(value, "state")))];
}

export function sourceIdsFromSearch(search: URLSearchParams): string[] | undefined {
  const values = search.getAll("source").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (values.length === 0) return undefined;
  return [...new Set(values.map((value) => fastRefreshSourceId(value)))];
}

export function nullableReviewState(value: string | null): ReviewState | null {
  if (value === null || value === "") return null;
  return requiredReviewState(value, "state");
}

export function requiredReviewState(value: unknown, field: string): ReviewState {
  const text = requiredString(value, field);
  if (!isReviewState(text)) {
    throw new ApiError(400, "invalid_review_state", `Unsupported review state "${text}"`, {
      valid: REVIEW_STATES,
    });
  }
  return text;
}

export function optionalActor(value: unknown, fallback: ReviewActor): ReviewActor {
  if (value === undefined || value === null || value === "") return fallback;
  const text = requiredString(value, "actor");
  if (!isReviewActor(text)) {
    throw new ApiError(400, "invalid_actor", `Unsupported review actor "${text}"`, {
      valid: REVIEW_ACTORS,
    });
  }
  return text;
}

export function nullableApplicationStatus(value: string | null): ApplicationStatus | null {
  if (value === null || value === "") return null;
  return optionalApplicationStatus(value, "applied");
}

export function optionalApplicationStatus(
  value: unknown,
  fallback: ApplicationStatus,
): ApplicationStatus {
  if (value === undefined || value === null || value === "") return fallback;
  const text = requiredString(value, "status");
  if (!isApplicationStatus(text)) {
    throw new ApiError(
      400,
      "invalid_application_status",
      `Unsupported application status "${text}"`,
      {
        valid: APPLICATION_STATUSES,
      },
    );
  }
  return text;
}

export function requiredCvReviewStatus(value: unknown): "approved" | "rejected" | "superseded" {
  const status = requiredString(value, "status");
  if (status !== "approved" && status !== "rejected" && status !== "superseded") {
    throw new ApiError(
      400,
      "invalid_cv_draft_status",
      'status must be "approved", "rejected", or "superseded"',
    );
  }
  return status;
}

export function requiredDuplicateReviewState(
  value: unknown,
): Exclude<DuplicateCandidateState, "suggested"> {
  const state = requiredString(value, "state");
  if (!isDuplicateCandidateState(state) || state === "suggested") {
    throw new ApiError(
      400,
      "invalid_duplicate_candidate_state",
      'state must be "confirmed_same", "confirmed_distinct", or "ignored"',
    );
  }
  return state;
}

export function optionalTimeFilter(
  value: string | null | undefined,
  fallback: TimeFilter,
): TimeFilter {
  const timeFilter = value ?? fallback;
  if (!isTimeFilter(timeFilter)) {
    throw new ApiError(400, "invalid_time_filter", `Unsupported time filter "${timeFilter}"`);
  }
  return timeFilter;
}

export function pipelineSteps(values: string[]): PipelineStepName[] {
  const steps: PipelineStepName[] = [];
  for (const value of values) {
    if (!isPipelineStepName(value)) {
      throw new ApiError(400, "invalid_pipeline_step", `Unsupported pipeline step "${value}"`);
    }
    steps.push(value);
  }
  return [...new Set(steps)];
}

export function parseApiSourceLaneIds(value: unknown): ReturnType<typeof parseSourceLaneIds> {
  if (value === undefined || value === null) return parseSourceLaneIds([]);
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_field", "sourceLanes must be an array of strings");
  }

  try {
    return parseSourceLaneIds(value.map((item) => requiredString(item, "sourceLanes")));
  } catch (err) {
    throw new ApiError(
      400,
      "invalid_source_lane",
      err instanceof Error ? err.message : "Unsupported source lane",
      { valid: SOURCE_LANES.map((lane) => lane.id) },
    );
  }
}

export function positiveIntParam(
  search: URLSearchParams,
  name: string,
  fallback: number,
  max: number,
): number {
  return positiveIntValue(search.get(name), name, fallback, max);
}

export function nullablePositiveInt(value: string | null, name: string): number | null {
  if (value === null || value === "") return null;
  return positiveIntValue(value, name, 1, Number.MAX_SAFE_INTEGER);
}

export function positiveIntValue(
  value: unknown,
  name: string,
  fallback: number,
  max: number,
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed =
    typeof value === "number" ? value : Number.parseInt(requiredString(value, name), 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > max) {
    throw new ApiError(
      400,
      "invalid_positive_integer",
      `${name} must be a positive integer up to ${max}`,
    );
  }
  return parsed;
}

export function positiveFloatValue(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number.parseFloat(requiredString(value, name));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new ApiError(
      400,
      "invalid_ratio",
      `${name} must be greater than 0 and less than or equal to 1`,
    );
  }
  return parsed;
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_field", `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

export function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", `${field} must be a string when provided`);
  }
  return value;
}

export function nullableIntegerString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", `${field} must be an integer string when provided`);
  }
  const text = value.trim();
  if (!/^[1-9]\d*$/.test(text) || BigInt(text) > MAX_POSTGRES_BIGINT) {
    throw new ApiError(400, "invalid_field", `${field} must be a positive bigint string`);
  }
  return text;
}

export function nullableIsoTimestamp(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !isoTimestamp.safeParse(value).success) {
    throw new ApiError(400, "invalid_field", `${field} must be an ISO timestamp when provided`);
  }
  return value;
}

export function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", "Expected a string value");
  }
  return value;
}

export function nonEmptyStringArray(value: unknown, field: string, fallback: string[]): string[] {
  if (value === undefined || value === null) return fallback;
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_field", `${field} must be an array of strings`);
  }
  const values = value.map((item) => requiredString(item, field));
  if (values.length === 0) {
    throw new ApiError(400, "invalid_field", `${field} must not be empty`);
  }
  return values;
}

export function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string")
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_field", `${field} must be a string or array of strings`);
  }
  return value.map((item) => requiredString(item, field));
}

export function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ApiError(400, "invalid_field", "Expected a boolean value");
  }
  return value;
}
