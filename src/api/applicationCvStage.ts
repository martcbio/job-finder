import {
  type CvJobSource,
  type CvStageResult,
  type StageApplication,
  stageApplicationCv,
} from "../cv/stageApplicationCv";
import { quoteSqlLiteral } from "../db/config";
import {
  getCloudApplication,
  transitionCloudApplication,
  updateCloudApplicationCvRef,
} from "./cloudApplications";
import { getCloudOpeningRaw } from "./cloudOpenings";
import type { ApiContext } from "./context";
import { ApiError } from "./errors";

interface LocalApplicationJobRow {
  title: string;
  company: string | null;
  markdown: string | null;
  description_raw: string | null;
}

function nullableCondition(column: string, value: string | null): string | null {
  return value ? `${column} = ${quoteSqlLiteral(value)}` : null;
}

export function buildApplicationJobSourceSql(application: StageApplication): string {
  const localId = application.external_id?.match(/^local-([1-9]\d*)$/)?.[1] ?? null;
  const atsConditions = [
    nullableCondition("j.ats_source", application.ats),
    nullableCondition("j.ats_org", application.org),
    nullableCondition("j.ats_job_id", application.external_id),
  ].filter((condition): condition is string => condition !== null);
  const matches = [
    localId ? `j.id = ${quoteSqlLiteral(localId)}::bigint` : null,
    atsConditions.length === 3 ? `(${atsConditions.join(" AND ")})` : null,
    application.url ? `j.canonical_url = ${quoteSqlLiteral(application.url)}` : null,
  ].filter((condition): condition is string => condition !== null);
  const priority = [
    localId ? `WHEN j.id = ${quoteSqlLiteral(localId)}::bigint THEN 0` : "",
    atsConditions.length === 3 ? `WHEN ${atsConditions.join(" AND ")} THEN 1` : "",
    application.url ? `WHEN j.canonical_url = ${quoteSqlLiteral(application.url)} THEN 2` : "",
  ].filter(Boolean);

  // No provenance at all (manual application): no candidates to look up.
  if (matches.length === 0) {
    return `SELECT 'null'::text;`;
  }

  return `SELECT COALESCE(
  (
    SELECT row_to_json(application_job)
    FROM (
      SELECT
        j.title_normalized AS title,
        j.company_hint AS company,
        latest_page.markdown,
        latest_observation.description_raw
      FROM job_search.jobs j
      LEFT JOIN LATERAL (
        SELECT jp.markdown
        FROM job_search.job_pages jp
        WHERE jp.job_id = j.id
          AND jp.status = 'success'
          AND NULLIF(BTRIM(jp.markdown), '') IS NOT NULL
        ORDER BY jp.fetched_at DESC, jp.id DESC
        LIMIT 1
      ) latest_page ON true
      LEFT JOIN LATERAL (
        SELECT sr.description_raw
        FROM job_search.job_observations jo
        JOIN job_search.search_results sr ON sr.id = jo.search_result_id
        WHERE jo.job_id = j.id
          AND NULLIF(BTRIM(sr.description_raw), '') IS NOT NULL
        ORDER BY jo.observed_at DESC, jo.id DESC
        LIMIT 1
      ) latest_observation ON true
      WHERE ${matches.length ? matches.join(" OR ") : "false"}
      ORDER BY CASE ${priority.join(" ")} ELSE 3 END, j.last_seen_at DESC
      LIMIT 1
    ) application_job
  ),
  'null'::json
);`;
}

function normalizeDescription(value: string): string | null {
  const text = value
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;|&#34;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 20 ? text : null;
}

const DESCRIPTION_KEYS = new Set([
  "body",
  "content",
  "description",
  "descriptionhtml",
  "descriptionplain",
  "descriptiontext",
  "jobdescription",
  "jobdescriptionhtml",
  "markdown",
  "text",
]);

export function extractDescriptionFromOpeningRaw(raw: unknown): string | null {
  const candidates: string[] = [];
  const visit = (value: unknown, parentKey = "", depth = 0): void => {
    if (depth > 10 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (DESCRIPTION_KEYS.has(parentKey.toLowerCase().replace(/[_-]/g, ""))) {
        const normalized = normalizeDescription(value);
        if (normalized) candidates.push(normalized);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentKey, depth + 1);
      return;
    }
    if (typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) visit(child, key, depth + 1);
  };
  visit(raw);
  return candidates.sort((left, right) => right.length - left.length)[0] ?? null;
}

function unavailableError(reason: {
  code: string;
  message: string;
  upstreamStatus?: number;
}): ApiError {
  return new ApiError(503, reason.code, reason.message, {
    ...(reason.upstreamStatus === undefined ? {} : { upstreamStatus: reason.upstreamStatus }),
  });
}

async function resolveLocalJobSource(
  context: ApiContext,
  application: StageApplication,
): Promise<CvJobSource> {
  const row = await context.query<LocalApplicationJobRow | null>(
    buildApplicationJobSourceSql(application),
  );
  if (!row) {
    return {
      title: application.title,
      company: application.company,
      description: null,
      descriptionSource: "application_only",
    };
  }
  const markdown = row.markdown?.trim() || null;
  const observation = row.description_raw?.trim() || null;
  return {
    title: row.title || application.title,
    company: row.company || application.company,
    description: markdown ?? observation,
    descriptionSource: markdown
      ? "local_job_page"
      : observation
        ? "local_observation"
        : "application_only",
  };
}

async function resolveLabJobSource(
  context: ApiContext,
  application: StageApplication,
): Promise<CvJobSource> {
  if (!application.org || !application.ats || !application.external_id) {
    return {
      title: application.title,
      company: application.company,
      description: null,
      descriptionSource: "application_only",
    };
  }
  const result = await getCloudOpeningRaw(context, {
    org: application.org,
    ats: application.ats,
    externalId: application.external_id,
  });
  if (result.status !== "available") throw unavailableError(result.reason);
  const opening = result.rows[0];
  if (!opening) {
    return {
      title: application.title,
      company: application.company,
      description: null,
      descriptionSource: "application_only",
    };
  }
  const description = extractDescriptionFromOpeningRaw(opening.raw);
  return {
    title: opening.title || application.title,
    company: opening.company || application.company,
    description,
    descriptionSource: description ? "lab_opening_raw" : "application_only",
  };
}

export function resolveApplicationJobSource(
  context: ApiContext,
  application: StageApplication,
): Promise<CvJobSource> {
  return application.source === "lab-openings"
    ? resolveLabJobSource(context, application)
    : resolveLocalJobSource(context, application);
}

export async function stageApplicationCvWithContext(
  context: ApiContext,
  applicationId: string,
): Promise<CvStageResult> {
  const applicationResult = await getCloudApplication(context, applicationId);
  if (applicationResult.status !== "available") throw unavailableError(applicationResult.reason);
  const application = applicationResult.data;
  if (application.status !== "shortlisted") {
    throw new ApiError(
      409,
      "application_not_shortlisted",
      `Application ${applicationId} must be shortlisted before staging a CV.`,
      { currentStatus: application.status },
    );
  }

  return stageApplicationCv(application, {
    resolveJobSource: (row) => resolveApplicationJobSource(context, row),
    patchCvRef: async (id, cvRef) => {
      const result = await updateCloudApplicationCvRef(context, id, cvRef);
      if (result.status !== "available") throw unavailableError(result.reason);
      return result.data.application;
    },
    transitionToCvStaged: async (id) => {
      const result = await transitionCloudApplication(context, id, {
        to: "cv_staged",
        by: "agent",
      });
      if (result.status !== "available") throw unavailableError(result.reason);
      return result.data.application;
    },
  });
}
