import type { Opportunity } from "./opportunityReport";

export interface OpportunityUrlCheck {
  url: string;
  reason: string;
}

export interface OpportunityUrlVerificationResult {
  rows: Opportunity[];
  dead: OpportunityUrlCheck[];
  unverified: OpportunityUrlCheck[];
}

export async function verifyOpportunityUrls(
  rows: readonly Opportunity[],
  options: {
    timeoutMs: number;
    concurrency: number;
    fetcher?: typeof fetch;
  },
): Promise<OpportunityUrlVerificationResult> {
  const fetcher = options.fetcher ?? fetch;
  const checks = await mapWithConcurrency(rows, options.concurrency, async (row) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetcher(row.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        },
      });
      if (response.status === 404 || response.status === 410) {
        return { row, state: "dead" as const, reason: `HTTP ${response.status}` };
      }
      if (!response.ok) {
        return { row, state: "unverified" as const, reason: `HTTP ${response.status}` };
      }
      const body = (await response.text()).slice(0, 2_000_000);
      if (
        /\b(?:this job|this position|job posting|position)\s+(?:is|has been)\s+(?:no longer available|closed|filled|withdrawn)\b/i.test(
          body,
        )
      ) {
        return { row, state: "dead" as const, reason: "page says the role is no longer available" };
      }
      return { row, state: "current" as const, reason: `HTTP ${response.status}` };
    } catch (error) {
      return {
        row,
        state: "unverified" as const,
        reason: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timeout);
    }
  });

  return {
    rows: checks.filter((check) => check.state !== "dead").map((check) => check.row),
    dead: checks
      .filter((check) => check.state === "dead")
      .map((check) => ({ url: check.row.url, reason: check.reason })),
    unverified: checks
      .filter((check) => check.state === "unverified")
      .map((check) => ({ url: check.row.url, reason: check.reason })),
  };
}

async function mapWithConcurrency<T, U>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<U>,
): Promise<U[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error("concurrency must be a positive integer");
  }
  const result = new Array<U>(values.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex++;
      const value = values[index];
      if (value !== undefined) result[index] = await mapper(value);
    }
  });
  await Promise.all(workers);
  return result;
}
