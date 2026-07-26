import type { JobFinderConfig } from "../config";
import { fetchWithRetry } from "../services/http";

export interface JinaSearchResult {
  title: string;
  url: string;
  description: string;
}

interface JinaSearchResponse {
  code: number;
  data: JinaSearchResult[];
}

export interface JinaSearchUsage {
  tokens: number | null;
  decompressedContentLength: number | null;
}

export interface JinaSearchCall {
  results: JinaSearchResult[];
  usage: JinaSearchUsage;
}

export interface JinaRequestOptions {
  timeoutMs?: number;
}

export interface JinaReaderCall {
  markdown: string;
  usage: JinaSearchUsage;
}

export function buildSearchQuery(keyword: string, domain: string): string {
  return `site:${domain} ${keyword}`;
}

export function filterJobUrls(results: JinaSearchResult[], domain: string): string[] {
  return filterJobResults(results, domain).map((result) => result.url);
}

export function filterJobResults(results: JinaSearchResult[], domain: string): JinaSearchResult[] {
  const seen = new Set<string>();
  const filtered: JinaSearchResult[] = [];

  for (const result of results) {
    const url = result.url.replace(/[.,;:!?]+$/, "");
    if (url.includes(domain) && !seen.has(url)) {
      seen.add(url);
      filtered.push({ ...result, url });
    }
  }

  return filtered;
}

function parseNumericHeader(headers: Headers, name: string): number | null {
  const value = headers.get(name);
  if (!value) return null;

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

export async function fetchJinaSearchWithUsage(
  query: string,
  config: Pick<JobFinderConfig, "jinaApiKey">,
  options: JinaRequestOptions = {},
): Promise<JinaSearchCall> {
  const url = `https://s.jina.ai/?q=${encodeURIComponent(query)}`;
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (config.jinaApiKey) {
    headers.Authorization = `Bearer ${config.jinaApiKey}`;
  }

  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout =
    controller && options.timeoutMs
      ? setTimeout(
          () => controller.abort(`Jina search timed out after ${options.timeoutMs}ms`),
          options.timeoutMs,
        )
      : null;

  try {
    const res = await fetchWithRetry(url, {
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    const json = (await res.json()) as JinaSearchResponse;
    return {
      results: json.data ?? [],
      usage: {
        tokens: parseNumericHeader(res.headers, "x-usage-tokens"),
        decompressedContentLength: parseNumericHeader(res.headers, "x-decompressed-content-length"),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function fetchJinaSearch(
  query: string,
  config: Pick<JobFinderConfig, "jinaApiKey">,
): Promise<JinaSearchResult[]> {
  const call = await fetchJinaSearchWithUsage(query, config);
  return call.results;
}

export async function fetchViaJina(
  targetUrl: string,
  config: Pick<JobFinderConfig, "jinaBaseUrl" | "jinaApiKey">,
): Promise<string> {
  const call = await fetchJinaReaderWithUsage(targetUrl, config);
  return call.markdown;
}

export async function fetchJinaReaderWithUsage(
  targetUrl: string,
  config: Pick<JobFinderConfig, "jinaBaseUrl" | "jinaApiKey">,
  options: JinaRequestOptions = {},
): Promise<JinaReaderCall> {
  const jinaUrl = `${config.jinaBaseUrl}/${targetUrl}`;
  const headers: Record<string, string> = {
    Accept: "text/markdown",
  };
  if (config.jinaApiKey) {
    headers.Authorization = `Bearer ${config.jinaApiKey}`;
  }

  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout =
    controller && options.timeoutMs
      ? setTimeout(
          () => controller.abort(`Jina reader timed out after ${options.timeoutMs}ms`),
          options.timeoutMs,
        )
      : null;

  try {
    const res = await fetchWithRetry(jinaUrl, {
      headers,
      ...(controller ? { signal: controller.signal } : {}),
    });
    return {
      markdown: await res.text(),
      usage: {
        tokens: parseNumericHeader(res.headers, "x-usage-tokens"),
        decompressedContentLength: parseNumericHeader(res.headers, "x-decompressed-content-length"),
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export async function searchJobs(
  keyword: string,
  domain: string,
  config: JobFinderConfig,
): Promise<string[]> {
  const query = buildSearchQuery(keyword, domain);
  const results = await fetchJinaSearch(query, config);
  return filterJobUrls(results, domain);
}
