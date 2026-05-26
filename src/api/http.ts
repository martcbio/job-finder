import { DEFAULT_PORT } from "./constants";
import { ApiError } from "./errors";

export function trimTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

export function matchPath(path: string, pattern: string): Record<string, string> | null {
  const pathParts = path.split("/").filter(Boolean);
  const patternParts = pattern.split("/").filter(Boolean);
  if (pathParts.length !== patternParts.length) return null;
  const params: Record<string, string> = {};
  for (let index = 0; index < patternParts.length; index++) {
    const expected = patternParts[index];
    const actual = pathParts[index];
    if (!expected || !actual) return null;
    if (expected.startsWith(":")) {
      params[expected.slice(1)] = decodeURIComponent(actual);
      continue;
    }
    if (expected !== actual) return null;
  }
  return params;
}

export function pathParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError(500, "route_param_missing", `Route parameter ${name} was not captured`);
  }
  return value;
}

export function buildCorsHeaders(
  origin: string | null,
  allowOrigins: string[],
): Record<string, string> {
  const allowOrigin = origin && allowOrigins.includes(origin) ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

export function parsePort(env: NodeJS.ProcessEnv): number {
  const value = env.JOB_FINDER_API_PORT;
  if (!value) return DEFAULT_PORT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("JOB_FINDER_API_PORT must be a valid TCP port");
  }
  return parsed;
}
