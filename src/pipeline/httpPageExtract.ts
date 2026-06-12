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

export interface HtmlToReadableMarkdownOptions {
  contentSelectors?: string[];
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

export function htmlToReadableMarkdown(
  html: string,
  sourceUrl: string,
  options: HtmlToReadableMarkdownOptions = {},
): string {
  const title = extractTagText(html, "title");
  const body = extractScopedBody(html, options.contentSelectors ?? []);
  const cleaned = stripBoilerplateElements(body)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<(h[1-6])\b[^>]*>/gi, (_match, tag: string) => {
      const depth = Number.parseInt(tag.slice(1), 10);
      return `\n\n${"#".repeat(Math.min(depth, 6))} `;
    })
    .replace(/<\/h[1-6]>/gi, "\n\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/li>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/tr>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " ")
    .replace(/<\/(p|div|section|article|ul|ol)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const text = decodeHtmlEntities(cleaned)
    .split("\n")
    .map((line) => normalizeWhitespace(line))
    .filter((line) => line && !isBoilerplateLine(line))
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

function extractScopedBody(html: string, selectors: string[]): string {
  const body = extractBody(html);
  for (const selector of selectors) {
    const scoped = extractBySelector(body, selector);
    if (scoped && normalizeWhitespace(scoped).length > 0) return scoped;
  }
  return body;
}

function extractBySelector(html: string, selector: string): string | null {
  if (selector.startsWith("#")) {
    return extractElementByAttr(html, "id", selector.slice(1));
  }
  if (selector.startsWith(".")) {
    return extractElementByClass(html, selector.slice(1));
  }
  if (/^[a-z][a-z0-9-]*$/i.test(selector)) {
    return extractElementByTag(html, selector);
  }
  if (selector === '[role="main"]' || selector === "[role='main']") {
    return extractElementByAttr(html, "role", "main");
  }
  return null;
}

function extractElementByTag(html: string, tagName: string): string | null {
  const match = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, "i").exec(html);
  if (!match || match.index === undefined) return null;
  return extractBalancedElement(html, match.index, tagName);
}

function extractElementByAttr(html: string, attrName: string, attrValue: string): string | null {
  const pattern = new RegExp(
    `<([a-z][a-z0-9:-]*)\\b[^>]*\\b${escapeRegExp(attrName)}=(["'])${escapeRegExp(
      attrValue,
    )}\\2[^>]*>`,
    "i",
  );
  const match = pattern.exec(html);
  if (!match || match.index === undefined || !match[1]) return null;
  return extractBalancedElement(html, match.index, match[1]);
}

function extractElementByClass(html: string, className: string): string | null {
  const pattern = new RegExp(
    `<([a-z][a-z0-9:-]*)\\b[^>]*\\bclass=(["'])[^"']*(?:^|\\s)${escapeRegExp(
      className,
    )}(?:\\s|$)[^"']*\\2[^>]*>`,
    "i",
  );
  const match = pattern.exec(html);
  if (!match || match.index === undefined || !match[1]) return null;
  return extractBalancedElement(html, match.index, match[1]);
}

function extractBalancedElement(html: string, startIndex: number, tagName: string): string | null {
  const tag = escapeRegExp(tagName);
  const tagPattern = new RegExp(`<\\/?${tag}\\b[^>]*>`, "gi");
  tagPattern.lastIndex = startIndex;
  let depth = 0;

  for (const match of html.slice(startIndex).matchAll(tagPattern)) {
    const localIndex = match.index ?? 0;
    const globalIndex = startIndex + localIndex;
    const token = match[0];
    const closing = /^<\//.test(token);
    const selfClosing = /\/>$/.test(token);
    if (closing) {
      depth--;
      if (depth === 0) return html.slice(startIndex, globalIndex + token.length);
    } else if (!selfClosing) {
      depth++;
    }
  }

  return null;
}

function stripBoilerplateElements(html: string): string {
  return ["nav", "header", "footer", "aside"].reduce(
    (current, tag) =>
      current.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?<\\/${tag}>`, "gi"), " "),
    html,
  );
}

function isBoilerplateLine(line: string): boolean {
  return (
    /^(skip to content|accept all|decline all|cookies settings|cookie settings)$/i.test(line) ||
    /^(google chrome|microsoft edge|apple safari|mozilla firefox)$/i.test(line) ||
    /^terms (?:&|and) conditions$/i.test(line) ||
    /^(privacy policy|need help\?|dsa)$/i.test(line) ||
    /^you are currently only able to use a limited number of features of this website\.$/i.test(
      line,
    ) ||
    /^find out how to enable the full power of this website\.$/i.test(line)
  );
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
