import { randomUUID } from "node:crypto";
import { open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { redactSecrets } from "./redaction";
import { err, ok, type Result } from "./result";

export class DoctorFinalProjectionError extends Error {
  readonly _tag = "DoctorFinalProjectionError" as const;

  constructor(override readonly cause: unknown) {
    super(
      `Doctor final projection failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
}

/** Atomically publish a verified redacted projection before deleting its raw source. */
export async function projectDoctorRawFinalOutput(
  rawPath: string,
  finalPath: string,
): Promise<Result<"absent" | "projected", DoctorFinalProjectionError>> {
  const raw = await readFile(rawPath, "utf8").catch((error) => {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  });
  if (raw === null) return ok("absent");
  const safe = redactSecrets(raw);
  const temporary = join(dirname(finalPath), `.${randomUUID()}-${process.pid}-final-output.tmp`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(safe);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, finalPath);
    if ((await readFile(finalPath, "utf8")) !== safe) {
      throw new Error("Published final output did not verify byte-for-byte");
    }
    await rm(rawPath, { force: true });
    const remains = await stat(rawPath)
      .then(() => true)
      .catch((error) => {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
        throw error;
      });
    if (remains) throw new Error("Raw final output remains after verified projection");
    return ok("projected");
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    return err(new DoctorFinalProjectionError(error));
  }
}
