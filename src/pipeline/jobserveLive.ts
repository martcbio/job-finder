import { decodeHtmlEntities } from "./htmlEntities";
import { htmlToReadableMarkdown } from "./httpPageExtract";
import { classifyIr35Signals } from "./ir35Signals";
import { isJobServeUsageRestriction } from "./jobservePageSignals";
import type { NormalizedJobInput } from "./normalizedJobIngest";

export interface LiveJobServeOptions {
  searchUrl?: string;
  query: string;
  maxPages: number;
  timeoutMs: number;
  ageDays?: number;
  detailLimit?: number;
  requestDelayMs?: number;
  fetcher?: typeof fetch;
  session?: JobServeRequestSession;
}

export interface JobServeRequestSession {
  waitForRequestSlot(): Promise<void>;
  add(headers: Headers): void;
  header(): string | null;
}

export interface LiveJobServeRole {
  job_id: string;
  title: string;
  url: string;
  apply_url: string;
  detail_fetch_url: string;
  page: number;
  source_rank: number;
  location: string;
  rate: string;
  job_type: string;
  industry: string;
  employer_kind: string;
  employer_name: string;
  summary_snippet: string;
  detail_markdown: string;
  detail_status: "success" | "error" | "skipped";
  detail_error: string;
  posted_date: string;
  duration: string;
  reference: string;
  permalink: string;
  outside_ir35: boolean;
  inside_ir35: boolean;
  remote_signal: boolean;
  security_clearance_required: boolean;
  priority_notes: string[];
}

export interface LiveJobServeResult {
  query: string;
  searchUrl: string;
  classicUrl: string;
  pagesFetched: number;
  roles: LiveJobServeRole[];
  errors: string[];
  blockedReason: string | null;
}

const BASE_URL = "https://www.jobserve.com";
const DEFAULT_SEARCH_URL = `${BASE_URL}/gb/en/JobSearch.aspx`;
const WEB_SERVICE_BASE = `${BASE_URL}/WebServices/JobSearch.asmx`;
const FORM_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const JSON_CONTENT_TYPE = "application/json; charset=UTF-8";

const ITEM_START_RE = /<div class="jobListItem\b[^>]* id="([A-Z0-9]+)">/gi;
const ITEM_ID_RE = /^<div class="jobListItem\b[^>]* id="([A-Z0-9]+)">/i;
const JOB_POS_RE = /<a href="([^"]+)"[^>]*class="jobListPosition">(.+?)<\/a>/is;
const JOB_APPLY_RE = /<a href="([^"]+)"[^>]*class="jobListApply"/is;
const JOB_SKILLS_RE = /<p class="jobListSkills">(.*?)<\/p>/is;
const DETAIL_LABEL_RE =
  /<label class="jobListLabel left(?: [^"]*)?">([^<]+)<\/label>\s*<span[^>]*class="jobListDetail left"[^>]*?(?:title="([^"]*)")?[^>]*>(.*?)<\/span>/gis;
const NEXT_LINK_RE = /<span class="nav_Next">\s*(?:<a href="([^"]+)".*?)?<\/span>/is;
const PAGE_RE = /[?&]page=(\d+)/i;
const DETAIL_EMPLOYER_RE = /Posted by:<\/span>\s*([^<]+)</is;
const DETAIL_POSTED_DATE_RE = /<strong>Posted:<\/strong>\s*([^<]+)</is;

class JobServeUsageRestrictionError extends Error {
  constructor() {
    super("JobServe usage restricted; aborting all further requests");
    this.name = "JobServeUsageRestrictionError";
  }
}

class CookieJar implements JobServeRequestSession {
  readonly cookies = new Map<string, string>();
  private lastRequestAt = 0;

  constructor(private readonly requestDelayMs: number) {}

  async waitForRequestSlot(): Promise<void> {
    const remaining = this.requestDelayMs - (Date.now() - this.lastRequestAt);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
    this.lastRequestAt = Date.now();
  }

  add(headers: Headers): void {
    const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    const values =
      typeof getSetCookie === "function"
        ? getSetCookie.call(headers)
        : splitSetCookieHeader(headers.get("set-cookie"));

    for (const value of values) {
      const pair = value.split(";", 1)[0]?.trim();
      if (!pair) continue;
      const separator = pair.indexOf("=");
      if (separator === -1) continue;
      this.cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string | null {
    if (this.cookies.size === 0) return null;
    return [...this.cookies.entries()].map(([key, value]) => `${key}=${value}`).join("; ");
  }
}

export function createJobServeRequestSession(requestDelayMs = 1_500): JobServeRequestSession {
  return new CookieJar(requestDelayMs);
}

/** Fetches a bounded JobServe search and preserves site-wide blocks as source diagnostics. */
export async function fetchLiveJobServeRoles(
  options: LiveJobServeOptions,
): Promise<LiveJobServeResult> {
  const fetcher = options.fetcher ?? fetch;
  const jar = options.session ?? createJobServeRequestSession(options.requestDelayMs ?? 1_500);
  const timeoutMs = options.timeoutMs;
  const seedUrl = options.searchUrl ?? DEFAULT_SEARCH_URL;
  const ageDays = options.ageDays ?? 3;
  const maxPages = options.maxPages;
  const detailLimit = options.detailLimit ?? 5;

  let seed: { text: string; url: string };
  try {
    seed = await requestText(fetcher, jar, seedUrl, {
      timeoutMs,
      headers: { Accept: FORM_ACCEPT },
    });
  } catch (error) {
    if (error instanceof JobServeUsageRestrictionError) {
      return blockedJobServeResult(options, seedUrl, error.message);
    }
    throw error;
  }

  let submitted: { text: string; url: string };
  try {
    submitted = await submitSearchForm(fetcher, jar, {
      html: seed.text,
      finalUrl: seed.url,
      query: options.query,
      ageDays,
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof JobServeUsageRestrictionError) {
      return blockedJobServeResult(options, seed.url, error.message);
    }
    throw error;
  }

  const pageResult = await fetchResultPages(fetcher, jar, {
    firstUrl: submitted.url,
    firstHtml: submitted.text,
    maxPages,
    timeoutMs,
  });

  const roles: LiveJobServeRole[] = [];
  const seen = new Set<string>();
  let blockedReason = pageResult.blockedReason;
  let detailAcquisitionBlocked = blockedReason !== null;
  const errors = [...(blockedReason ? [blockedReason] : [])];

  for (const page of pageResult.pages) {
    for (const block of extractRoleBlocks(page.html)) {
      const role = parseJobServeRoleBlock(block, {
        pageNumber: page.pageNumber,
        sourceRank: roles.length + 1,
        pageUrl: page.url,
      });
      if (seen.has(role.job_id)) continue;
      seen.add(role.job_id);
      if (detailAcquisitionBlocked) {
        roles.push(markJobServeDetailBlocked(role, blockedReason));
        continue;
      }
      if (roles.length >= detailLimit) {
        roles.push(role);
        continue;
      }
      try {
        const detailedRole = await fetchJobServeWebServiceDetail(fetcher, jar, {
          role,
          referer: submitted.url,
          timeoutMs,
        });
        roles.push(detailedRole);
        if (detailedRole.detail_status === "error") {
          errors.push(jobServeDetailFailureMessage(detailedRole));
        }
      } catch (error) {
        if (!(error instanceof JobServeUsageRestrictionError)) throw error;
        blockedReason = error.message;
        detailAcquisitionBlocked = true;
        errors.push(error.message);
        roles.push(markJobServeDetailBlocked(role, error.message));
      }
    }
  }

  return {
    query: options.query,
    searchUrl: submitted.url,
    classicUrl: pageResult.classicUrl,
    pagesFetched: pageResult.pages.length,
    roles,
    errors,
    blockedReason,
  };
}

export function jobServeRoleToNormalizedJob(
  role: LiveJobServeRole,
  query: string,
): NormalizedJobInput {
  return {
    sourceId: "jobserve",
    sourceLabel: "JobServe",
    searchLabel: "jobserve-live",
    searchTerm: query,
    title: role.title,
    company: role.employer_name || null,
    url: role.url,
    sourceUrl: role.permalink && role.permalink !== role.url ? role.permalink : null,
    description: role.detail_markdown || role.summary_snippet,
    location: role.location || null,
    employmentType: role.job_type || null,
    compensation: role.rate || null,
    raw: {
      ...role,
      failureReason: role.detail_status === "error" ? role.detail_error : null,
    },
  };
}

export function parseJobServeRolesFromClassicHtml(
  html: string,
  options: { pageUrl?: string; pageNumber?: number } = {},
): LiveJobServeRole[] {
  return extractRoleBlocks(extractCollection(html)).map((block, index) =>
    parseJobServeRoleBlock(block, {
      pageNumber: options.pageNumber ?? 1,
      sourceRank: index + 1,
      pageUrl: options.pageUrl ?? BASE_URL,
    }),
  );
}

async function submitSearchForm(
  fetcher: typeof fetch,
  jar: JobServeRequestSession,
  input: {
    html: string;
    finalUrl: string;
    query: string;
    ageDays: number;
    timeoutMs: number;
  },
): Promise<{ text: string; url: string }> {
  const form = parseSearchForm(input.html);
  const actionUrl = absoluteUrl(form.action, input.finalUrl);
  const fields = buildSearchFormFields(form.fields, {
    query: input.query,
    ageDays: input.ageDays,
  });
  return requestText(fetcher, jar, actionUrl, {
    method: "POST",
    body: new URLSearchParams(fields),
    timeoutMs: input.timeoutMs,
    headers: {
      Accept: FORM_ACCEPT,
      "Content-Type": "application/x-www-form-urlencoded",
      Referer: input.finalUrl,
    },
  });
}

function parseSearchForm(html: string): { action: string; fields: [string, string][] } {
  const formMatch = html.match(/<form\b[^>]*id="frm1"[^>]*>/i);
  if (!formMatch) throw new Error("Could not find JobServe search form.");
  const action = attr(formMatch[0], "action");
  if (!action) throw new Error("Could not find JobServe search form action.");

  const fields: [string, string][] = [];
  for (const input of html.matchAll(/<input\b[^>]*>/gi)) {
    const tag = input[0];
    const name = attr(tag, "name");
    if (!name) continue;
    const type = (attr(tag, "type") || "text").toLowerCase();
    if (["button", "submit", "image"].includes(type)) continue;
    if ((type === "checkbox" || type === "radio") && !/\bchecked\b/i.test(tag)) continue;
    fields.push([name, attr(tag, "value") ?? ""]);
  }
  return { action, fields };
}

function buildSearchFormFields(
  fields: [string, string][],
  options: { query: string; ageDays: number },
): [string, string][] {
  const replacements = new Map<string, string>([
    ["ctl00$txtKeyWords", options.query],
    ["selAge", String(options.ageDays)],
    ["hdnPBArg", "RunMainSearch"],
  ]);
  const seen = new Set<string>();
  const out: [string, string][] = [];

  for (const [name, value] of fields) {
    const replacement = replacements.get(name);
    if (replacement !== undefined) {
      if (!seen.has(name)) {
        out.push([name, replacement]);
        seen.add(name);
      }
      continue;
    }
    out.push([name, value]);
  }

  for (const [name, value] of replacements) {
    if (!seen.has(name)) out.push([name, value]);
  }
  return out;
}

async function fetchResultPages(
  fetcher: typeof fetch,
  jar: JobServeRequestSession,
  options: {
    firstUrl: string;
    firstHtml: string;
    maxPages: number;
    timeoutMs: number;
  },
): Promise<{
  pages: Array<{ url: string; pageNumber: number; html: string }>;
  classicUrl: string;
  blockedReason: string | null;
}> {
  const pages: Array<{ url: string; pageNumber: number; html: string }> = [];
  const seen = new Set<string>();
  const classicUrl = extractClassicUrl(options.firstUrl, options.firstHtml);
  let pageUrl = options.firstUrl;
  const firstBlockedReason: string | null = null;

  for (let index = 0; index < options.maxPages; index++) {
    let page: { text: string; url: string };
    if (index === 0) {
      page = { text: options.firstHtml, url: options.firstUrl };
    } else {
      if (seen.has(pageUrl)) break;
      seen.add(pageUrl);
      try {
        page = await requestText(fetcher, jar, pageUrl, {
          timeoutMs: options.timeoutMs,
          headers: { Accept: FORM_ACCEPT },
        });
      } catch (error) {
        if (error instanceof JobServeUsageRestrictionError) {
          return { pages, classicUrl, blockedReason: error.message };
        }
        throw error;
      }
    }
    const collection = extractCollection(page.text);
    const pageNumber = Number.parseInt(pageUrl.match(PAGE_RE)?.[1] ?? "1", 10);
    pages.push({ url: page.url, pageNumber, html: collection });

    const nextUrl = page.text.match(NEXT_LINK_RE)?.[1];
    if (!nextUrl) break;
    pageUrl = absoluteUrl(nextUrl, page.url);
  }

  return { pages, classicUrl, blockedReason: firstBlockedReason };
}

async function fetchJobServeWebServiceDetail(
  fetcher: typeof fetch,
  jar: JobServeRequestSession,
  options: {
    role: LiveJobServeRole;
    referer: string;
    timeoutMs: number;
  },
): Promise<LiveJobServeRole> {
  const { role, referer, timeoutMs } = options;
  try {
    const url = `${WEB_SERVICE_BASE}/RetrieveSingleJobDetail`;
    const response = await requestText(fetcher, jar, url, {
      method: "POST",
      body: `{ id: '${role.job_id}' }`,
      timeoutMs,
      headers: {
        "Content-Type": JSON_CONTENT_TYPE,
        "X-Requested-With": "XMLHttpRequest",
        Origin: BASE_URL,
        Referer: referer,
      },
    });
    let envelope: { d?: Record<string, unknown> };
    try {
      envelope = JSON.parse(response.text) as { d?: Record<string, unknown> };
    } catch (err) {
      return {
        ...role,
        detail_status: "error",
        detail_error: `JobServe detail response was not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      };
    }
    const html = String(envelope.d?.JobDetailHtml ?? "");
    if (!html.includes(role.job_id)) {
      return {
        ...role,
        detail_status: "error",
        detail_error: `JobServe detail response did not reference job ${role.job_id}.`,
      };
    }
    const markdown = jobServeDetailMarkdownFromHtml(html, role.url);
    const bodyLength = readableMarkdownBody(markdown).length;
    if (bodyLength < Math.max(300, role.summary_snippet.length)) {
      return {
        ...role,
        detail_status: "error",
        detail_error: `JobServe detail extraction returned only ${bodyLength} readable character(s).`,
      };
    }
    const employer = html.match(DETAIL_EMPLOYER_RE)?.[1]?.trim() ?? "";
    const postedDate = html.match(DETAIL_POSTED_DATE_RE)?.[1]?.trim() ?? "";
    return {
      ...role,
      employer_name: role.employer_name || employer,
      posted_date: postedDate ? normalizeJobServePostedDate(postedDate) : role.posted_date,
      detail_markdown: markdown.trim(),
      detail_status: "success",
      detail_error: "",
    };
  } catch (err) {
    if (err instanceof JobServeUsageRestrictionError) throw err;
    return {
      ...role,
      detail_status: "error",
      detail_error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function jobServeDetailMarkdownFromHtml(html: string, url: string): string {
  return htmlToReadableMarkdown(html, url, {
    contentSelectors: ["#md_skills", "#JobDetailPanel", "main", "article"],
  });
}

function blockedJobServeResult(
  options: LiveJobServeOptions,
  searchUrl: string,
  blockedReason: string,
): LiveJobServeResult {
  return {
    query: options.query,
    searchUrl,
    classicUrl: "",
    pagesFetched: 0,
    roles: [],
    errors: [blockedReason],
    blockedReason,
  };
}

function markJobServeDetailBlocked(
  role: LiveJobServeRole,
  blockedReason: string | null,
): LiveJobServeRole {
  return {
    ...role,
    detail_status: "error",
    detail_error: blockedReason ?? "JobServe detail acquisition was blocked.",
  };
}

function jobServeDetailFailureMessage(role: LiveJobServeRole): string {
  return `JobServe detail fetch failed for ${role.url}: ${role.detail_error}`;
}

async function requestText(
  fetcher: typeof fetch,
  jar: JobServeRequestSession,
  url: string,
  options: {
    method?: string;
    body?: RequestInit["body"];
    headers?: Record<string, string>;
    timeoutMs: number;
  },
): Promise<{ text: string; url: string }> {
  await jar.waitForRequestSlot();
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`JobServe request timed out after ${options.timeoutMs}ms`),
    options.timeoutMs,
  );
  try {
    const cookie = jar.header();
    const response = await fetcher(url, {
      method: options.method ?? "GET",
      body: options.body,
      redirect: "follow",
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124 Safari/537.36",
        "Accept-Encoding": "identity",
        Connection: "close",
        ...(options.headers ?? {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
    });
    jar.add(response.headers);
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${url}`);
    const text = await response.text();
    if (isJobServeUsageRestriction(response.url, text)) {
      throw new JobServeUsageRestrictionError();
    }
    return { text, url: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

function extractClassicUrl(searchUrl: string, html: string): string {
  if (searchUrl.includes("JobListing.aspx")) return searchUrl;
  const match = html.match(
    /<a href="([^"]+)"[^>]*id="searchtogglelink"[^>]*>\s*Classic View\s*<\/a>/is,
  );
  if (!match?.[1]) return searchUrl;
  return absoluteUrl(match[1], searchUrl);
}

function extractCollection(html: string): string {
  const start = html.indexOf('<div id="joblistingcollection"');
  if (start === -1) throw new Error("Could not find the JobServe classic job listing collection.");
  const ends = [html.indexOf('<div id="actions"', start), html.indexOf("</form>", start)].filter(
    (index) => index > start,
  );
  return html.slice(start, ends.length > 0 ? Math.min(...ends) : undefined);
}

function extractRoleBlocks(collectionHtml: string): string[] {
  const matches = [...collectionHtml.matchAll(ITEM_START_RE)];
  return matches.map((match, index) => {
    const next = matches[index + 1];
    return collectionHtml.slice(match.index, next?.index ?? collectionHtml.length);
  });
}

function parseJobServeRoleBlock(
  block: string,
  options: { pageNumber: number; sourceRank: number; pageUrl: string },
): LiveJobServeRole {
  const jobId = block.match(ITEM_ID_RE)?.[1];
  if (!jobId) throw new Error("Could not determine JobServe job id from result block.");

  const titleMatch = block.match(JOB_POS_RE);
  if (!titleMatch?.[1] || !titleMatch[2]) {
    throw new Error(`Could not parse title/url for JobServe job ${jobId}.`);
  }

  const labels = extractLabelValues(block);
  const skillsHtml = block.match(JOB_SKILLS_RE)?.[1] ?? "";
  const detailUrl = skillsHtml.match(/<a href="([^"]+)"[^>]*>\s*more/is)?.[1] ?? "";
  const applyUrl = block.match(JOB_APPLY_RE)?.[1] ?? "";
  const summary = stripHtml(skillsHtml.replace(/<a href=.*?<\/a>/gis, ""));
  const employer = extractEmployer(labels);
  const roleText = [
    titleMatch[2],
    summary,
    labels.get("location"),
    labels.get("rate"),
    labels.get("type"),
    labels.get("duration"),
  ]
    .filter(Boolean)
    .join(" ");
  const ir35 = classifyIr35Signals({
    text: roleText,
    employmentType: labels.get("type") ?? null,
    compensation: labels.get("rate") ?? null,
  });

  return {
    job_id: jobId,
    title: stripHtml(titleMatch[2]),
    url: absoluteUrl(titleMatch[1], options.pageUrl),
    apply_url: applyUrl ? absoluteUrl(applyUrl, options.pageUrl) : "",
    detail_fetch_url: detailUrl ? absoluteUrl(detailUrl, options.pageUrl) : "",
    page: options.pageNumber,
    source_rank: options.sourceRank,
    location: labels.get("location") ?? "",
    rate: labels.get("rate") ?? "",
    job_type: labels.get("type") ?? "",
    industry: labels.get("industry") ?? "",
    employer_kind: employer.kind,
    employer_name: employer.name,
    summary_snippet: summary,
    posted_date: labels.get("posted date") ?? "",
    duration: labels.get("duration") ?? "",
    reference: labels.get("reference") ?? "",
    permalink: labels.get("permalink") ?? "",
    detail_markdown: "",
    detail_status: detailUrl ? "skipped" : "error",
    detail_error: detailUrl ? "" : "No JobServe detail URL was present in the search result.",
    outside_ir35: ir35.outside,
    inside_ir35: ir35.inside,
    remote_signal: /\bremote\b/i.test(roleText),
    security_clearance_required:
      /\b(?:sc cleared|security clearance|dv clearance|clearance required)\b/i.test(roleText),
    priority_notes: priorityNotes(roleText, ir35.outside),
  };
}

function normalizeJobServePostedDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  const day = String(parsed.getUTCDate()).padStart(2, "0");
  const month = String(parsed.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${parsed.getUTCFullYear()} 00:00:00`;
}

function readableMarkdownBody(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^(Title:|URL Source:)\s/.test(line))
    .join("\n")
    .trim();
}

function extractLabelValues(block: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of block.matchAll(DETAIL_LABEL_RE)) {
    const label = stripHtml(match[1] ?? "").toLowerCase();
    const titleValue = stripHtml(match[2] ?? "");
    const innerValue = stripHtml(match[3] ?? "");
    values.set(label, titleValue || innerValue);
  }
  return values;
}

function extractEmployer(labels: Map<string, string>): { kind: string; name: string } {
  for (const [key, value] of labels) {
    if (key.startsWith("employment") || key === "employer") {
      return { kind: titleCase(key), name: value };
    }
  }
  return { kind: "", name: "" };
}

function priorityNotes(text: string, outsideIr35: boolean): string[] {
  const notes: string[] = [];
  if (/\bcontract(?:or|ing)?\b/i.test(text)) notes.push("contract");
  if (outsideIr35) notes.push("outside_ir35");
  if (/\bforward[\s-]+deployed\b/i.test(text)) notes.push("forward_deployed");
  if (/\bagentic\b/i.test(text)) notes.push("agentic");
  if (/\blangchain\b/i.test(text)) notes.push("langchain");
  if (/\binference\b/i.test(text)) notes.push("inference");
  return notes;
}

function splitSetCookieHeader(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=]+=[^;,]+)/g);
}

function attr(tag: string, name: string): string | null {
  const match = tag.match(new RegExp(`\\b${escapeRegExp(name)}=(["'])(.*?)\\1`, "is"));
  return match?.[2] ? decodeHtmlEntities(match[2]) : null;
}

function absoluteUrl(url: string, base = BASE_URL): string {
  return new URL(url, base).toString();
}

function stripHtml(value: string): string {
  return decodeHtmlEntities(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
