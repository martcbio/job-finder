import { quoteSqlLiteral } from "../db/config";
import { PsqlError, runPsqlJson } from "../db/psql";
import {
  buildApprovedBulletInsertSql,
  buildCvDraftSourceSql,
  buildInsertCvDraftSql,
  buildReviewCvDraftSql,
  type CvDraftJobRow,
  type CvDraftReviewRow,
  renderCvDraftMarkdown,
} from "../pipeline/cvDraft";
import {
  APPLICATION_STATUSES,
  type ApplicationListRow,
  type ApplicationStatus,
  buildListApplicationsSql,
  buildRecordApplicationSql,
  isApplicationStatus,
  type RecordedApplicationRow,
} from "../pipeline/jobApplications";
import {
  buildReviewDuplicateCandidateSql,
  DUPLICATE_CANDIDATE_STATES,
  type DuplicateCandidateReviewRow,
  type DuplicateCandidateState,
  isDuplicateCandidateState,
} from "../pipeline/jobDuplicates";
import { buildJobsExportSql, type JobExportRow } from "../pipeline/jobExport";
import {
  buildReviewEventsSql,
  buildReviewTransitionSql,
  isReviewActor,
  isReviewState,
  REVIEW_ACTORS,
  REVIEW_STATES,
  type ReviewActor,
  type ReviewState,
  type ReviewTransitionRow,
} from "../pipeline/jobReview";
import { buildReviewQueueSql, type ReviewQueueRow } from "../pipeline/jobReviewQueue";
import {
  buildPipelinePlan,
  isPipelineStepName,
  type PipelinePlanOptions,
  type PipelineStepName,
  shellQuoteArgs,
} from "../pipeline/pipelinePlan";
import { buildPipelineHistorySql, type PipelineHistoryRow } from "../pipeline/pipelineRun";
import {
  buildGetSavedSweepSql,
  buildListSavedSweepsSql,
  buildUpsertSavedSweepSql,
  type SavedSweepInput,
  type SavedSweepRow,
  savedSweepToPipelineOptions,
} from "../pipeline/savedSweeps";
import { type BrianTimeFilter, isBrianTimeFilter } from "../pipeline/searchEngines";
import { buildSourceHealthSql, type SourceHealthRow } from "../pipeline/sourceHealth";

export type ApiQuery = <T>(sql: string) => Promise<T>;

export interface JobFinderApiOptions {
  query?: ApiQuery;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  allowOrigins?: string[];
}

interface ApiContext {
  query: ApiQuery;
  env: NodeJS.ProcessEnv;
  now: () => Date;
  allowOrigins: string[];
}

interface ApiRoute {
  method: string;
  path: string;
  params: Record<string, string>;
  search: URLSearchParams;
}

interface PipelineRunRequest {
  sweepName?: string;
  keywords?: string[];
  sites?: string[];
  timeFilter?: string;
  includeRemote?: boolean;
  location?: string | null;
  maxQueries?: number;
  searchLimit?: number;
  searchTimeoutMs?: number;
  pageLimit?: number;
  pageTimeoutMs?: number;
  classifyLimit?: number;
  duplicateLimit?: number;
  duplicateThreshold?: number;
  queueLimit?: number;
  skipSteps?: string[];
  execute?: boolean;
  confirm?: string;
}

interface ApiErrorBody {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

class ApiError extends Error {
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

const DEFAULT_QUEUE_STATES: ReviewState[] = [
  "new",
  "needs_page_ingest",
  "needs_classification",
  "ready_for_review",
  "duplicate_candidate",
];

const DEFAULT_PORT = 3737;
const RUN_CONFIRMATION = "run-local-pipeline";

export function createJobFinderApiHandler(
  options: JobFinderApiOptions = {},
): (request: Request) => Promise<Response> {
  const context: ApiContext = {
    query: options.query ?? ((sql) => runPsqlJson(sql)),
    env: options.env ?? process.env,
    now: options.now ?? (() => new Date()),
    allowOrigins: options.allowOrigins ?? ["http://localhost:3000", "http://localhost:5173"],
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

async function handleApiRequest(
  request: Request,
  route: ApiRoute,
  context: ApiContext,
): Promise<Response> {
  if (!route.path.startsWith("/api")) {
    throw new ApiError(404, "not_found", "API routes live under /api");
  }

  if (route.method === "GET" && route.path === "/api/health") {
    return jsonResponse({
      ok: true,
      data: await readHealth(context),
    });
  }

  if (route.method === "GET" && route.path === "/api/meta") {
    return jsonResponse({
      ok: true,
      data: buildMeta(context.env),
    });
  }

  if (route.method === "GET" && route.path === "/api/jobs") {
    const rows = await context.query<JobExportRow[]>(
      buildJobsExportSql({
        limit: positiveIntParam(route.search, "limit", 50, 250),
        reviewState: nullableReviewState(route.search.get("state")),
        runId: nullablePositiveInt(route.search.get("run_id"), "run_id"),
      }),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "GET" && route.path === "/api/jobs/queue") {
    const rows = await context.query<ReviewQueueRow[]>(
      buildReviewQueueSql({
        limit: positiveIntParam(route.search, "limit", 25, 250),
        states: reviewStatesFromSearch(route.search),
      }),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  const jobDetailMatch = matchPath(route.path, "/api/jobs/:jobId");
  if (route.method === "GET" && jobDetailMatch) {
    const jobId = pathParam(jobDetailMatch, "jobId");
    const row = await context.query<JobDetailRow | null>(buildJobDetailSql(jobId));
    if (row === null) throw new ApiError(404, "job_not_found", `No job found with id ${jobId}`);
    return jsonResponse({ ok: true, data: row });
  }

  const jobEventsMatch = matchPath(route.path, "/api/jobs/:jobId/events");
  if (route.method === "GET" && jobEventsMatch) {
    const jobId = pathParam(jobEventsMatch, "jobId");
    const rows = await context.query(
      buildReviewEventsSql(jobId, positiveIntParam(route.search, "limit", 50, 250)),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  const jobReviewMatch = matchPath(route.path, "/api/jobs/:jobId/review");
  if (route.method === "POST" && jobReviewMatch) {
    const body = await readJsonObject(request);
    const toState = requiredReviewState(body.state, "state");
    const actor = optionalActor(body.actor, "human");
    const reasons = stringList(body.reasonCodes ?? body.reasons, "reasonCodes");
    const note = nullableString(body.note, "note");
    const row = await context.query<ReviewTransitionRow | null>(
      buildReviewTransitionSql({
        jobId: pathParam(jobReviewMatch, "jobId"),
        toState,
        actor,
        reasonCodes: reasons,
        note,
      }),
    );
    if (row === null)
      throw new ApiError(
        404,
        "job_not_found",
        `No job found with id ${pathParam(jobReviewMatch, "jobId")}`,
      );
    return jsonResponse({ ok: true, data: row });
  }

  if (route.method === "GET" && route.path === "/api/source-health") {
    const rows = await context.query<SourceHealthRow[]>(
      buildSourceHealthSql({
        days: nullablePositiveInt(route.search.get("days"), "days"),
        minAttempts: positiveIntParam(route.search, "min_attempts", 1, 1000),
      }),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "GET" && route.path === "/api/sweeps") {
    const rows = await context.query<SavedSweepRow[]>(
      buildListSavedSweepsSql(route.search.get("enabled") === "true"),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "POST" && route.path === "/api/sweeps") {
    const body = await readJsonObject(request);
    const input = savedSweepInputFromBody(body);
    const row = await context.query<SavedSweepRow>(buildUpsertSavedSweepSql(input));
    return jsonResponse({ ok: true, data: row }, 201);
  }

  if (route.method === "GET" && route.path === "/api/pipeline-runs") {
    const rows = await context.query<PipelineHistoryRow[]>(
      buildPipelineHistorySql(positiveIntParam(route.search, "limit", 25, 250)),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "POST" && route.path === "/api/pipeline-runs") {
    const body = (await readJsonObject(request)) as PipelineRunRequest;
    const result = await planOrStartPipeline(body, context);
    return jsonResponse({ ok: true, data: result }, result.started ? 202 : 200);
  }

  if (route.method === "GET" && route.path === "/api/applications") {
    const status = nullableApplicationStatus(route.search.get("status"));
    const rows = await context.query<ApplicationListRow[]>(
      buildListApplicationsSql({
        status: status ?? undefined,
        limit: positiveIntParam(route.search, "limit", 50, 250),
      }),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "POST" && route.path === "/api/applications") {
    const body = await readJsonObject(request);
    const jobId = requiredString(body.jobId, "jobId");
    const status = optionalApplicationStatus(body.status, "applied");
    const actor = optionalActor(body.actor, "human");
    const row = await context.query<RecordedApplicationRow | null>(
      buildRecordApplicationSql({
        jobId,
        status,
        actor,
        cvDraftId: nullableString(body.cvDraftId, "cvDraftId"),
        channel: nullableString(body.channel, "channel"),
        externalUrl: nullableString(body.externalUrl, "externalUrl"),
        appliedAt: nullableString(body.appliedAt, "appliedAt"),
        note: nullableString(body.note, "note"),
      }),
    );
    if (row === null) throw new ApiError(404, "job_not_found", `No job found with id ${jobId}`);
    return jsonResponse({ ok: true, data: row }, 201);
  }

  const duplicateReviewMatch = matchPath(route.path, "/api/duplicates/:candidateId/review");
  if (route.method === "POST" && duplicateReviewMatch) {
    const body = await readJsonObject(request);
    const candidateId = pathParam(duplicateReviewMatch, "candidateId");
    const state = requiredDuplicateReviewState(body.state);
    const actor = optionalActor(body.actor, "human");
    const reasons = stringList(body.reasonCodes ?? body.reasons, "reasonCodes");
    const row = await context.query<DuplicateCandidateReviewRow | null>(
      buildReviewDuplicateCandidateSql({
        candidateId,
        state,
        actor,
        reasonCodes: reasons,
        note: nullableString(body.note, "note"),
      }),
    );
    if (row === null)
      throw new ApiError(
        404,
        "duplicate_candidate_not_found",
        `No duplicate candidate found with id ${candidateId}`,
      );
    return jsonResponse({ ok: true, data: row });
  }

  if (route.method === "POST" && route.path === "/api/cv/bullets") {
    const body = await readJsonObject(request);
    const row = await context.query(
      buildApprovedBulletInsertSql({
        themeKey: requiredString(body.themeKey ?? body.theme, "themeKey"),
        title: requiredString(body.title, "title"),
        bulletText: requiredString(body.bulletText ?? body.bullet, "bulletText"),
        evidenceNote: requiredString(body.evidenceNote ?? body.evidence, "evidenceNote"),
      }),
    );
    return jsonResponse({ ok: true, data: row }, 201);
  }

  const cvDraftMatch = matchPath(route.path, "/api/jobs/:jobId/cv-drafts");
  if (route.method === "POST" && cvDraftMatch) {
    const body = await readJsonObject(request);
    const maxBullets = positiveIntValue(body.maxBullets, "maxBullets", 6, 25);
    const jobId = pathParam(cvDraftMatch, "jobId");
    const source = await context.query<CvDraftJobRow | null>(
      buildCvDraftSourceSql(jobId, maxBullets),
    );
    if (source === null) throw new ApiError(404, "job_not_found", `No job found with id ${jobId}`);
    const draft = renderCvDraftMarkdown(source, {
      generatedAt: context.now(),
      maxBullets,
    });
    const dryRun = body.dryRun === true;
    if (dryRun) {
      return jsonResponse({ ok: true, data: { stored: false, draft } });
    }
    const inserted = await context.query(
      buildInsertCvDraftSql(
        jobId,
        draft,
        nullableString(body.note, "note") ?? "Generated by API; requires human review.",
      ),
    );
    return jsonResponse({ ok: true, data: { stored: true, inserted, draft } }, 201);
  }

  const cvReviewMatch = matchPath(route.path, "/api/cv-drafts/:draftId/review");
  if (route.method === "POST" && cvReviewMatch) {
    const body = await readJsonObject(request);
    const status = requiredCvReviewStatus(body.status);
    const actor = optionalActor(body.actor, "human");
    const reasons = stringList(body.reasonCodes ?? body.reasons, "reasonCodes");
    const row = await context.query<CvDraftReviewRow | null>(
      buildReviewCvDraftSql({
        draftId: pathParam(cvReviewMatch, "draftId"),
        status,
        actor,
        reasonCodes: reasons,
        note: nullableString(body.note, "note"),
      }),
    );
    if (row === null)
      throw new ApiError(
        404,
        "cv_draft_not_found",
        `No CV draft found with id ${pathParam(cvReviewMatch, "draftId")}`,
      );
    return jsonResponse({ ok: true, data: row });
  }

  throw new ApiError(404, "not_found", `No route for ${route.method} ${route.path}`);
}

async function readHealth(context: ApiContext): Promise<unknown> {
  try {
    const info = await context.query<DbHealthRow>(`SELECT json_build_object(
  'database', current_database(),
  'user', current_user,
  'schema', current_schema(),
  'version', version()
);`);
    const migrations = await context.query<MigrationHealthRow>(`SELECT json_build_object(
  'applied', COUNT(*)::int,
  'latest', MAX(version)
)
FROM job_search.schema_migrations;`);
    return {
      status: "ok",
      generatedAt: context.now().toISOString(),
      database: info,
      migrations,
      integrations: integrationStatus(context.env),
    };
  } catch (err) {
    throw new ApiError(
      503,
      "database_unavailable",
      "Database health check failed",
      errorDetails(err),
    );
  }
}

async function planOrStartPipeline(
  body: PipelineRunRequest,
  context: ApiContext,
): Promise<{ started: boolean; plan: PlannedStep[]; command?: string[]; display?: string }> {
  const options = await pipelineOptionsFromBody(body, context);
  const plan = buildPipelinePlan(options);
  const plannedSteps = plan.map((step) => ({
    name: step.name,
    description: step.description,
    command: step.command,
    display: shellQuoteArgs(step.command),
  }));

  if (body.execute !== true) {
    return { started: false, plan: plannedSteps };
  }

  if (body.confirm !== RUN_CONFIRMATION) {
    throw new ApiError(
      409,
      "confirmation_required",
      `Set confirm to "${RUN_CONFIRMATION}" to start a local pipeline run from the API.`,
      {
        plan: plannedSteps,
      },
    );
  }

  const command = pipelineCommandFromRequest(body);
  Bun.spawn(command, {
    cwd: process.cwd(),
    env: context.env,
    stdout: "inherit",
    stderr: "inherit",
    stdin: "ignore",
  });

  return {
    started: true,
    plan: plannedSteps,
    command,
    display: shellQuoteArgs(command),
  };
}

async function pipelineOptionsFromBody(
  body: PipelineRunRequest,
  context: ApiContext,
): Promise<PipelinePlanOptions> {
  const skipSteps = pipelineSteps(body.skipSteps ?? []);
  if (body.sweepName) {
    const row = await context.query<SavedSweepRow | null>(buildGetSavedSweepSql(body.sweepName));
    if (row === null)
      throw new ApiError(404, "sweep_not_found", `No saved sweep found named "${body.sweepName}"`);
    if (!row.enabled)
      throw new ApiError(409, "sweep_disabled", `Saved sweep "${body.sweepName}" is disabled`);
    return savedSweepToPipelineOptions(row, skipSteps);
  }

  return {
    keywords: nonEmptyStringArray(body.keywords, "keywords", ["Agentic"]),
    sites: nonEmptyStringArray(body.sites, "sites", ["greenhouse", "lever", "ashby"]),
    timeFilter: optionalTimeFilter(body.timeFilter, "24hours"),
    includeRemote: body.includeRemote ?? true,
    location: nullableString(body.location, "location"),
    maxQueries: positiveIntValue(body.maxQueries, "maxQueries", 12, 500),
    searchLimit: positiveIntValue(body.searchLimit, "searchLimit", 5, 50),
    searchTimeoutMs: positiveIntValue(body.searchTimeoutMs, "searchTimeoutMs", 30000, 300000),
    pageLimit: positiveIntValue(body.pageLimit, "pageLimit", 10, 500),
    pageTimeoutMs: positiveIntValue(body.pageTimeoutMs, "pageTimeoutMs", 45000, 300000),
    classifyLimit: positiveIntValue(body.classifyLimit, "classifyLimit", 50, 1000),
    duplicateLimit: positiveIntValue(body.duplicateLimit, "duplicateLimit", 250, 5000),
    duplicateThreshold: positiveFloatValue(body.duplicateThreshold, "duplicateThreshold", 0.82),
    queueLimit: positiveIntValue(body.queueLimit, "queueLimit", 25, 250),
    skipSteps,
  };
}

function pipelineCommandFromRequest(body: PipelineRunRequest): string[] {
  const command = ["bun", "run", "pipeline:run", "--"];
  if (body.sweepName) command.push("--sweep", body.sweepName);
  for (const step of body.skipSteps ?? []) command.push("--skip", step);
  if (!body.sweepName) {
    for (const keyword of body.keywords ?? ["Agentic"]) command.push("--keyword", keyword);
    for (const site of body.sites ?? ["greenhouse", "lever", "ashby"]) command.push("--site", site);
    if (body.timeFilter) command.push("--time", body.timeFilter);
    if (body.includeRemote === false) command.push("--exclude-remote");
    if (body.location) command.push("--location", body.location);
    if (body.maxQueries) command.push("--max-queries", String(body.maxQueries));
    if (body.searchLimit) command.push("--search-limit", String(body.searchLimit));
    if (body.searchTimeoutMs) command.push("--search-timeout-ms", String(body.searchTimeoutMs));
    if (body.pageLimit) command.push("--page-limit", String(body.pageLimit));
    if (body.pageTimeoutMs) command.push("--page-timeout-ms", String(body.pageTimeoutMs));
    if (body.classifyLimit) command.push("--classify-limit", String(body.classifyLimit));
    if (body.duplicateLimit) command.push("--duplicate-limit", String(body.duplicateLimit));
    if (body.duplicateThreshold)
      command.push("--duplicate-threshold", String(body.duplicateThreshold));
    if (body.queueLimit) command.push("--queue-limit", String(body.queueLimit));
  }
  return command;
}

function buildJobDetailSql(jobId: string): string {
  return `SELECT COALESCE(
  (
    SELECT row_to_json(job_detail)
    FROM (
      SELECT
        j.id::text AS id,
        j.title_normalized AS title,
        j.company_hint,
        j.canonical_url,
        j.canonical_key,
        j.review_state,
        j.category,
        j.rag_focus,
        j.enterprise_focus,
        j.classification_confidence,
        j.classification_reason,
        j.page_ingest_status,
        j.page_ingested_at,
        j.ats_source,
        j.ats_org,
        j.ats_job_id,
        j.first_seen_at,
        j.last_seen_at,
        COALESCE(
          (
            SELECT json_agg(row_to_json(label_row) ORDER BY label_row.source_stage, label_row.confidence DESC)
            FROM (
              SELECT label, source_stage, confidence, reason
              FROM job_search.job_classification_labels
              WHERE job_id = j.id
            ) label_row
          ),
          '[]'::json
        ) AS labels,
        COALESCE(
          (
            SELECT json_agg(row_to_json(observation_row) ORDER BY observation_row.observed_at DESC, observation_row.id DESC)
            FROM (
              SELECT
                jo.id::text AS id,
                jo.observed_at,
                jo.observed_title,
                jo.observed_url,
                jo.observed_company_hint,
                sq.source_id,
                sq.source_label,
                sr.description_raw
              FROM job_search.job_observations jo
              JOIN job_search.search_results sr ON sr.id = jo.search_result_id
              JOIN job_search.search_queries sq ON sq.id = sr.query_id
              WHERE jo.job_id = j.id
            ) observation_row
          ),
          '[]'::json
        ) AS observations,
        COALESCE(
          (
            SELECT json_agg(row_to_json(page_row) ORDER BY page_row.fetched_at DESC)
            FROM (
              SELECT
                id::text,
                source,
                status,
                fetched_at,
                source_url,
                title_raw,
                markdown,
                usage_tokens,
                decompressed_bytes,
                error
              FROM job_search.job_pages
              WHERE job_id = j.id
            ) page_row
          ),
          '[]'::json
        ) AS pages,
        COALESCE(
          (
            SELECT json_agg(row_to_json(event_row) ORDER BY event_row.created_at DESC, event_row.id DESC)
            FROM (
              SELECT
                id::text,
                from_state,
                to_state,
                reason_codes,
                note,
                actor,
                created_at
              FROM job_search.review_events
              WHERE job_id = j.id
              LIMIT 50
            ) event_row
          ),
          '[]'::json
        ) AS review_events
      FROM job_search.jobs j
      WHERE j.id = ${quoteSqlLiteral(jobId)}
    ) job_detail
  ),
  'null'::json
);`;
}

function savedSweepInputFromBody(body: Record<string, unknown>): SavedSweepInput {
  return {
    name: requiredString(body.name, "name"),
    keywords: nonEmptyStringArray(body.keywords, "keywords", ["Agentic"]),
    sites: nonEmptyStringArray(body.sites, "sites", ["greenhouse", "lever"]),
    timeFilter: optionalTimeFilter(asOptionalString(body.timeFilter), "24hours"),
    includeRemote: optionalBoolean(body.includeRemote, true),
    location: nullableString(body.location, "location"),
    maxQueries: positiveIntValue(body.maxQueries, "maxQueries", 12, 500),
    searchLimit: positiveIntValue(body.searchLimit, "searchLimit", 5, 50),
    searchTimeoutMs: positiveIntValue(body.searchTimeoutMs, "searchTimeoutMs", 30000, 300000),
    pageLimit: positiveIntValue(body.pageLimit, "pageLimit", 10, 500),
    pageTimeoutMs: positiveIntValue(body.pageTimeoutMs, "pageTimeoutMs", 45000, 300000),
    classifyLimit: positiveIntValue(body.classifyLimit, "classifyLimit", 50, 1000),
    duplicateLimit: positiveIntValue(body.duplicateLimit, "duplicateLimit", 250, 5000),
    duplicateThreshold: positiveFloatValue(body.duplicateThreshold, "duplicateThreshold", 0.82),
    queueLimit: positiveIntValue(body.queueLimit, "queueLimit", 25, 250),
    enabled: optionalBoolean(body.enabled, true),
  };
}

async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
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

function buildMeta(env: NodeJS.ProcessEnv): unknown {
  return {
    reviewStates: REVIEW_STATES,
    reviewActors: REVIEW_ACTORS,
    applicationStatuses: APPLICATION_STATUSES,
    duplicateCandidateStates: DUPLICATE_CANDIDATE_STATES,
    pipeline: {
      runConfirmation: RUN_CONFIRMATION,
      executeDefault: false,
    },
    integrations: integrationStatus(env),
  };
}

function integrationStatus(env: NodeJS.ProcessEnv): unknown {
  return {
    postgres: {
      required: true,
      configured: Boolean(env.DATABASE_URL),
    },
    jina: {
      requiredForSearch: true,
      configured: Boolean(env.JINA_API_KEY),
    },
    openrouter: {
      requiredForLegacyEvaluation: true,
      configured: Boolean(env.OPENROUTER_API_KEY),
    },
    notion: {
      mode: "optional",
      requiredForApiStartup: false,
      requiredForPostgresPipeline: false,
      configured: Boolean(env.NOTION_TOKEN && env.NOTION_DATABASE_ID),
      tokenPresent: Boolean(env.NOTION_TOKEN),
      databaseIdPresent: Boolean(env.NOTION_DATABASE_ID),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function errorResponse(err: unknown): Response {
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

function errorBody(code: string, message: string, details?: unknown): ApiErrorBody {
  return {
    ok: false,
    error: details === undefined ? { code, message } : { code, message, details },
  };
}

function errorDetails(err: unknown): unknown {
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

function buildCorsHeaders(origin: string | null, allowOrigins: string[]): Record<string, string> {
  const allowOrigin = origin && allowOrigins.includes(origin) ? origin : "null";
  return {
    "access-control-allow-origin": allowOrigin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

function trimTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path;
}

function matchPath(path: string, pattern: string): Record<string, string> | null {
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

function pathParam(params: Record<string, string>, name: string): string {
  const value = params[name];
  if (!value) {
    throw new ApiError(500, "route_param_missing", `Route parameter ${name} was not captured`);
  }
  return value;
}

function reviewStatesFromSearch(search: URLSearchParams): ReviewState[] {
  const values = search.getAll("state").flatMap((value) =>
    value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (values.length === 0) return DEFAULT_QUEUE_STATES;
  return [...new Set(values.map((value) => requiredReviewState(value, "state")))];
}

function nullableReviewState(value: string | null): ReviewState | null {
  if (value === null || value === "") return null;
  return requiredReviewState(value, "state");
}

function requiredReviewState(value: unknown, field: string): ReviewState {
  const text = requiredString(value, field);
  if (!isReviewState(text)) {
    throw new ApiError(400, "invalid_review_state", `Unsupported review state "${text}"`, {
      valid: REVIEW_STATES,
    });
  }
  return text;
}

function optionalActor(value: unknown, fallback: ReviewActor): ReviewActor {
  if (value === undefined || value === null || value === "") return fallback;
  const text = requiredString(value, "actor");
  if (!isReviewActor(text)) {
    throw new ApiError(400, "invalid_actor", `Unsupported review actor "${text}"`, {
      valid: REVIEW_ACTORS,
    });
  }
  return text;
}

function nullableApplicationStatus(value: string | null): ApplicationStatus | null {
  if (value === null || value === "") return null;
  return optionalApplicationStatus(value, "applied");
}

function optionalApplicationStatus(value: unknown, fallback: ApplicationStatus): ApplicationStatus {
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

function requiredCvReviewStatus(value: unknown): "approved" | "rejected" | "superseded" {
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

function requiredDuplicateReviewState(
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

function optionalTimeFilter(
  value: string | null | undefined,
  fallback: BrianTimeFilter,
): BrianTimeFilter {
  const timeFilter = value ?? fallback;
  if (!isBrianTimeFilter(timeFilter)) {
    throw new ApiError(400, "invalid_time_filter", `Unsupported time filter "${timeFilter}"`);
  }
  return timeFilter;
}

function pipelineSteps(values: string[]): PipelineStepName[] {
  const steps: PipelineStepName[] = [];
  for (const value of values) {
    if (!isPipelineStepName(value)) {
      throw new ApiError(400, "invalid_pipeline_step", `Unsupported pipeline step "${value}"`);
    }
    steps.push(value);
  }
  return [...new Set(steps)];
}

function positiveIntParam(
  search: URLSearchParams,
  name: string,
  fallback: number,
  max: number,
): number {
  return positiveIntValue(search.get(name), name, fallback, max);
}

function nullablePositiveInt(value: string | null, name: string): number | null {
  if (value === null || value === "") return null;
  return positiveIntValue(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function positiveIntValue(value: unknown, name: string, fallback: number, max: number): number {
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

function positiveFloatValue(value: unknown, name: string, fallback: number): number {
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

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_field", `${field} is required and must be a non-empty string`);
  }
  return value.trim();
}

function nullableString(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", `${field} must be a string when provided`);
  }
  return value;
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_field", "Expected a string value");
  }
  return value;
}

function nonEmptyStringArray(value: unknown, field: string, fallback: string[]): string[] {
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

function stringList(value: unknown, field: string): string[] {
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

function optionalBoolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "boolean") {
    throw new ApiError(400, "invalid_field", "Expected a boolean value");
  }
  return value;
}

function parsePort(env: NodeJS.ProcessEnv): number {
  const value = env.JOB_FINDER_API_PORT;
  if (!value) return DEFAULT_PORT;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
    throw new Error("JOB_FINDER_API_PORT must be a valid TCP port");
  }
  return parsed;
}

interface DbHealthRow {
  database: string;
  user: string;
  schema: string;
  version: string;
}

interface MigrationHealthRow {
  applied: number;
  latest: string | null;
}

interface PlannedStep {
  name: string;
  description: string;
  command: string[];
  display: string;
}

interface JobDetailRow {
  id: string;
  title: string;
  company_hint: string | null;
  canonical_url: string;
  canonical_key: string;
  review_state: string;
  category: string;
  rag_focus: string;
  enterprise_focus: string;
  classification_confidence: string | null;
  classification_reason: string | null;
  page_ingest_status: string;
  page_ingested_at: string | null;
  ats_source: string | null;
  ats_org: string | null;
  ats_job_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  labels: unknown[];
  observations: unknown[];
  pages: unknown[];
  review_events: unknown[];
}
