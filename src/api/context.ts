import type { FastRefreshOptions, FastRefreshResult } from "../pipeline/fastRefresh";

export type ApiQuery = <T>(sql: string) => Promise<T>;

export type FastRefreshRunner = (
  options: Partial<FastRefreshOptions>,
) => Promise<FastRefreshResult>;

export interface ApiContext {
  query: ApiQuery;
  fastRefresh: FastRefreshRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  allowOrigins: string[];
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
}
