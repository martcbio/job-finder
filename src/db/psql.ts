import { SQL } from "bun";
import { getDatabaseUrl, jobSearchPathSql } from "./config";

export interface PsqlOptions {
  databaseUrl?: string;
  setSearchPath?: boolean;
}

export interface PsqlResult {
  stdout: string;
  stderr: string;
}

export class PsqlError extends Error {
  constructor(
    message: string,
    readonly result: PsqlResult,
    readonly exitCode: number | null,
  ) {
    super(message);
    this.name = "PsqlError";
  }
}

const clients = new Map<string, SQL>();

function clientFor(databaseUrl: string): SQL {
  let client = clients.get(databaseUrl);
  if (!client) {
    client = new SQL(databaseUrl, { max: 4 });
    clients.set(databaseUrl, client);
  }
  return client;
}

export async function closePsqlClients(): Promise<void> {
  const open = [...clients.values()];
  clients.clear();
  await Promise.all(open.map((client) => client.end()));
}

type Row = Record<string, unknown>;

function lastStatementRows(result: unknown): Row[] {
  if (!Array.isArray(result)) return [];
  // Multi-statement queries return one result array per statement.
  if (result.length > 0 && Array.isArray(result[0])) {
    const last = result[result.length - 1];
    return Array.isArray(last) ? (last as Row[]) : [];
  }
  return result as Row[];
}

function cellToText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function rowsToText(rows: Row[]): string {
  return rows.map((row) => Object.values(row).map(cellToText).join("|")).join("\n");
}

async function execute(sql: string, options: PsqlOptions): Promise<Row[]> {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const commandSql = options.setSearchPath === false ? sql : `${jobSearchPathSql()}\n${sql}`;
  try {
    const result = await clientFor(databaseUrl).unsafe(commandSql);
    return lastStatementRows(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new PsqlError(message, { stdout: "", stderr: message }, 1);
  }
}

export async function runPsql(sql: string, options: PsqlOptions = {}): Promise<PsqlResult> {
  const rows = await execute(sql, options);
  return { stdout: rowsToText(rows).trim(), stderr: "" };
}

export async function runPsqlJson<T>(sql: string, options: PsqlOptions = {}): Promise<T> {
  const rows = await execute(sql, options);
  const row = rows[0];
  const value = row === undefined ? undefined : Object.values(row)[0];
  if (value === undefined || value === null) {
    throw new Error("psql returned no JSON output");
  }
  // The driver parses json/jsonb columns; text-typed JSON still arrives as a string.
  if (typeof value === "string") {
    return JSON.parse(value) as T;
  }
  return value as T;
}
