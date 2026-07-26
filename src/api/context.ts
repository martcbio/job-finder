import type { CvStageResult } from "../cv/stageApplicationCv";
import type { FastRefreshOptions, FastRefreshResult } from "../pipeline/fastRefresh";
import type { OpportunityReport } from "../pipeline/opportunityReport";

export type ApiQuery = <T>(sql: string) => Promise<T>;

export type FastRefreshRunner = (
  options: Partial<FastRefreshOptions>,
) => Promise<FastRefreshResult>;

export interface CloudConfig {
  supabaseUrl?: string;
  supabaseServiceKey?: string;
}

export type ApiFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export type ApplicationCvStageRunner = (
  context: ApiContext,
  applicationId: string,
) => Promise<CvStageResult>;

export type OpportunityReportLoader = (options: {
  limit: number;
  now: Date;
}) => Promise<OpportunityReport>;

export interface ApiContext {
  query: ApiQuery;
  fastRefresh: FastRefreshRunner;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  allowOrigins: string[];
  cloudConfig: CloudConfig;
  fetch: ApiFetch;
  stageCv?: ApplicationCvStageRunner;
  opportunityReport?: OpportunityReportLoader;
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
  stageCv?: ApplicationCvStageRunner;
  opportunityReport?: OpportunityReportLoader;
}
