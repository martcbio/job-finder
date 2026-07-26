import { fetchWithRetry } from "../services/http";
import {
  fetchJinaSearchWithUsage,
  type JinaRequestOptions,
  type JinaSearchResult,
  type JinaSearchUsage,
} from "./search";

export const DISCOVERY_PROVIDERS = ["auto", "brave", "jina", "keyless"] as const;

export type DiscoveryProvider = (typeof DISCOVERY_PROVIDERS)[number];

export interface DiscoveryCredentials {
  braveApiKey?: string;
  jinaApiKey?: string;
}

export interface DiscoveryUsage extends JinaSearchUsage {
  provider: Exclude<DiscoveryProvider, "auto">;
  billableQueries: number;
}

export interface DiscoveryCall {
  results: JinaSearchResult[];
  usage: DiscoveryUsage;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

export function isDiscoveryProvider(value: string): value is DiscoveryProvider {
  return DISCOVERY_PROVIDERS.includes(value as DiscoveryProvider);
}

export async function fetchDiscoveryWithUsage(
  query: string,
  credentials: DiscoveryCredentials,
  options: JinaRequestOptions & {
    provider?: DiscoveryProvider;
    count?: number;
  } = {},
): Promise<DiscoveryCall> {
  const provider = resolveDiscoveryProvider(options.provider ?? "auto", credentials);
  if (provider === "brave") {
    return fetchBraveSearchWithUsage(query, credentials, options);
  }

  if (provider === "keyless") {
    return {
      results: [],
      usage: {
        provider: "keyless",
        billableQueries: 0,
        tokens: 0,
        decompressedContentLength: null,
      },
    };
  }

  const call = await fetchJinaSearchWithUsage(
    query,
    { jinaApiKey: credentials.jinaApiKey ?? "" },
    options,
  );
  return {
    results: call.results,
    usage: {
      ...call.usage,
      provider: "jina",
      billableQueries: 1,
    },
  };
}

function resolveDiscoveryProvider(
  requested: DiscoveryProvider,
  credentials: DiscoveryCredentials,
): Exclude<DiscoveryProvider, "auto"> {
  if (requested === "brave") {
    if (!credentials.braveApiKey) {
      throw new Error("BRAVE_API_KEY is required for Brave discovery");
    }
    return "brave";
  }

  if (requested === "jina") {
    if (!credentials.jinaApiKey) {
      throw new Error("JINA_API_KEY is required for Jina Search discovery");
    }
    return "jina";
  }

  if (requested === "keyless") return "keyless";
  if (credentials.braveApiKey) return "brave";
  if (credentials.jinaApiKey) return "jina";
  return "keyless";
}

async function fetchBraveSearchWithUsage(
  query: string,
  credentials: DiscoveryCredentials,
  options: JinaRequestOptions & { count?: number },
): Promise<DiscoveryCall> {
  const braveApiKey = credentials.braveApiKey;
  if (!braveApiKey) {
    throw new Error("BRAVE_API_KEY is required for Brave discovery");
  }

  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(options.count ?? 10));
  url.searchParams.set("search_lang", "en");

  const controller = options.timeoutMs ? new AbortController() : null;
  const timeout =
    controller && options.timeoutMs
      ? setTimeout(
          () => controller.abort(`Brave search timed out after ${options.timeoutMs}ms`),
          options.timeoutMs,
        )
      : null;

  try {
    const res = await fetchWithRetry(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": braveApiKey,
      },
      ...(controller ? { signal: controller.signal } : {}),
    });
    const json = (await res.json()) as BraveSearchResponse;
    return {
      results: normalizeBraveResults(json.web?.results ?? []),
      usage: {
        provider: "brave",
        billableQueries: 1,
        tokens: 0,
        decompressedContentLength: null,
      },
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function normalizeBraveResults(results: BraveSearchResult[]): JinaSearchResult[] {
  return results
    .map((result) => ({
      title: stripHtml(result.title ?? "").trim(),
      url: result.url ?? "",
      description: stripHtml(result.description ?? "").trim(),
    }))
    .filter((result) => result.title && result.url);
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/\s+/g, " ");
}
