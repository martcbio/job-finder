export interface HttpPageExtractResult {
  markdown: string;
  status: number;
  contentType: string;
  byteLength: number;
}

export interface HttpPageExtractOptions {
  timeoutMs: number;
  minTextLength: number;
}

type HttpFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export async function fetchHttpPageMarkdown(
  url: string,
  options: HttpPageExtractOptions,
  fetcher: HttpFetcher = fetch,
): Promise<HttpPageExtractResult> {
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(`HTTP extraction timed out after ${options.timeoutMs}ms`),
    options.timeoutMs,
  );

  try {
    const res = await fetcher(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8",
        "User-Agent": "job-finder-local/1.0",
      },
      signal: controller.signal,
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}: ${url}`);
    }

    const contentType = res.headers.get("content-type") ?? "";
    if (!isReadableContentType(contentType)) {
      throw new Error(`Unsupported content type "${contentType || "unknown"}"`);
    }

    const body = await res.text();
    const markdown = contentType.includes("text/plain")
      ? normalizeWhitespace(body)
      : htmlToReadableMarkdown(body, url);

    if (markdown.length < options.minTextLength) {
      throw new Error(`HTTP extraction returned only ${markdown.length} readable character(s)`);
    }

    return {
      markdown,
      status: res.status,
      contentType,
      byteLength: new TextEncoder().encode(body).byteLength,
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function htmlToReadableMarkdown(html: string, sourceUrl: string): string {
  const title = extractTagText(html, "title");
  const body = extractBody(html);
  const cleaned = body
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h[1-3])\b[^>]*>/gi, "\n\n# ")
    .replace(/<\/h[1-3]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|section|article|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeHtmlEntities(cleaned)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter(Boolean)
    .join("\n");

  const lines = [`URL Source: ${sourceUrl}`];
  if (title) {
    lines.unshift(`Title: ${title}`);
  }
  lines.push("", text);

  return `${lines.filter(Boolean).join("\n")}\n`;
}

function isReadableContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return (
    lower.includes("text/html") ||
    lower.includes("application/xhtml+xml") ||
    lower.includes("text/plain") ||
    lower === ""
  );
}

function extractTagText(html: string, tagName: string): string | null {
  const match = html.match(new RegExp(`<${tagName}\\b[^>]*>([\\s\\S]*?)</${tagName}>`, "i"));
  if (!match?.[1]) return null;
  const text = normalizeWhitespace(decodeHtmlEntities(match[1].replace(/<[^>]+>/g, " ")));
  return text || null;
}

function extractBody(html: string): string {
  const match = html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  return match?.[1] ?? html;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, "/")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number.parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}
