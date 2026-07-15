export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  shouldRetry?: (err: unknown) => boolean;
  onRetry?: (attempt: number, err: unknown) => void;
}

function getErrorStatus(err: unknown): number | undefined {
  if (err && typeof err === "object" && "status" in err) {
    return (err as { status: number }).status;
  }
  return undefined;
}

export const isRetryableJina = (err: unknown): boolean => {
  const status = getErrorStatus(err);
  return status === 429 || status === 500 || status === 503;
};

export const isRetryableLLM = (err: unknown): boolean => {
  const status = getErrorStatus(err);
  return status === 429 || status === 500 || status === 502 || status === 503;
};

export const isRetryableNotion = (err: unknown): boolean => {
  const status = getErrorStatus(err);
  return status === 429 || status === 502 || status === 503;
};

function getErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  if ("code" in err && err.code) return String(err.code);
  if ("cause" in err && err.cause && typeof err.cause === "object" && "code" in err.cause) {
    return String(err.cause.code);
  }
  return undefined;
}

export const isRetryableAts = (err: unknown): boolean => {
  const status = getErrorStatus(err);
  if (
    status === 408 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  ) {
    return true;
  }

  const code = getErrorCode(err);
  if (
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "EHOSTUNREACH" ||
    code === "ENETDOWN" ||
    code === "ENETUNREACH" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT"
  ) {
    return true;
  }

  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return true;
  }
  return err instanceof TypeError && /fetch|network/i.test(err.message);
};

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { maxRetries = 3, baseDelayMs = 1000, shouldRetry = () => false, onRetry } = options;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = baseDelayMs * 2 ** attempt;
        onRetry?.(attempt + 1, err);
        await Bun.sleep(delay);
        continue;
      }
      throw err;
    }
  }

  // Unreachable, but TypeScript needs it
  throw new Error("withRetry: exhausted retries");
}
