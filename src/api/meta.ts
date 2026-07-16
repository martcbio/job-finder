import { DUPLICATE_CANDIDATE_STATES } from "../pipeline/jobDuplicates";
import { REVIEW_ACTORS, REVIEW_STATES } from "../pipeline/jobReview";
import { SOURCE_LANES } from "../pipeline/sourceLanes";
import { CLOUD_APPLICATION_STATUSES } from "./cloudApplications";
import { RUN_CONFIRMATION } from "./constants";
import type { ApiContext } from "./context";
import { ApiError } from "./errors";

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

export async function readHealth(context: ApiContext): Promise<unknown> {
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
      err instanceof Error ? { message: err.message } : err,
    );
  }
}

export function buildMeta(env: NodeJS.ProcessEnv): unknown {
  return {
    reviewStates: REVIEW_STATES,
    reviewActors: REVIEW_ACTORS,
    applicationStatuses: CLOUD_APPLICATION_STATUSES,
    duplicateCandidateStates: DUPLICATE_CANDIDATE_STATES,
    pipeline: {
      runConfirmation: RUN_CONFIRMATION,
      executeDefault: false,
      sourceLanes: SOURCE_LANES,
    },
    integrations: integrationStatus(env),
  };
}

export function integrationStatus(env: NodeJS.ProcessEnv): unknown {
  return {
    postgres: {
      required: true,
      configured: Boolean(env.DATABASE_URL),
    },
    jina: {
      mode: "optional",
      requiredForSearch: false,
      keylessFallback: "explicit_zero_results_or_unauthenticated_reader",
      configured: Boolean(env.JINA_API_KEY),
    },
    openrouter: {
      mode: "optional_legacy",
      requiredForApiStartup: false,
      requiredForFastRefresh: false,
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
