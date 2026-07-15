import { config } from "../config";
import { runPsqlJson } from "../db/psql";
import { runQueueRefresh } from "../pipeline/queueRefresh";
import type { JobFinderApiOptions } from "./context";
import { errorResponse } from "./errors";
import { handleApiRequest } from "./handlers";
import { buildCorsHeaders, parsePort, trimTrailingSlash } from "./http";

export type {
  ApiFetch,
  ApiQuery,
  CloudConfig,
  FastRefreshRunner,
  JobFinderApiOptions,
} from "./context";
export { ApiError } from "./errors";

export function createJobFinderApiHandler(
  options: JobFinderApiOptions = {},
): (request: Request) => Promise<Response> {
  const context = {
    query: options.query ?? ((sql) => runPsqlJson(sql)),
    fastRefresh: options.fastRefresh ?? ((fastOptions) => runQueueRefresh(fastOptions)),
    env: options.env ?? process.env,
    now: options.now ?? (() => new Date()),
    allowOrigins: options.allowOrigins ?? ["http://localhost:3000", "http://localhost:5173"],
    cloudConfig: options.cloudConfig ?? {
      supabaseUrl: config.supabaseUrl,
      supabaseServiceKey: config.supabaseServiceKey,
    },
    fetch: options.fetch ?? globalThis.fetch,
  };

  return async (request) => {
    const origin = request.headers.get("origin");
    const corsHeaders = buildCorsHeaders(origin, context.allowOrigins);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    try {
      const url = new URL(request.url);
      const response = await handleApiRequest(
        request,
        {
          method: request.method.toUpperCase(),
          path: trimTrailingSlash(url.pathname),
          params: {},
          search: url.searchParams,
        },
        context,
      );
      for (const [name, value] of Object.entries(corsHeaders)) response.headers.set(name, value);
      return response;
    } catch (err) {
      const response = errorResponse(err);
      for (const [name, value] of Object.entries(corsHeaders)) response.headers.set(name, value);
      return response;
    }
  };
}

export function serveJobFinderApi(
  options: JobFinderApiOptions & { port?: number; hostname?: string } = {},
): ReturnType<typeof Bun.serve> {
  const port = options.port ?? parsePort(options.env ?? process.env);
  const hostname = options.hostname ?? "127.0.0.1";
  return Bun.serve({
    hostname,
    port,
    fetch: createJobFinderApiHandler(options),
  });
}
