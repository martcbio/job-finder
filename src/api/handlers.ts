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
  buildFastRefreshRunSql,
  buildLatestFastRefreshRunSql,
  buildLatestJobRowsSql,
  type FastRefreshJobRow,
  jobRowToSummary,
  SOURCE_ATTEMPT_STATUSES,
} from "../pipeline/fastRefresh";
import {
  type ApplicationListRow,
  buildListApplicationsSql,
  buildRecordApplicationSql,
  type RecordedApplicationRow,
} from "../pipeline/jobApplications";
import {
  buildReviewDuplicateCandidateSql,
  type DuplicateCandidateReviewRow,
} from "../pipeline/jobDuplicates";
import { buildJobsExportSql, type JobExportRow } from "../pipeline/jobExport";
import {
  buildJobDetailSql,
  buildJobFullTextSql,
  type JobDetailRow,
  type JobFullTextRow,
  jobDetailToSummary,
} from "../pipeline/jobDetail";
import {
  buildReviewEventsSql,
  buildReviewTransitionSql,
  type ReviewTransitionRow,
} from "../pipeline/jobReview";
import { buildReviewQueueSql, type ReviewQueueRow } from "../pipeline/jobReviewQueue";
import { buildPipelineHistorySql, type PipelineHistoryRow } from "../pipeline/pipelineRun";
import {
  buildListSavedSweepsSql,
  buildUpsertSavedSweepSql,
  type SavedSweepRow,
} from "../pipeline/savedSweeps";
import { buildSourceHealthSql, type SourceHealthRow } from "../pipeline/sourceHealth";
import { SOURCE_LANES } from "../pipeline/sourceLanes";
import type { ApiContext, ApiRoute } from "./context";
import { ApiError } from "./errors";
import { jsonResponse } from "./errors";
import { matchPath, pathParam } from "./http";
import { buildMeta, readHealth } from "./meta";
import { planOrStartPipeline, type PipelineRunRequest } from "./pipelineApi";
import {
  nullableApplicationStatus,
  nullableReviewState,
  optionalActor,
  optionalApplicationStatus,
  positiveIntParam,
  nullablePositiveInt,
  readJsonObject,
  requiredCvReviewStatus,
  requiredDuplicateReviewState,
  requiredReviewState,
  requiredString,
  reviewStatesFromSearch,
  sourceIdsFromSearch,
  nullableString,
  stringList,
  positiveIntValue,
} from "./parse";
import { fastRefreshOptionsFromBody, savedSweepInputFromBody } from "./requestBodies";
import {
  fastRefreshSourceId,
  listQueueRefreshSources,
  listRefreshableSourceIds,
  uniqueFastRefreshSources,
} from "./refreshApi";

export async function handleApiRequest(
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

  if (route.method === "GET" && route.path === "/api/sources") {
    return jsonResponse({
      ok: true,
      data: {
        fastRefresh: uniqueFastRefreshSources(),
        queueRefresh: listQueueRefreshSources(),
        refreshableSourceIds: listRefreshableSourceIds(),
        sourceLanes: SOURCE_LANES,
        attemptStatuses: SOURCE_ATTEMPT_STATUSES,
      },
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

  if (route.method === "GET" && route.path === "/api/jobs/latest") {
    const rows = await context.query<FastRefreshJobRow[]>(
      buildLatestJobRowsSql({
        limit: positiveIntParam(route.search, "limit", 20, 250),
      }),
    );
    return jsonResponse({ ok: true, data: rows.map((row) => jobRowToSummary(row)) });
  }

  if (
    route.method === "GET" &&
    (route.path === "/api/jobs/queue" || route.path === "/api/review-queue")
  ) {
    const rows = await context.query<ReviewQueueRow[]>(
      buildReviewQueueSql({
        limit: positiveIntParam(route.search, "limit", 25, 250),
        states: reviewStatesFromSearch(route.search),
        sourceIds: sourceIdsFromSearch(route.search),
      }),
    );
    return jsonResponse({ ok: true, data: rows });
  }

  if (route.method === "POST" && route.path === "/api/refresh/fast") {
    const body = await readJsonObject(request);
    const result = await context.fastRefresh(fastRefreshOptionsFromBody(body));
    return jsonResponse({ ok: true, data: result });
  }

  const sourceRefreshMatch = matchPath(route.path, "/api/refresh/source/:sourceId");
  if (route.method === "POST" && sourceRefreshMatch) {
    const body = await readJsonObject(request);
    const sourceId = fastRefreshSourceId(pathParam(sourceRefreshMatch, "sourceId"));
    const result = await context.fastRefresh({
      ...fastRefreshOptionsFromBody(body),
      sourceIds: [sourceId],
    });
    return jsonResponse({ ok: true, data: result });
  }

  if (route.method === "GET" && route.path === "/api/runs/latest") {
    const row = await context.query(buildLatestFastRefreshRunSql());
    if (row === null) throw new ApiError(404, "run_not_found", "No refresh runs found");
    return jsonResponse({ ok: true, data: row });
  }

  const runDetailMatch = matchPath(route.path, "/api/runs/:runId");
  if (route.method === "GET" && runDetailMatch) {
    const runId = pathParam(runDetailMatch, "runId");
    const row = await context.query(buildFastRefreshRunSql(runId));
    if (row === null) throw new ApiError(404, "run_not_found", `No run found with id ${runId}`);
    return jsonResponse({ ok: true, data: row });
  }

  const jobFullTextMatch = matchPath(route.path, "/api/jobs/:jobId/full-text");
  if (route.method === "GET" && jobFullTextMatch) {
    const jobId = pathParam(jobFullTextMatch, "jobId");
    const row = await context.query<JobFullTextRow | null>(buildJobFullTextSql(jobId));
    if (row === null) throw new ApiError(404, "job_not_found", `No job found with id ${jobId}`);
    return jsonResponse({ ok: true, data: row });
  }

  const jobDetailMatch = matchPath(route.path, "/api/jobs/:jobId");
  if (route.method === "GET" && jobDetailMatch) {
    const jobId = pathParam(jobDetailMatch, "jobId");
    const row = await context.query<JobDetailRow | null>(buildJobDetailSql(jobId));
    if (row === null) throw new ApiError(404, "job_not_found", `No job found with id ${jobId}`);
    return jsonResponse({ ok: true, data: { ...row, summary: jobDetailToSummary(row) } });
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