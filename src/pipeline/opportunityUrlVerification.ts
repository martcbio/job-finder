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

const WITHDRAWN_ROLE_PHRASE =
  /\b(?:this job|this position|job posting|position)\s+(?:is|has been)\s+(?:no longer available|closed|filled|withdrawn)\b/i;
const TITLE_TAG = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
const PRIMARY_HEADING_TAG = /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
const MAIN_CONTENT_TAG = /<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i;
const ROLE_MAIN_CONTENT_TAG = /<[^>]+\brole=(["'])main\1[^>]*>([\s\S]*?)<\/[^>]+>/i;
const PERIPHERAL_CONTENT_TAG =
  /<(?:header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/(?:header|footer|nav|aside)>/gi;
const SECONDARY_HEADING_TAG = /<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]>/gi;
const EARLY_BODY_TEXT_LIMIT = 1_000;

function visibleText(value: string): string {
  return value
    .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasProminentWithdrawalVerdict(body: string): boolean {
  const title = body.match(TITLE_TAG)?.[1] ?? "";
  if (WITHDRAWN_ROLE_PHRASE.test(visibleText(title))) return true;

  const primaryContent = mainContent(body);
  const primaryHeading = primaryContent.match(PRIMARY_HEADING_TAG)?.[1] ?? "";
  if (WITHDRAWN_ROLE_PHRASE.test(visibleText(primaryHeading))) return true;

  const earlyContent = visibleText(primaryContent.replace(SECONDARY_HEADING_TAG, " ")).slice(
    0,
    EARLY_BODY_TEXT_LIMIT,
  );
  return WITHDRAWN_ROLE_PHRASE.test(earlyContent);
}

function mainContent(body: string): string {
  const semanticMain = body.match(MAIN_CONTENT_TAG)?.[1] ?? body.match(ROLE_MAIN_CONTENT_TAG)?.[2];
  return (semanticMain ?? body).replace(PERIPHERAL_CONTENT_TAG, " ");
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
      if (hasProminentWithdrawalVerdict(body)) {
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
