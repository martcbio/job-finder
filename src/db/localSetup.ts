export interface LocalDatabaseConfig {
  targetUrl: string;
  maintenanceUrl: string;
  databaseName: string;
  owner: string;
}

export interface ResolveLocalDatabaseConfigInput {
  databaseUrl: string | null;
  maintenanceUrl: string | null;
  env: NodeJS.ProcessEnv;
}

export function resolveLocalDatabaseConfig(
  input: ResolveLocalDatabaseConfigInput,
): LocalDatabaseConfig {
  const targetUrl = new URL(input.databaseUrl ?? defaultLocalDatabaseUrl(input.env));
  assertLocalPostgresUrl(targetUrl, "DATABASE_URL");

  const databaseName = decodeURIComponent(targetUrl.pathname.replace(/^\/+/, ""));
  if (!databaseName) {
    throw new Error("DATABASE_URL must include a target database name");
  }

  const owner = decodeURIComponent(targetUrl.username || input.env.USER || "mcb");
  if (!owner) {
    throw new Error("Cannot determine database owner from URL username or USER env");
  }

  const maintenanceUrl = input.maintenanceUrl
    ? new URL(input.maintenanceUrl)
    : buildMaintenanceUrl(targetUrl);
  assertLocalPostgresUrl(maintenanceUrl, "maintenance database URL");

  return {
    targetUrl: targetUrl.toString(),
    maintenanceUrl: maintenanceUrl.toString(),
    databaseName,
    owner,
  };
}

export function buildDatabaseExistsSql(databaseName: string): string {
  return `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM pg_database WHERE datname = ${quoteSqlLiteral(databaseName)}
) THEN 'true' ELSE 'false' END;`;
}

export function buildCreateDatabaseSql(databaseName: string, owner: string): string {
  return `CREATE DATABASE ${quoteSqlIdentifier(databaseName)} OWNER ${quoteSqlIdentifier(owner)};`;
}

export function quoteSqlIdentifier(value: string): string {
  if (!value) {
    throw new Error("SQL identifier must not be empty");
  }
  return `"${value.replaceAll('"', '""')}"`;
}

function defaultLocalDatabaseUrl(env: NodeJS.ProcessEnv): string {
  const user = encodeURIComponent(env.USER || "mcb");
  return `postgres://${user}@localhost:5432/jobs`;
}

function buildMaintenanceUrl(targetUrl: URL): URL {
  const maintenanceUrl = new URL(targetUrl.toString());
  maintenanceUrl.pathname = "/postgres";
  maintenanceUrl.search = "";
  maintenanceUrl.hash = "";
  return maintenanceUrl;
}

function assertLocalPostgresUrl(url: URL, label: string): void {
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error(`${label} must use postgres:// or postgresql://`);
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  if (!localHosts.has(url.hostname)) {
    throw new Error(`${label} must point at local Postgres, got host ${url.hostname}`);
  }
}

function quoteSqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
