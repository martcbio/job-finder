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

export async function runPsql(sql: string, options: PsqlOptions = {}): Promise<PsqlResult> {
  const databaseUrl = options.databaseUrl ?? getDatabaseUrl();
  const commandSql = options.setSearchPath === false ? sql : `${jobSearchPathSql()}\n${sql}`;
  const proc = Bun.spawn(
    ["psql", databaseUrl, "-X", "-v", "ON_ERROR_STOP=1", "-A", "-t", "-q", "-c", commandSql],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const result = { stdout: stdout.trim(), stderr: stderr.trim() };
  if (exitCode !== 0) {
    throw new PsqlError(
      result.stderr || result.stdout || `psql exited with code ${exitCode}`,
      result,
      exitCode,
    );
  }

  return result;
}

export async function runPsqlJson<T>(sql: string, options: PsqlOptions = {}): Promise<T> {
  const result = await runPsql(sql, options);
  if (!result.stdout) {
    throw new Error("psql returned no JSON output");
  }
  return JSON.parse(result.stdout) as T;
}
