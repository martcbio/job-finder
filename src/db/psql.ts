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

export interface PsqlSession {
  runPsql(sql: string, options?: PsqlOptions): Promise<PsqlResult>;
  runPsqlJson<T>(sql: string, options?: PsqlOptions): Promise<T>;
}

export interface PsqlReservedConnection {
  unsafe(sql: string): Promise<unknown>;
  release(): void;
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

/**
 * Bound a one-shot command to the process-wide client pool. Long-lived
 * processes such as the API own their pool lifecycle separately.
 */
export async function withPsqlClientCleanup<T>(
  run: () => Promise<T>,
  closeClients: () => Promise<void> = closePsqlClients,
): Promise<T> {
  try {
    return await run();
  } finally {
    await closeClients();
  }
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

const TRANSACTION_CONTROL_RE = /^\s*(?:BEGIN|COMMIT|ROLLBACK)\b/im;

function commandSql(sql: string, options: PsqlOptions): string {
  return options.setSearchPath === false ? sql : `${jobSearchPathSql()}\n${sql}`;
}

function psqlError(err: unknown): PsqlError {
  const message = err instanceof Error ? err.message : String(err);
  return new PsqlError(message, { stdout: "", stderr: message }, 1);
}

/**
 * A failed multi-statement transaction leaves its connection in an aborted
 * transaction state. Roll it back before returning that connection to the pool.
 */
export async function executeReservedTransaction(
  reserved: PsqlReservedConnection,
  sql: string,
): Promise<Row[]> {
  try {
    return lastStatementRows(await reserved.unsafe(sql));
  } catch (err) {
    await reserved.unsafe("ROLLBACK;").catch(() => undefined);
    throw err;
  } finally {
    reserved.release();
  }
}

async function executeReserved(
  reserved: PsqlReservedConnection,
  sql: string,
  rollbackOnFailure: boolean,
): Promise<Row[]> {
  try {
    return lastStatementRows(await reserved.unsafe(sql));
  } catch (err) {
    if (rollbackOnFailure) {
      await reserved.unsafe("ROLLBACK;").catch(() => undefined);
    }
    throw err;
  }
}

function jsonFromRows<T>(rows: Row[]): T {
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

async function execute(sql: string, options: PsqlOptions): Promise<Row[]> {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const query = commandSql(sql, options);
  const client = clientFor(databaseUrl);
  try {
    // Explicit transaction scripts need a dedicated connection; the pool
    // rejects raw BEGIN/COMMIT to protect connection state.
    if (TRANSACTION_CONTROL_RE.test(query)) {
      const reserved = await client.reserve();
      return await executeReservedTransaction(reserved, query);
    }
    return lastStatementRows(await client.unsafe(query));
  } catch (err) {
    throw psqlError(err);
  }
}

export async function runPsql(sql: string, options: PsqlOptions = {}): Promise<PsqlResult> {
  const rows = await execute(sql, options);
  return { stdout: rowsToText(rows).trim(), stderr: "" };
}

export async function runPsqlJson<T>(sql: string, options: PsqlOptions = {}): Promise<T> {
  const rows = await execute(sql, options);
  return jsonFromRows<T>(rows);
}

/** Run related commands over one reserved connection without leaking it to callers. */
export async function withPsqlSession<T>(
  callback: (session: PsqlSession) => Promise<T>,
  options: PsqlOptions = {},
): Promise<T> {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const reserved = await clientFor(databaseUrl).reserve();
  const session: PsqlSession = {
    async runPsql(sql: string, commandOptions: PsqlOptions = {}) {
      const query = commandSql(sql, { ...options, ...commandOptions, databaseUrl });
      try {
        const rows = await executeReserved(reserved, query, TRANSACTION_CONTROL_RE.test(query));
        return { stdout: rowsToText(rows).trim(), stderr: "" };
      } catch (err) {
        throw psqlError(err);
      }
    },
    async runPsqlJson<U>(sql: string, commandOptions: PsqlOptions = {}) {
      const query = commandSql(sql, { ...options, ...commandOptions, databaseUrl });
      try {
        return jsonFromRows<U>(
          await executeReserved(reserved, query, TRANSACTION_CONTROL_RE.test(query)),
        );
      } catch (err) {
        throw psqlError(err);
      }
    },
  };

  try {
    return await callback(session);
  } finally {
    reserved.release();
  }
}
