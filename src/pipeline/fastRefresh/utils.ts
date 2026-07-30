import type { SourceOutcome } from "../sourceAdapterContract";
import { normalizeRegisteredSourceId } from "../sourceRegistry";

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function numberOrNull(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numberOrZero(value: string | number | null): number {
  return numberOrNull(value) ?? 0;
}

export function positiveSqlLimit(value: number): number {
  if (!Number.isInteger(value) || value <= 0 || value > 1000) {
    throw new Error("SQL limit must be a positive integer up to 1000");
  }
  return value;
}

export function titleCase(value: string): string {
  return value.replace(/[-_]/g, " ").replace(/\b\w/g, (match) => match.toUpperCase());
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function escapeMarkdownLinkText(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

export function formatCost(value: number | null): string {
  return value === null ? "unknown" : String(value);
}

export function normalizeSourceId(value: string): string {
  return normalizeRegisteredSourceId(value);
}

export function hostname(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

export function sourceIdFromUrl(url: string): string {
  const host = hostname(url);
  if (host.includes("greenhouse.io")) return "greenhouse";
  if (host.includes("lever.co")) return "lever";
  if (host.includes("ashbyhq.com")) return "ashby";
  if (host.includes("workable.com")) return "workable";
  if (host.includes("smartrecruiters.com")) return "smartrecruiters";
  if (host.includes("linkedin.com")) return "linkedin";
  if (host.includes("glassdoor.")) return "glassdoor";
  if (host.includes("wellfound.com")) return "wellfound";
  if (host.includes("jobserve.com")) return "jobserve";
  return host.replace(/^www\./, "") || "unknown";
}

export function outcomeFromError(err: unknown): SourceOutcome {
  const message = errorMessage(err);
  if (/timeout|aborted/i.test(message)) return "timeout";
  if (/captcha/i.test(message)) return "blocked_captcha";
  if (/401|403|auth/i.test(message)) return "blocked_auth";
  if (/parse|could not find|could not parse/i.test(message)) return "parse_error";
  return "http_error";
}

export function extractMarkdownMetadata(markdown: string | null, label: string): string | null {
  if (!markdown) return null;
  const match = markdown.match(new RegExp(`^- ${escapeRegExp(label)}:\\s*(.+)$`, "im"));
  return match?.[1]?.trim() ?? null;
}

export function extractLocation(
  markdown: string | null,
  description: string | null,
): string | null {
  const location = extractMarkdownMetadata(markdown, "Location");
  if (location) return location;
  return description?.match(/\bLocation:\s*([^\n]+)/i)?.[1]?.trim() ?? null;
}

export function extractPostedAt(markdown: string | null): string | null {
  return extractMarkdownMetadata(markdown, "Posted date");
}

export function extractMarkdownMetadataList(markdown: string | null, label: string): string[] {
  const value = extractMarkdownMetadata(markdown, label);
  if (!value) return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function markdownLineCount(markdown: string | null): number {
  if (!markdown) return 0;
  return markdown
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

export function markdownBulletCount(markdown: string | null): number {
  if (!markdown) return 0;
  return markdown.split(/\r?\n/).filter((line) => /^[-*]\s+/.test(line.trim())).length;
}

export function addNullable(left: number | null, right: number | null): number | null {
  if (left === null || right === null) return null;
  return left + right;
}
