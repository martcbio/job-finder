export const JOB_SEARCH_SCHEMA = "job_search";

export function defaultLocalDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const user = encodeURIComponent(env.USER || "mcb");
  return `postgres://${user}@localhost:5432/jobs`;
}

export function getDatabaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.DATABASE_URL || defaultLocalDatabaseUrl(env);
}

export function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function jobSearchPathSql(): string {
  return `SET search_path TO ${JOB_SEARCH_SCHEMA}, public, pg_temp;`;
}
