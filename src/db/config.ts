export const JOB_SEARCH_SCHEMA = "job_search";

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for job_search database commands");
  }
  return databaseUrl;
}

export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function jobSearchPathSql(): string {
  return `SET search_path TO ${JOB_SEARCH_SCHEMA}, public, pg_temp;`;
}
