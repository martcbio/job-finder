import { PsqlError } from "../db/psql";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

export function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

export function errorDetails(err: unknown): unknown {
  if (err instanceof PsqlError) {
    return {
      message: err.message,
      exitCode: err.exitCode,
      stderr: err.result.stderr,
      stdout: err.result.stdout,
    };
  }
  if (err instanceof Error) {
    return { message: err.message, name: err.name };
  }
  return err;
}

export function errorResponse(err: unknown): Response {
  if (err instanceof ApiError) {
    return jsonResponse(errorBody(err.code, err.message, err.details), err.status);
  }
  if (err instanceof PsqlError) {
    return jsonResponse(errorBody("database_error", err.message, errorDetails(err)), 500);
  }
  if (err instanceof Error) {
    return jsonResponse(errorBody("internal_error", err.message), 500);
  }
  return jsonResponse(errorBody("internal_error", "Unknown internal error"), 500);
}
