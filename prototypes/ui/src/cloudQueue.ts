import type { CloudOpeningRow, ReviewQueueRow } from "./types";

function roleFamilyFromTitle(title: string): string {
  if (/\b(?:ai|ml|machine learning|artificial intelligence|inference)\b/i.test(title)) {
    return "ai_ml";
  }
  if (/\b(?:data|analytics)\b/i.test(title)) return "data";
  if (/\b(?:security|cyber)\b/i.test(title)) return "security";
  if (/\b(?:platform|devops|sre|infrastructure|cloud)\b/i.test(title)) return "platform";
  if (/\b(?:architect|architecture|solutions?)\b/i.test(title)) return "architecture";
  if (/\b(?:software|developer|frontend|backend|full[ -]?stack|engineer)\b/i.test(title)) {
    return "software_engineering";
  }
  if (/\b(?:research|scientist)\b/i.test(title)) return "research";
  if (/\bproduct\b/i.test(title)) return "product";
  return "other";
}

function canonicalQueueUrl(value: string): string {
  try {
    const url = new URL(value);
    url.protocol = "https:";
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      const normalized = key.toLowerCase();
      if (
        normalized.startsWith("utm_") ||
        ["ref", "source", "src", "gh_src", "lever-source"].includes(normalized)
      ) {
        url.searchParams.delete(key);
      }
    }
    const sortedParams = [...url.searchParams.entries()].sort(([left], [right]) =>
      left.localeCompare(right),
    );
    url.search = "";
    for (const [key, item] of sortedParams) url.searchParams.append(key, item);
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value.trim();
  }
}

export function cloudOpeningToQueueRow(
  opening: CloudOpeningRow,
  latestRunId?: string,
): ReviewQueueRow {
  const title = opening.title?.trim() || "Untitled opening";
  const locations = opening.locations.length > 0 ? opening.locations : [opening.location];
  const location = [...new Set(locations.map((item) => item.trim()).filter(Boolean))].join(", ");
  const postedAt = opening.posted_at ?? opening.first_seen_at;

  return {
    id: `lab:${opening.org}:${opening.ats}:${opening.external_id}`,
    title,
    company_hint: opening.company,
    canonical_url: opening.url,
    review_state: "ready_for_review",
    category: roleFamilyFromTitle(title),
    rag_focus: "",
    enterprise_focus: "",
    classification_confidence: null,
    classification_labels: [],
    duplicate_candidates: [],
    latest_review_event: null,
    source_labels: [opening.org, "lab"],
    queue_source: "lab",
    first_seen_at: opening.first_seen_at,
    is_latest_run: latestRunId !== undefined && opening.first_seen_run_id === latestRunId,
    application_provenance: {
      org: opening.org,
      ats: opening.ats,
      external_id: opening.external_id,
    },
    last_seen_at: opening.last_seen_at,
    description_sample: [
      location ? `- Location: ${location}` : null,
      `- Posted date: ${postedAt}`,
      `- First seen: ${opening.first_seen_at}`,
      `- Last seen: ${opening.last_seen_at}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
  };
}

export function mergeCloudOpeningsIntoQueue(
  localRows: ReviewQueueRow[],
  openings: CloudOpeningRow[],
  latestRunId?: string,
): ReviewQueueRow[] {
  const localUrls = new Set(localRows.map((row) => canonicalQueueUrl(row.canonical_url)));
  const cloudRows = openings
    .filter(
      (opening) =>
        opening.disposition === "suitable" &&
        !localUrls.has(canonicalQueueUrl(opening.url)),
    )
    .map((opening) => cloudOpeningToQueueRow(opening, latestRunId));

  return [...localRows, ...cloudRows].sort((left, right) =>
    right.last_seen_at.localeCompare(left.last_seen_at),
  );
}
