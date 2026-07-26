export type CompanySignalKind = "funding" | "hiring";

export interface BookmarkQueryRow {
  status_id: string;
  tweet_time_utc: string | null;
  first_seen_at_utc: string | null;
  author_handle: string | null;
  text: string;
  tweet_url: string | null;
  classification: Record<string, unknown> | null;
}

export interface BookmarkQueryPayload {
  freshness: {
    last_successful_refresh_utc: string | null;
    age_seconds: number | null;
    stale: boolean;
  };
  coverage: { covered: number; total: number; percent: number };
  rows: BookmarkQueryRow[];
}

export interface TwitterReply {
  id: string;
  text: string;
  createdAt: string;
  author: { username: string; name?: string };
}

export interface CompanySignal {
  id: string;
  kinds: CompanySignalKind[];
  text: string;
  url: string;
  publishedAt: string | null;
  capturedAt: string | null;
  authorHandle: string;
  companyHandles: string[];
  origin: "bookmark" | "hiring_thread_reply";
}

export interface CompanySignalArtifact {
  generatedAt: string;
  freshness: BookmarkQueryPayload["freshness"];
  coverage: BookmarkQueryPayload["coverage"];
  signals: CompanySignal[];
  diagnostics: string[];
}

const FUNDING_PATTERN =
  /\b(?:(?:just|recently|we|has|have|company)?\s*rais(?:ed|es)\s+(?:a\s+)?(?:[£€$]\s?[\d,.]+\s*(?:m|million|bn|billion)?|\d+(?:\.\d+)?\s*(?:m|million|bn|billion)|pre[-\s]?seed|seed|series\s+[a-e])|(?:announced|closed|secured)\b.{0,80}\b(?:funding|fundraise|pre[-\s]?seed|seed round|series\s+[a-e]))\b/i;
const HIRING_PATTERN =
  /\b(?:hiring|we(?:'re| are) hiring|open roles?|openings|join (?:us|our team)|come work)\b/i;
const HIRING_THREAD_PATTERN =
  /\b(?:which startups?.{0,40}(?:hiring|open roles?)|reply with.{0,80}(?:company|career|location))\b/i;
const NON_COMPANY_HANDLES = new Set(["benln", "grok", "x"]);

export function buildCompanySignalArtifact(input: {
  generatedAt: string;
  queries: readonly BookmarkQueryPayload[];
  threadReplies: ReadonlyMap<string, readonly TwitterReply[]>;
}): CompanySignalArtifact {
  if (input.queries.length === 0) throw new Error("at least one bookmark query is required");
  const first = input.queries[0];
  if (!first) throw new Error("bookmark query payload is missing");
  const byId = new Map<string, CompanySignal>();
  const bookmarkRows = deduplicateBookmarkRows(input.queries.flatMap((query) => query.rows));

  for (const row of bookmarkRows) {
    if (!HIRING_THREAD_PATTERN.test(row.text)) addSignal(byId, signalFromBookmark(row));
    const replies = input.threadReplies.get(row.status_id) ?? [];
    for (const reply of replies) addSignal(byId, signalFromReply(reply));
  }

  const signals = [...byId.values()].sort(
    (left, right) => Date.parse(right.publishedAt ?? "") - Date.parse(left.publishedAt ?? ""),
  );
  const diagnostics: string[] = [];
  if (input.queries.some((query) => query.freshness.stale)) {
    diagnostics.push("bookmark corpus is stale");
  }
  if (input.queries.some((query) => query.coverage.percent < 100)) {
    diagnostics.push("bookmark classification coverage is below 100%");
  }
  if (!signals.some((signal) => signal.kinds.includes("funding"))) {
    diagnostics.push("funding query returned no usable company signals");
  }
  if (!signals.some((signal) => signal.kinds.includes("hiring"))) {
    diagnostics.push("hiring query returned no usable company signals");
  }

  return {
    generatedAt: input.generatedAt,
    freshness: first.freshness,
    coverage: first.coverage,
    signals,
    diagnostics,
  };
}

export function companySignalsFor(
  company: string,
  signals: readonly CompanySignal[],
): CompanySignal[] {
  const key = normalizeCompany(company);
  if (!key) return [];
  return signals.filter((signal) => {
    if (signal.companyHandles.some((handle) => normalizeCompany(handle) === key)) return true;
    return normalizeCompany(signal.text).includes(key);
  });
}

export function isHiringThread(row: BookmarkQueryRow): boolean {
  return HIRING_THREAD_PATTERN.test(row.text);
}

function deduplicateBookmarkRows(rows: readonly BookmarkQueryRow[]): BookmarkQueryRow[] {
  const byId = new Map<string, BookmarkQueryRow>();
  for (const row of rows) byId.set(row.status_id, row);
  return [...byId.values()];
}

function signalFromBookmark(row: BookmarkQueryRow): CompanySignal {
  return {
    id: row.status_id,
    kinds: kindsFor(row.text),
    text: row.text,
    url: row.tweet_url ?? "",
    publishedAt: row.tweet_time_utc,
    capturedAt: row.first_seen_at_utc,
    authorHandle: row.author_handle ?? "unknown",
    companyHandles: companyHandles(row.text),
    origin: "bookmark",
  };
}

function signalFromReply(reply: TwitterReply): CompanySignal {
  return {
    id: reply.id,
    kinds: [...new Set<CompanySignalKind>(["hiring", ...kindsFor(reply.text)])],
    text: reply.text,
    url: `https://x.com/${reply.author.username}/status/${reply.id}`,
    publishedAt: parseTwitterDate(reply.createdAt),
    capturedAt: null,
    authorHandle: reply.author.username,
    companyHandles: companyHandles(reply.text),
    origin: "hiring_thread_reply",
  };
}

function addSignal(byId: Map<string, CompanySignal>, signal: CompanySignal): void {
  if (signal.kinds.length === 0) return;
  const existing = byId.get(signal.id);
  if (!existing) {
    byId.set(signal.id, signal);
    return;
  }
  existing.kinds = [...new Set([...existing.kinds, ...signal.kinds])];
}

function kindsFor(text: string): CompanySignalKind[] {
  const kinds: CompanySignalKind[] = [];
  if (FUNDING_PATTERN.test(text)) kinds.push("funding");
  if (HIRING_PATTERN.test(text)) kinds.push("hiring");
  return kinds;
}

function companyHandles(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/@([a-z0-9_]{2,30})/gi)]
        .map((match) => match[1])
        .filter((handle): handle is string => Boolean(handle))
        .filter((handle) => !NON_COMPANY_HANDLES.has(handle.toLowerCase())),
    ),
  ];
}

function normalizeCompany(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function parseTwitterDate(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}
