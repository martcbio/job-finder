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
  buildJobDetailSql,
  buildJobFullTextSql,
  type JobDetailRow,
  type JobFullTextRow,
  jobDetailToSummary,
} from "../pipeline/jobDetail";
import {
  buildReviewDuplicateCandidateSql,
  type DuplicateCandidateReviewRow,
} from "../pipeline/jobDuplicates";
import { buildJobsExportSql, type JobExportRow } from "../pipeline/jobExport";
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
import {
  buildClusterJobStatsSql,
  buildExtractionTotalsSql,
  buildSkillSignalCountsSql,
  buildSkillSignalPairsSql,
  clusterSignals,
  computeOverlaps,
  DEFAULT_CLUSTER_OPTIONS,
  type SignalCountRow,
  type SignalPairRow,
} from "../pipeline/skillClusters";
import { buildSourceHealthSql, type SourceHealthRow } from "../pipeline/sourceHealth";
import { SOURCE_LANES } from "../pipeline/sourceLanes";
import {
  createCloudApplication,
  listCloudApplications,
  transitionCloudApplication,
} from "./cloudApplications";
import { listCloudOpenings, listCloudRuns, parseCloudSince } from "./cloudOpenings";
import { getCloudOps } from "./cloudOps";
import type { ApiContext, ApiRoute } from "./context";
import { ApiError, jsonResponse } from "./errors";
import { matchPath, pathParam } from "./http";
import { buildMeta, readHealth } from "./meta";
import {
  nullablePositiveInt,
  nullableReviewState,
  nullableString,
  optionalActor,
  positiveIntParam,
  positiveIntValue,
  readJsonObject,
  requiredCvReviewStatus,
  requiredDuplicateReviewState,
  requiredReviewState,
  requiredString,
  reviewStatesFromSearch,
  sourceIdsFromSearch,
  stringList,
} from "./parse";
import { type PipelineRunRequest, planOrStartPipeline } from "./pipelineApi";
import {
  fastRefreshSourceId,
  listQueueRefreshSources,
  listRefreshableSourceIds,
  uniqueFastRefreshSources,
} from "./refreshApi";
import { fastRefreshOptionsFromBody, savedSweepInputFromBody } from "./requestBodies";

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

  if (route.method === "GET" && route.path === "/api/cloud/openings") {
    const data = await listCloudOpenings(context, {
      limit: positiveIntParam(route.search, "limit", 100, 500),
      since: parseCloudSince(route.search.get("since")),
    });
    return jsonResponse({ ok: true, data });
  }

  if (route.method === "GET" && route.path === "/api/cloud/runs") {
    const data = await listCloudRuns(context, positiveIntParam(route.search, "limit", 30, 500));
    return jsonResponse({ ok: true, data });
  }

  if (route.method === "GET" && route.path === "/api/cloud/ops") {
    return jsonResponse({ ok: true, data: await getCloudOps(context) });
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

  if (route.method === "GET" && route.path === "/api/skill-clusters") {
    const totals = await context.query<{ extracted_jobs: number; signalled_jobs: number }>(
      buildExtractionTotalsSql(),
    );
    const counts = await context.query<SignalCountRow[]>(buildSkillSignalCountsSql());
    const pairs = await context.query<SignalPairRow[]>(
      buildSkillSignalPairsSql(DEFAULT_CLUSTER_OPTIONS.minShared),
    );
    const overlaps = computeOverlaps(counts, pairs);
    const clusterShapes = clusterSignals(counts, overlaps);
    const clusterStats =
      clusterShapes.length > 0
        ? await context.query<{ cluster: string; jobs: number; top_companies: string[] }[]>(
            buildClusterJobStatsSql(clusterShapes),
          )
        : [];
    const statsByName = new Map(clusterStats.map((row) => [row.cluster, row]));
    return jsonResponse({
      ok: true,
      data: {
        generatedAt: new Date().toISOString(),
        extractedJobs: totals.extracted_jobs,
        signalledJobs: totals.signalled_jobs,
        signals: counts,
        overlaps,
        clusters: clusterShapes.map((cluster) => ({
          ...cluster,
          jobs: statsByName.get(cluster.name)?.jobs ?? 0,
          topCompanies: statsByName.get(cluster.name)?.top_companies ?? [],
        })),
      },
    });
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
    return jsonResponse({
      ok: true,
      data: await listCloudApplications(context, route.search.get("status")),
    });
  }

  if (route.method === "POST" && route.path === "/api/applications") {
    const body = await readJsonObject(request);
    const data = await createCloudApplication(context, body);
    const responseStatus = data.status === "available" && data.data.created ? 201 : 200;
    return jsonResponse({ ok: true, data }, responseStatus);
  }

  const applicationTransitionMatch = matchPath(
    route.path,
    "/api/applications/:applicationId/transition",
  );
  if (route.method === "POST" && applicationTransitionMatch) {
    const body = await readJsonObject(request);
    const data = await transitionCloudApplication(
      context,
      pathParam(applicationTransitionMatch, "applicationId"),
      body,
    );
    return jsonResponse({ ok: true, data });
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
