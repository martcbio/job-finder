import type { AtsOrgJob } from "../services/ats/types";
import { screenJob } from "./jobScreening";

export type LocationEligibilityStatus = "eligible" | "ineligible" | "undecided";
export type RoleRelevanceStatus = "relevant" | "irrelevant" | "undecided";
export type OpeningDisposition =
  | "suitable"
  | "unsuitable_location"
  | "unsuitable_role"
  | "undecided";

export interface OpeningDecision<Status extends string> {
  status: Status;
  reasonCodes: string[];
}

export interface LabOpeningDecision {
  locationEligibility: OpeningDecision<LocationEligibilityStatus>;
  roleRelevance: OpeningDecision<RoleRelevanceStatus>;
  disposition: OpeningDisposition;
}

const ELIGIBLE_LOCATION =
  /\b(?:uk|united kingdom|england|scotland|wales|northern ireland|london|paris|france|ireland|dublin|germany|munich|berlin|spain|madrid|barcelona|sweden|stockholm|netherlands|amsterdam|belgium|brussels|switzerland|zurich|geneva|italy|milan|rome|poland|warsaw|krakow|portugal|lisbon|denmark|copenhagen|norway|oslo|finland|helsinki|austria|vienna|czech(?:ia| republic)|prague|greece|athens|romania|bucharest|bulgaria|sofia|croatia|zagreb|slovenia|ljubljana|slovakia|bratislava|hungary|budapest|estonia|tallinn|latvia|riga|lithuania|vilnius|iceland|reykjavik|luxembourg|malta|cyprus|europe|european union|eu|emea)\b/i;
const ACCEPTED_NON_US_LOCATION = /\b(?:singapore|uae|dubai|abu dhabi)\b/i;
const US_LOCATION =
  /\b(?:united states|usa|u\.s\.|us only|remote\s*[-–—,/(]\s*us|san francisco|new york|seattle|washington,?\s*d\.?c\.?|boston|los angeles|california|new jersey|texas|colorado|massachusetts|pennsylvania|virginia|georgia|oregon|illinois|florida|hawaii)\b/i;

const IRRELEVANT_ROLE_RULES: Array<[RegExp, string]> = [
  [/\bmarketing\b/i, "role.marketing"],
  [/\b(?:account executive|sales|business development)\b/i, "role.sales"],
  [
    /\b(?:recruiter|recruiting|talent acquisition|human resources|people partner)\b/i,
    "role.people",
  ],
  [/\b(?:support engineer|it support|support delivery)\b/i, "role.support"],
  [
    /\b(?:security operations manager|threat investigator|protection scientist)\b/i,
    "role.security_operations",
  ],
  [/\bsecurity (?:and )?compliance manager\b/i, "role.security_management"],
  [/\b(?:communications?|copy) lead\b|\bart director\b/i, "role.communications"],
  [/\b(?:product|program|project) manager\b/i, "role.management"],
  [
    /\bdata center (?:electrical|mechanical|energy|hardware|design)\b/i,
    "role.physical_infrastructure",
  ],
  [/\btraining,?\s+process management engineer\b/i, "role.training_operations"],
  [/\b(?:legal|counsel|attorney|contracts manager)\b/i, "role.legal"],
  [/\b(?:finance|accounting|controller|payroll)\b/i, "role.finance"],
];
const RELEVANT_ROLE =
  /\b(?:software|engineer|engineering|developer|architect|technical|infrastructure|platform|reliability|backend|front.?end|full.?stack|devops|ml|machine learning|ai|artificial intelligence|inference|research scientist|research engineer|member of technical staff|security)\b/i;

function normalizedLocations(job: AtsOrgJob): string[] {
  const values = job.locations.length > 0 ? job.locations : [job.location];
  return values.map((value) => value.trim()).filter(Boolean);
}

/** Classifies only broad location eligibility; posting-specific passport rules are screened later. */
export function classifyLocation(job: AtsOrgJob): OpeningDecision<LocationEligibilityStatus> {
  const locations = normalizedLocations(job);
  if (locations.some((location) => ELIGIBLE_LOCATION.test(location))) {
    return { status: "eligible", reasonCodes: ["location.europe_or_uk"] };
  }
  if (locations.some((location) => ACCEPTED_NON_US_LOCATION.test(location))) {
    return { status: "eligible", reasonCodes: ["location.accepted_non_us"] };
  }
  if (locations.length > 0 && locations.every((location) => US_LOCATION.test(location))) {
    return { status: "ineligible", reasonCodes: ["location.us_only"] };
  }
  return { status: "undecided", reasonCodes: ["location.unrecognized"] };
}

export function classifyRole(job: AtsOrgJob): OpeningDecision<RoleRelevanceStatus> {
  const title = job.title?.trim() ?? "";
  const body = openingBody(job.raw);
  if (
    body &&
    screenJob({
      title,
      companyHint: job.company ?? null,
      canonicalUrl: job.url,
      markdown: body,
    }).reasons.some((reason) => reason.code === "language_requirement")
  ) {
    return { status: "irrelevant", reasonCodes: ["role.language_requirement"] };
  }
  for (const [pattern, reasonCode] of IRRELEVANT_ROLE_RULES) {
    if (pattern.test(title)) return { status: "irrelevant", reasonCodes: [reasonCode] };
  }
  if (RELEVANT_ROLE.test(title)) {
    return { status: "relevant", reasonCodes: ["role.technical"] };
  }
  return { status: "undecided", reasonCodes: ["role.unrecognized"] };
}

export function classifyLabOpening(job: AtsOrgJob): LabOpeningDecision {
  const locationEligibility = classifyLocation(job);
  const roleRelevance = classifyRole(job);
  const disposition: OpeningDisposition =
    locationEligibility.status === "ineligible"
      ? "unsuitable_location"
      : roleRelevance.status === "irrelevant"
        ? "unsuitable_role"
        : locationEligibility.status === "eligible" && roleRelevance.status === "relevant"
          ? "suitable"
          : "undecided";
  return { locationEligibility, roleRelevance, disposition };
}

function openingBody(raw: unknown): string {
  if (!raw || typeof raw !== "object") return "";
  const record = raw as Record<string, unknown>;
  return ["descriptionPlain", "description", "content"]
    .map((key) => record[key])
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
}
