import { htmlToReadableMarkdown } from "./httpPageExtract";
import { classifyIr35Signals } from "./ir35Signals";
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
  excludedRoles: LiveJobServeRole[];
  errors: string[];
  blockedReason: string | null;
}

const BASE_URL = "https://www.jobserve.com";
const DEFAULT_SEARCH_URL = `${BASE_URL}/gb/en/JobSearch.aspx`;
const FORM_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
const ITEM_START_RE = /<div class="jobListItem\b[^>]* id="([A-Z0-9]+)">/gi;
const CLASSIC_LINK_RE =
  /<a href="([^"]+)"[^>]*id="searchtogglelink"[^>]*>\s*Classic View\s*<\/a>/is;
const JOB_POS_RE = /<a href="([^"]+)"[^>]*class="jobListPosition">(.+?)<\/a>/is;
const JOB_APPLY_RE = /<a href="([^"]+)"[^>]*class="jobListApply"/is;
const JOB_SKILLS_RE = /<p class="jobListSkills">(.*?)<\/p>/is;
const DETAIL_LABEL_RE =
  /<label class="jobListLabel left(?: [^"]*)?">([^<]+)<\/label>\s*<span[^>]*class="jobListDetail left"[^>]*?(?:title="([^"]*)")?[^>]*>(.*?)<\/span>/gis;
const NEXT_LINK_RE = /<span class="nav_Next">\s*(?:<a href="([^"]+)".*?)?<\/span>/is;
const PAGE_RE = /[?&]page=(\d+)/i;

class JobServeUsageRestrictionError extends Error {
  constructor() {
    super("JobServe usage restricted; aborting all further requests");
    this.name = "JobServeUsageRestrictionError";
  }
}

class CookieJar {
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

/** Fetches a bounded JobServe search and preserves site-wide blocks as source diagnostics. */
export async function fetchLiveJobServeRoles(
  options: LiveJobServeOptions,
): Promise<LiveJobServeResult> {
  const fetcher = options.fetcher ?? fetch;
  const jar = new CookieJar(options.requestDelayMs ?? 1500);
  const timeoutMs = options.timeoutMs;
  const seedUrl = options.searchUrl ?? DEFAULT_SEARCH_URL;
  const ageDays = options.ageDays ?? 3;

  const seed = await requestText(fetcher, jar, seedUrl, {
    timeoutMs,
    headers: { Accept: FORM_ACCEPT },
  });
  const submitted = await submitSearchForm(fetcher, jar, {
    html: seed.text,
    finalUrl: seed.url,
    query: options.query,
    ageDays,
    timeoutMs,
  });
  const classicUrl = extractClassicUrl(submitted.url, submitted.text);
  const pages = await fetchClassicPages(fetcher, jar, {
    classicUrl,
    maxPages: options.maxPages,
    timeoutMs,
  });

  const roles: LiveJobServeRole[] = [];
  const excludedRoles: LiveJobServeRole[] = [];
  const seen = new Set<string>();
  let blockedReason: string | null = null;

  pageLoop: for (const page of pages) {
    for (const block of extractRoleBlocks(page.html)) {
      const role = parseJobServeRoleBlock(block, {
        pageNumber: page.pageNumber,
        sourceRank: roles.length + excludedRoles.length + 1,
        pageUrl: page.url,
      });
      if (seen.has(role.job_id)) continue;
      seen.add(role.job_id);
      if (role.security_clearance_required) {
        excludedRoles.push(role);
      } else {
        if (roles.length >= (options.detailLimit ?? 5)) {
          roles.push(role);
          continue;
        }
        try {
          roles.push(await fetchJobServeRoleDetail(fetcher, jar, role, timeoutMs));
        } catch (error) {
          if (!(error instanceof JobServeUsageRestrictionError)) throw error;
          blockedReason = error.message;
          roles.push({
            ...role,
            detail_status: "error",
            detail_error: error.message,
          });
          break pageLoop;
        }
      }
    }
  }

  const errors = [
    ...(blockedReason ? [blockedReason] : []),
    ...(excludedRoles.length > 0
      ? [`${excludedRoles.length} security-clearance role(s) excluded`]
      : []),
  ];
  return {
    query: options.query,
    searchUrl: submitted.url,
    classicUrl,
    pagesFetched: pages.length,
    roles,
    excludedRoles,
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
    raw: role,
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
  jar: CookieJar,
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

async function fetchClassicPages(
  fetcher: typeof fetch,
  jar: CookieJar,
  options: { classicUrl: string; maxPages: number; timeoutMs: number },
): Promise<Array<{ url: string; pageNumber: number; html: string }>> {
  const pages: Array<{ url: string; pageNumber: number; html: string }> = [];
  const seen = new Set<string>();
  let pageUrl = options.classicUrl;

  for (let index = 0; index < options.maxPages; index++) {
    if (seen.has(pageUrl)) break;
    seen.add(pageUrl);

    const page = await requestText(fetcher, jar, pageUrl, {
      timeoutMs: options.timeoutMs,
      headers: { Accept: FORM_ACCEPT },
    });
    const collection = extractCollection(page.text);
    const pageNumber = Number.parseInt(pageUrl.match(PAGE_RE)?.[1] ?? "1", 10);
    pages.push({ url: page.url, pageNumber, html: collection });

    const nextUrl = page.text.match(NEXT_LINK_RE)?.[1];
    if (!nextUrl) break;
    pageUrl = absoluteUrl(nextUrl, page.url);
  }

  return pages;
}

async function requestText(
  fetcher: typeof fetch,
  jar: CookieJar,
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
    if (
      /<h1[^>]*>\s*Usage Restricted\s*<\/h1>/i.test(text) ||
      /\bdeemed to exceed our fair usage levels\b/i.test(text) ||
      /\/UsageRestriction\.aspx\b/i.test(response.url)
    ) {
      throw new JobServeUsageRestrictionError();
    }
    return { text, url: response.url || url };
  } finally {
    clearTimeout(timeout);
  }
}

function extractClassicUrl(searchUrl: string, html: string): string {
  if (searchUrl.includes("JobListing.aspx")) return searchUrl;
  const match = html.match(CLASSIC_LINK_RE);
  if (!match?.[1]) throw new Error("Could not find the JobServe Classic View link.");
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
  const jobId = block.match(/<div class="jobListItem\b[^>]* id="([A-Z0-9]+)">/i)?.[1];
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

async function fetchJobServeRoleDetail(
  fetcher: typeof fetch,
  jar: CookieJar,
  role: LiveJobServeRole,
  timeoutMs: number,
): Promise<LiveJobServeRole> {
  if (!role.detail_fetch_url) return role;

  try {
    const detail = await requestText(fetcher, jar, role.detail_fetch_url, {
      timeoutMs,
      headers: { Accept: FORM_ACCEPT, Referer: role.url },
    });
    const markdown = jobServeDetailMarkdownFromHtml(detail.text, detail.url);
    const bodyLength = readableMarkdownBody(markdown).length;
    if (bodyLength < Math.max(300, role.summary_snippet.length)) {
      return {
        ...role,
        detail_status: "error",
        detail_error: `JobServe detail extraction returned only ${bodyLength} readable character(s).`,
      };
    }
    return {
      ...role,
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
    contentSelectors: ["#job", "main", '[role="main"]', "article"],
  });
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
  return match?.[2] ? decodeHtml(match[2]) : null;
}

function absoluteUrl(url: string, base = BASE_URL): string {
  return new URL(url, base).toString();
}

function stripHtml(value: string): string {
  return decodeHtml(
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeHtml(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&pound;/gi, "£")
    .replace(/&euro;/gi, "€")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCharCode(Number.parseInt(code, 10)));
}

function titleCase(value: string): string {
  return value.replace(/\b\w/g, (match) => match.toUpperCase());
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
