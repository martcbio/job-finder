import type { z } from "zod";
import { atsApiBreaker, atsApiRateLimiter, isRetryableAts, withRetry } from "../../concurrency";
import type { AtsAcquisitionFailure, Fetcher } from "./types";

const JSON_HEADERS = {
  Accept: "application/json",
  "User-Agent": "job-finder-local/1.0",
};

interface FetchAtsResponseOptions {
  timeoutMs?: number;
  baseDelayMs?: number;
}

async function fetchWithTimeout(
  url: string,
  fetcher: Fetcher,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<Response>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(
        Object.assign(new Error(`ATS request timed out after ${timeoutMs}ms: ${url}`), {
          name: "TimeoutError",
          code: "ETIMEDOUT",
        }),
      );
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetcher(url, { headers: JSON_HEADERS, signal: controller.signal }),
      timeout,
    ]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function fetchAtsResponse(
  url: string,
  fetcher: Fetcher,
  onRetry: (attempt: number, err: unknown) => void,
  options: FetchAtsResponseOptions = {},
): Promise<Response> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  return atsApiRateLimiter.run(() =>
    atsApiBreaker.run(() =>
      withRetry(
        async () => {
          const res = await fetchWithTimeout(url, fetcher, timeoutMs);
          if (!res.ok) {
            const err = Object.assign(new Error(`HTTP ${res.status}: ${url}`), {
              status: res.status,
              statusText: res.statusText,
            });
            if (isRetryableAts(err)) throw err;
          }
          return res;
        },
        {
          maxRetries: 3,
          baseDelayMs: options.baseDelayMs ?? 1000,
          shouldRetry: isRetryableAts,
          onRetry,
        },
      ),
    ),
  );
}

type AtsJsonAcquisition<T> =
  | {
      status: "success";
      endpoint: string;
      attempts: number;
      durationMs: number;
      data: T;
    }
  | {
      status: "failure";
      attempts: number;
      durationMs: number;
      failure: AtsAcquisitionFailure;
    };

interface FetchAtsJsonOptions {
  now?: () => number;
  timeoutMs?: number;
  baseDelayMs?: number;
}

function errorStatus(error: unknown): number | undefined {
  if (error && typeof error === "object" && "status" in error) {
    const status = Number(error.status);
    return Number.isFinite(status) ? status : undefined;
  }
  return undefined;
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === "object" && "code" in error) {
    return String(error.code);
  }
  return null;
}

function errorStatusText(error: unknown): string {
  if (error && typeof error === "object" && "statusText" in error) {
    return String(error.statusText);
  }
  return "";
}

function pathSegment(value: PropertyKey): string | number {
  return typeof value === "number" ? value : String(value);
}

export async function fetchAtsJson<T>(
  endpoint: string,
  schema: z.ZodType<T>,
  fetcher: Fetcher,
  onRetry: (attempt: number, err: unknown) => void,
  options: FetchAtsJsonOptions = {},
): Promise<AtsJsonAcquisition<T>> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  let attempts = 0;

  let response: Response;
  try {
    response = await fetchAtsResponse(
      endpoint,
      async (url, init) => {
        attempts++;
        return fetcher(url, init);
      },
      onRetry,
      {
        ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        ...(options.baseDelayMs === undefined ? {} : { baseDelayMs: options.baseDelayMs }),
      },
    );
  } catch (error) {
    const status = errorStatus(error);
    if (status !== undefined) {
      return {
        status: "failure",
        attempts,
        durationMs: Math.max(0, now() - startedAt),
        failure: {
          kind: "http",
          endpoint,
          status,
          statusText: errorStatusText(error),
          retryable: isRetryableAts(error),
        },
      };
    }

    const normalized = error instanceof Error ? error : new Error(String(error));
    return {
      status: "failure",
      attempts,
      durationMs: Math.max(0, now() - startedAt),
      failure: {
        kind: "transport",
        endpoint,
        message: normalized.message,
        errorName: normalized.name,
        errorCode: errorCode(error),
        retryable: isRetryableAts(error),
      },
    };
  }

  if (!response.ok) {
    return {
      status: "failure",
      attempts,
      durationMs: Math.max(0, now() - startedAt),
      failure: {
        kind: "http",
        endpoint,
        status: response.status,
        statusText: response.statusText,
        retryable: false,
      },
    };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(await response.text());
  } catch (error) {
    return {
      status: "failure",
      attempts,
      durationMs: Math.max(0, now() - startedAt),
      failure: {
        kind: "parse",
        endpoint,
        contentType: response.headers.get("content-type"),
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "failure",
      attempts,
      durationMs: Math.max(0, now() - startedAt),
      failure: {
        kind: "schema",
        endpoint,
        issues: parsed.error.issues.map((issue) => ({
          code: issue.code,
          path: issue.path.map(pathSegment),
          message: issue.message,
        })),
      },
    };
  }

  return {
    status: "success",
    endpoint,
    attempts,
    durationMs: Math.max(0, now() - startedAt),
    data: parsed.data,
  };
}
