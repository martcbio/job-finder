const GENERIC_WITHDRAWN_ROLE_PHRASE =
  /\b(?:this job|this position|job posting|position)\s+(?:is|has been)\s+(?:no longer available|closed|filled|withdrawn)\b/i;
const JOBSERVE_WITHDRAWN_ROLE_PHRASE =
  /\b(?:the job you have requested is no longer available|job expired)\b/i;

export function isJobServeUrl(rawUrl: string): boolean {
  try {
    const hostname = new URL(rawUrl).hostname.toLowerCase().replace(/^www\./, "");
    return hostname === "jobserve.com" || hostname.endsWith(".jobserve.com");
  } catch {
    return false;
  }
}

export function isJobServeExpiredLanding(requestedUrl: string, finalUrl: string): boolean {
  if (!isJobServeUrl(requestedUrl) || !finalUrl || !isJobServeUrl(finalUrl)) return false;
  const pathname = new URL(finalUrl).pathname.toLowerCase();
  return pathname.endsWith("/jobsearch.aspx") || pathname.endsWith("/jobexpired.aspx");
}

export function isJobServeUsageRestriction(finalUrl: string, body: string): boolean {
  return (
    /\/usagerestriction\.aspx\b/i.test(finalUrl) ||
    /<h1[^>]*>\s*Usage Restricted\s*<\/h1>/i.test(body) ||
    /\bdeemed to exceed our fair usage levels\b/i.test(body)
  );
}

export function isMatchingJobServeDetailLanding(jobId: string, rawUrl: string): boolean {
  if (!isJobServeUrl(rawUrl)) return false;
  const url = new URL(rawUrl);
  if (
    isJobServeExpiredLanding(rawUrl, rawUrl) ||
    /\/usagerestriction\.aspx\b/i.test(url.pathname)
  ) {
    return false;
  }
  return `${url.pathname}${url.search}`.toLowerCase().includes(jobId.toLowerCase());
}

export function jobServeJobIdFromUrl(rawUrl: string): string | null {
  if (!isJobServeUrl(rawUrl)) return null;
  const pathname = new URL(rawUrl).pathname;
  return (
    pathname.match(/\/W([A-Z0-9]+)\.jsjob\/?$/i)?.[1] ??
    pathname.match(/-([A-Z0-9]+)\/?$/i)?.[1] ??
    null
  );
}

export function hasProminentWithdrawalVerdict(body: string, jobServe: boolean): boolean {
  const phrase = jobServe
    ? new RegExp(
        `${GENERIC_WITHDRAWN_ROLE_PHRASE.source}|${JOBSERVE_WITHDRAWN_ROLE_PHRASE.source}`,
        "i",
      )
    : GENERIC_WITHDRAWN_ROLE_PHRASE;
  const title = body.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "";
  if (phrase.test(visibleText(title))) return true;

  const primaryContent = mainContent(body);
  const headingPattern = jobServe
    ? /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i
    : /<h1\b[^>]*>([\s\S]*?)<\/h1>/i;
  const primaryHeading = primaryContent.match(headingPattern)?.[1] ?? "";
  if (phrase.test(visibleText(primaryHeading))) return true;

  const earlyContent = visibleText(
    primaryContent.replace(/<h[2-6]\b[^>]*>[\s\S]*?<\/h[2-6]>/gi, " "),
  ).slice(0, 1_000);
  return phrase.test(earlyContent);
}

function visibleText(value: string): string {
  return value
    .replace(/<(?:script|style|template)\b[^>]*>[\s\S]*?<\/(?:script|style|template)>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function mainContent(body: string): string {
  const semanticMain =
    body.match(/<(?:main|article)\b[^>]*>([\s\S]*?)<\/(?:main|article)>/i)?.[1] ??
    body.match(/<[^>]+\brole=(["'])main\1[^>]*>([\s\S]*?)<\/[^>]+>/i)?.[2];
  return (semanticMain ?? body).replace(
    /<(?:header|footer|nav|aside)\b[^>]*>[\s\S]*?<\/(?:header|footer|nav|aside)>/gi,
    " ",
  );
}
