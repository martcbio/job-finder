import type { FastRefreshOptions, FastRefreshResult } from "../pipeline/fastRefresh";

export type ApiQuery = <T>(sql: string) => Promise<T>;

export type FastRefreshRunner = (
  options: Partial<FastRefreshOptions>,
) => Promise<FastRefreshResult>;

export interface CloudConfig {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

export type ApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface ApiContext {
  query: ApiQuery;
  fastRefresh: FastRefreshRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  allowOrigins: string[];
  cloudConfig: CloudConfig;
  fetch: ApiFetch;
}

export interface ApiRoute {
  method: string;
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
}

export interface JobFinderApiOptions {
  query?: ApiQuery;
  fastRefresh?: FastRefreshRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  allowOrigins?: string[];
  cloudConfig?: CloudConfig;
  fetch?: ApiFetch;
}
