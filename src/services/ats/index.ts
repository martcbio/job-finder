import { logger } from "../../logger";
import { clearAshbyCache, fetchAshbyJob } from "./ashby";
import { fetchGreenhouseJob } from "./greenhouse";
import { fetchLeverJob } from "./lever";
import type { AtsJobData, AtsSource, Fetcher } from "./types";
import { fetchWorkableJob } from "./workable";

export type { AtsJobData, AtsSource } from "./types";
export { clearAshbyCache };

const log = logger.child({ component: "ats" });

export function detectAtsSource(url: string): AtsSource | null {
  if (url.includes("lever.co")) return "lever";
  if (url.includes("ashbyhq.com")) return "ashby";
  if (url.includes("greenhouse.io")) return "greenhouse";
  if (url.includes("apply.workable.com")) return "workable";
  return null;
}

export async function fetchAtsData(
  url: string,
  opts: { title?: string } = {},
  fetcher: Fetcher = fetch,
): Promise<AtsJobData | null> {
  const source = detectAtsSource(url);
  if (!source) return null;

  try {
    switch (source) {
      case "lever":
        return await fetchLeverJob(url, fetcher);
      case "ashby":
        return await fetchAshbyJob(url, fetcher);
      case "greenhouse":
        return await fetchGreenhouseJob(url, fetcher);
      case "workable":
        // Workable has no per-job endpoint — we full-text search for the
        // title to land the target on the first 10 results, then filter by
        // shortcode. Empty/missing title means no enrichment for this run.
        if (!opts.title) return null;
        return await fetchWorkableJob(url, opts.title, fetcher);
    }
  } catch (err) {
    log.warn({ err, url }, "ATS dispatcher unexpected error");
    return null;
  }
}

/**
 * ATS work mode is evidence for the downstream location assessment, not a
 * deterministic blocker. Hybrid and on-site requirements must remain visible
 * as caveats rather than being dropped before the full listing is screened.
 */
export function atsStructuralFilter(_data: AtsJobData | null): { pass: boolean; reason: string } {
  return { pass: true, reason: "" };
}

export function formatAtsBlock(data: AtsJobData): string {
  const lines = [`## ATS Structured Data (from ${data.source} API)`];
  if (data.title) lines.push(`- Title: ${data.title}`);
  if (data.company) lines.push(`- Company: ${data.company}`);
  if (data.location) lines.push(`- Primary location: ${data.location}`);
  if (data.locations.length > 0) lines.push(`- All listed locations: ${data.locations.join(", ")}`);
  lines.push(`- Workplace type: ${data.workplaceType ?? "unspecified"}`);
  if (data.country) lines.push(`- Country (HQ): ${data.country}`);
  lines.push("---");
  if (data.descriptionPlain?.trim()) {
    lines.push("", "## ATS Job Description", "", data.descriptionPlain.trim());
  }
  return lines.join("\n");
}

export function hasUsableAtsBody(data: AtsJobData): boolean {
  const text = data.descriptionPlain?.trim() ?? "";
  if (text.length < 700) return false;
  return /\b(responsibilities|requirements|qualifications|what you.?ll do|about the role|about you)\b/i.test(
    text,
  );
}
