import type {
  ApplicationRow,
  ApplicationStatus,
  CreateApplicationInput,
  ReviewQueueRow,
} from "../types";

export const BOARD_STATUSES = [
  "interested",
  "shortlisted",
  "cv_staged",
  "sent",
  "response",
  "interview",
] as const satisfies readonly ApplicationStatus[];

const FORWARD_STATUS: Partial<Record<ApplicationStatus, ApplicationStatus>> = {
  interested: "shortlisted",
  shortlisted: "cv_staged",
  cv_staged: "sent",
  sent: "response",
  response: "interview",
  interview: "offer",
};

interface AtsIdentity {
  org: string;
  ats: "ashby" | "greenhouse" | "lever";
  externalId: string;
}

function atsIdentity(urlValue: string): AtsIdentity | null {
  try {
    const url = new URL(urlValue);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const parts = url.pathname.split("/").filter(Boolean);
    if ((host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") && parts[0]) {
      const jobsIndex = parts.indexOf("jobs");
      const externalId = jobsIndex >= 0 ? parts[jobsIndex + 1] : undefined;
      if (externalId) return { org: parts[0], ats: "greenhouse", externalId };
    }
    if (host === "jobs.lever.co" && parts[0] && parts[1]) {
      return { org: parts[0], ats: "lever", externalId: parts[1] };
    }
    if ((host === "jobs.ashbyhq.com" || host === "jobs.ashby.io") && parts[0] && parts[1]) {
      return { org: parts[0], ats: "ashby", externalId: parts[1] };
    }
  } catch {
    return null;
  }
  return null;
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "unknown";
}

export function applicationInputFromQueueRow(job: ReviewQueueRow): CreateApplicationInput {
  const identity = atsIdentity(job.canonical_url);
  const fromJobserve = job.source_labels.some((label) => label.toLowerCase().includes("jobserve"));
  if (identity) {
    return {
      org: identity.org,
      ats: identity.ats,
      external_id: identity.externalId,
      source: fromJobserve ? "jobserve" : "lab-openings",
      title: job.title,
      company: job.company_hint ?? identity.org,
      url: job.canonical_url,
    };
  }
  return {
    org: slug(job.company_hint ?? "unknown"),
    ats: fromJobserve ? "jobserve" : "manual",
    external_id: `local-${job.id}`,
    source: fromJobserve ? "jobserve" : "manual",
    title: job.title,
    company: job.company_hint ?? "Unknown company",
    url: job.canonical_url,
  };
}

export function findApplicationForQueueRow(
  applications: ApplicationRow[],
  job: ReviewQueueRow,
): ApplicationRow | undefined {
  const input = applicationInputFromQueueRow(job);
  return applications.find(
    (application) =>
      (application.org === input.org &&
        application.ats === input.ats &&
        application.external_id === input.external_id) ||
      application.url === input.url,
  );
}

export function nextApplicationStatus(status: ApplicationStatus): ApplicationStatus | null {
  return FORWARD_STATUS[status] ?? null;
}

export function groupApplications(
  applications: ApplicationRow[],
): Record<(typeof BOARD_STATUSES)[number], ApplicationRow[]> {
  return Object.fromEntries(
    BOARD_STATUSES.map((status) => [
      status,
      applications
        .filter((application) => application.status === status)
        .sort((left, right) => (right.updated_at ?? "").localeCompare(left.updated_at ?? "")),
    ]),
  ) as Record<(typeof BOARD_STATUSES)[number], ApplicationRow[]>;
}

export function deriveApplicationFunnel(applications: ApplicationRow[], now: Date) {
  const counts = Object.fromEntries(
    [
      "interested",
      "shortlisted",
      "cv_staged",
      "sent",
      "response",
      "interview",
      "offer",
      "closed",
    ].map((status) => [
      status,
      applications.filter((application) => application.status === status).length,
    ]),
  ) as Record<ApplicationStatus, number>;
  const cutoff = now.getTime() - 30 * 24 * 60 * 60 * 1_000;
  const interviewDates = applications.flatMap((application) =>
    application.status_history
      .filter((entry) => entry.status === "interview")
      .map((entry) => Date.parse(entry.at))
      .filter(Number.isFinite),
  );
  return {
    counts,
    interviewsAllTime: interviewDates.length,
    interviews30d: interviewDates.filter((timestamp) => timestamp >= cutoff).length,
  };
}

export function applicationAge(createdAt: string | null, now: number): string {
  if (!createdAt) return "age unknown";
  const elapsed = Math.max(0, now - Date.parse(createdAt));
  const days = Math.floor(elapsed / (24 * 60 * 60 * 1_000));
  if (days > 0) return `${days}d`;
  const hours = Math.floor(elapsed / (60 * 60 * 1_000));
  return hours > 0 ? `${hours}h` : "new";
}
