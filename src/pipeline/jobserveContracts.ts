export interface JobServeContractRow {
  id: number;
  title: string;
  company: string | null;
  url: string;
  lastSeenAt: string;
  markdown: string;
  description: string;
}

export interface RankedJobServeContract extends JobServeContractRow {
  tier: 1 | 2 | 3 | 4;
  whyMatched: string[];
  whySoftened: string | null;
  postedAt: Date | null;
}

const STRICT_TERM_PATTERNS = [
  { label: "agentic", pattern: /\bagentic\b/i },
  { label: "langchain", pattern: /\blangchain\b/i },
  { label: "fde", pattern: /(^|[^a-z])fde([^a-z]|$)/i },
  { label: "forward deployed", pattern: /\bforward[\s-]+deployed\b/i },
  { label: "inference", pattern: /\binference\b/i },
] as const;

const ADJACENT_TERM_PATTERNS = [
  { label: "ai", pattern: /(^|[^a-z])ai([^a-z]|$)/i },
  { label: "llm", pattern: /\bllm(s)?\b/i },
  { label: "rag", pattern: /\brag\b/i },
  { label: "vector", pattern: /\bvector\b/i },
  { label: "openai", pattern: /\bopenai\b/i },
  { label: "claude", pattern: /\bclaude\b/i },
  { label: "codex", pattern: /\bcodex\b/i },
  { label: "generative ai", pattern: /\bgenerative\s+ai\b|\bgenai\b/i },
  { label: "machine learning", pattern: /\bmachine[\s-]+learning\b/i },
  { label: "data science", pattern: /\bdata[\s-]+scien(?:ce|tist)\b/i },
  { label: "bedrock", pattern: /\bbedrock\b/i },
] as const;

export function rankJobServeContracts(
  rows: readonly JobServeContractRow[],
  options: { limit: number },
): RankedJobServeContract[] {
  return rows
    .map(rankJobServeContract)
    .filter((row): row is RankedJobServeContract => row !== null)
    .sort(compareRankedJobServeContracts)
    .slice(0, options.limit);
}

export function rankJobServeContract(row: JobServeContractRow): RankedJobServeContract | null {
  const haystack = jobServeHaystack(row);
  const strictMatches = matchingLabels(haystack, STRICT_TERM_PATTERNS);
  const adjacentMatches = matchingLabels(haystack, ADJACENT_TERM_PATTERNS);
  const hasOutsideIr35 = hasPositiveIr35Signal(haystack, "outside");
  const hasInsideIr35 = hasPositiveIr35Signal(haystack, "inside");
  const hasContract = /\bcontract(?:or|ing)?\b/i.test(haystack);

  if (hasOutsideIr35 && hasContract && strictMatches.length > 0) {
    return ranked(row, 1, ["outside IR35", "contract", ...strictMatches], null);
  }

  if (hasOutsideIr35 && hasContract && adjacentMatches.length > 0) {
    return ranked(row, 2, ["outside IR35", "contract", ...adjacentMatches], "AI-adjacent term only");
  }

  if (!hasInsideIr35 && hasContract && strictMatches.length > 0) {
    return ranked(
      row,
      3,
      ["contract", ...strictMatches],
      "IR35 status missing or unclear; exact term matched",
    );
  }

  if (!hasInsideIr35 && hasContract && adjacentMatches.length > 0) {
    return ranked(row, 4, ["contract", ...adjacentMatches], "IR35 unclear and AI-adjacent term only");
  }

  return null;
}

function ranked(
  row: JobServeContractRow,
  tier: RankedJobServeContract["tier"],
  whyMatched: string[],
  whySoftened: string | null,
): RankedJobServeContract {
  return {
    ...row,
    tier,
    whyMatched,
    whySoftened,
    postedAt: parseJobServePostedAt(jobServeHaystack(row)),
  };
}

function compareRankedJobServeContracts(
  left: RankedJobServeContract,
  right: RankedJobServeContract,
): number {
  if (left.tier !== right.tier) return left.tier - right.tier;
  const leftTime = left.postedAt?.getTime() ?? Date.parse(left.lastSeenAt);
  const rightTime = right.postedAt?.getTime() ?? Date.parse(right.lastSeenAt);
  return rightTime - leftTime;
}

function jobServeHaystack(row: JobServeContractRow): string {
  return [row.title, row.company, row.url, row.description, matchingMarkdown(row.markdown)]
    .filter((part): part is string => typeof part === "string" && part.trim().length > 0)
    .join("\n");
}

function matchingMarkdown(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^- Search(?: term)?:/i.test(line.trim()))
    .join("\n");
}

function hasPositiveIr35Signal(haystack: string, polarity: "outside" | "inside"): boolean {
  const escaped = polarity === "outside" ? "outside" : "inside";
  const yesPattern = new RegExp(`\\b${escaped}[\\s-]*ir35:\\s*yes\\b`, "i");
  if (yesPattern.test(haystack)) return true;

  const noPattern = new RegExp(`\\b${escaped}[\\s-]*ir35:\\s*no\\b`, "i");
  if (noPattern.test(haystack)) return false;

  const textPattern = new RegExp(`\\b${escaped}[\\s-]*ir3[45]\\b`, "i");
  return textPattern.test(haystack);
}

function matchingLabels(
  haystack: string,
  patterns: readonly { label: string; pattern: RegExp }[],
): string[] {
  return patterns
    .filter((item) => item.pattern.test(haystack))
    .map((item) => item.label);
}

function parseJobServePostedAt(haystack: string): Date | null {
  const match = haystack.match(/\b(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, day, month, year, hour, minute, second = "00"] = match;
  if (!day || !month || !year || !hour || !minute) return null;
  const parsed = new Date(
    Date.UTC(
      Number.parseInt(year, 10),
      Number.parseInt(month, 10) - 1,
      Number.parseInt(day, 10),
      Number.parseInt(hour, 10),
      Number.parseInt(minute, 10),
      Number.parseInt(second, 10),
    ),
  );
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
