import type { BrianTimeFilter } from "./searchEngines";

export const BRIAN_JOB_SITES = [
  { id: "greenhouse", label: "Greenhouse", site: "greenhouse.io", filters: ["greenhouse.io"] },
  { id: "lever", label: "Lever", site: "lever.co", filters: ["lever.co"] },
  { id: "ashby", label: "Ashby", site: "ashbyhq.com", filters: ["ashbyhq.com"] },
  {
    id: "remote-rocketship",
    label: "Remote Rocketship",
    site: "remoterocketship.com",
    filters: ["remoterocketship.com"],
  },
  { id: "pinpoint", label: "Pinpoint", site: "pinpointhq.com", filters: ["pinpointhq.com"] },
  { id: "jobs-subdomain", label: "Jobs Subdomain", site: "jobs.*", filters: ["jobs."] },
  {
    id: "careers-pages",
    label: "Careers Pages",
    site: "careers.*",
    filters: ["careers.", "/careers/", "/career/"],
  },
  { id: "people-subdomain", label: "People Subdomain", site: "people.*", filters: ["people."] },
  { id: "talent-subdomain", label: "Talent Subdomain", site: "talent.*", filters: ["talent."] },
  {
    id: "paylocity",
    label: "Paylocity",
    site: "recruiting.paylocity.com",
    filters: ["recruiting.paylocity.com"],
  },
  { id: "keka", label: "Keka", site: "keka.com", filters: ["keka.com"] },
  { id: "workable", label: "Workable", site: "jobs.workable.com", filters: ["jobs.workable.com"] },
  { id: "breezyhr", label: "BreezyHR", site: "breezy.hr", filters: ["breezy.hr"] },
  { id: "wellfound", label: "Wellfound", site: "wellfound.com", filters: ["wellfound.com"] },
  {
    id: "y-combinator",
    label: "Y Combinator Work at a Startup",
    site: "workatastartup.com",
    filters: ["workatastartup.com"],
  },
  {
    id: "oracle-cloud",
    label: "Oracle Cloud",
    site: "oraclecloud.com",
    filters: ["oraclecloud.com"],
  },
  {
    id: "workday",
    label: "Workday Jobs",
    site: "myworkdayjobs.com",
    filters: ["myworkdayjobs.com"],
  },
  { id: "recruitee", label: "Recruitee", site: "recruitee.com", filters: ["recruitee.com"] },
  {
    id: "rippling",
    label: "Rippling",
    site: "rippling",
    filters: ["rippling.com", "rippling-ats.com"],
  },
  { id: "gusto", label: "Gusto", site: "jobs.gusto.com", filters: ["jobs.gusto.com"] },
  { id: "careerpuck", label: "CareerPuck", site: "careerpuck.com", filters: ["careerpuck.com"] },
  { id: "teamtailor", label: "Teamtailor", site: "teamtailor.com", filters: ["teamtailor.com"] },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    site: "jobs.smartrecruiters.com",
    filters: ["jobs.smartrecruiters.com"],
  },
  {
    id: "talentreef",
    label: "TalentReef",
    site: "jobappnetwork.com",
    filters: ["jobappnetwork.com"],
  },
  { id: "homerun", label: "Homerun", site: "homerun.co", filters: ["homerun.co"] },
  { id: "gem", label: "Gem", site: "gem.com", filters: ["gem.com"] },
  { id: "trakstar", label: "Trakstar", site: "trakstar.com", filters: ["trakstar.com"] },
  { id: "cats", label: "Cats", site: "catsone.com", filters: ["catsone.com"] },
  { id: "jazzhr", label: "JazzHR", site: "applytojob.com", filters: ["applytojob.com"] },
  { id: "jobvite", label: "Jobvite", site: "jobvite.com", filters: ["jobvite.com"] },
  { id: "icims", label: "iCIMS", site: "icims.com", filters: ["icims.com"] },
  { id: "dover", label: "Dover", site: "dover.io", filters: ["dover.io"] },
  { id: "notion", label: "Notion", site: "notion.site", filters: ["notion.site"] },
  { id: "builtin", label: "Builtin", site: "builtin.com/job/", filters: ["builtin.com/job/"] },
  {
    id: "adp",
    label: "ADP",
    site: "adp",
    filters: ["workforcenow.adp.com", "myjobs.adp.com"],
  },
  { id: "linkedin", label: "LinkedIn", site: "linkedin.com", filters: ["linkedin.com/jobs"] },
  {
    id: "glassdoor",
    label: "Glassdoor",
    site: "glassdoor.com/job-listing/",
    filters: ["glassdoor.com/job-listing/"],
  },
  { id: "factorial", label: "Factorial", site: "factorialhr.com", filters: ["factorialhr.com"] },
  { id: "trinet-hire", label: "TriNet Hire", site: "trinethire.com", filters: ["trinethire.com"] },
  {
    id: "other-pages",
    label: "Other Pages",
    site: "other-pages",
    filters: ["/employment/", "/opportunities/", "/openings/", "/join-us/", "/work-with-us/"],
  },
] as const;

export type BrianJobSite = (typeof BRIAN_JOB_SITES)[number];
export type BrianJobSiteId = BrianJobSite["id"];

export interface BrianSiteSearchOptions {
  keyword: string;
  includeRemote: boolean;
  location: string | null;
  timeFilter: BrianTimeFilter;
}

export type BrianSiteSearchTarget =
  | {
      kind: "search-query";
      site: BrianJobSite;
      query: string;
      filters: readonly string[];
    }
  | {
      kind: "direct-url";
      site: BrianJobSite;
      url: string;
    };

const LINKEDIN_RECENT_FILTERS: Partial<Record<BrianTimeFilter, string>> = {
  "1hour": "r3600",
  "4hours": "r14400",
  "8hours": "r28800",
  "12hours": "r43200",
  "24hours": "r86400",
  "48hours": "r172800",
  "72hours": "r259200",
  year: "r31536000",
};

function normalizeLookupValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isOlderThanFilter(timeFilter: BrianTimeFilter): boolean {
  return ["older1month", "older3months", "older6months"].includes(timeFilter);
}

function getQuerySuffix(options: BrianSiteSearchOptions): string {
  const parts: string[] = [];
  if (options.includeRemote) parts.push("remote");
  if (options.location) parts.push(options.location);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function quotedKeyword(keyword: string): string {
  return `"${keyword.replaceAll('"', '\\"')}"`;
}

export function resolveBrianJobSites(values: string[]): BrianJobSite[] {
  if (values.length === 0) return [];
  if (values.some((value) => value.toLowerCase() === "all")) return [...BRIAN_JOB_SITES];

  const sitesByLookup = new Map<string, BrianJobSite>();
  for (const site of BRIAN_JOB_SITES) {
    sitesByLookup.set(site.id, site);
    sitesByLookup.set(normalizeLookupValue(site.label), site);
    sitesByLookup.set(normalizeLookupValue(site.site), site);
  }

  const resolved: BrianJobSite[] = [];
  for (const value of values) {
    const site = sitesByLookup.get(normalizeLookupValue(value));
    if (!site) {
      throw new Error(
        `Unsupported Brian site "${value}". Supported sites: all, ${BRIAN_JOB_SITES.map((item) => item.id).join(", ")}`,
      );
    }
    if (!resolved.some((item) => item.id === site.id)) {
      resolved.push(site);
    }
  }

  return resolved;
}

export function buildBrianSiteSearchTarget(
  site: BrianJobSite,
  options: BrianSiteSearchOptions,
): BrianSiteSearchTarget {
  const suffix = getQuerySuffix(options);
  const title = quotedKeyword(options.keyword);

  switch (site.id) {
    case "remote-rocketship":
      return {
        kind: "direct-url",
        site,
        url: `https://remoterocketship.com/?ref=briansjobsearch&jobTitle=${encodeURIComponent(options.keyword)}`,
      };
    case "adp":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:workforcenow.adp.com OR site:myjobs.adp.com)${suffix}`,
        filters: site.filters,
      };
    case "rippling":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:rippling.com OR site:rippling-ats.com)${suffix}`,
        filters: site.filters,
      };
    case "careers-pages":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:careers.* OR site:*/careers/* OR site:*/career/*)${suffix}`,
        filters: site.filters,
      };
    case "other-pages":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:*/employment/* OR site:*/opportunities/* OR site:*/openings/* OR site:*/join-us/* OR site:*/work-with-us/*)${suffix}`,
        filters: site.filters,
      };
    case "linkedin": {
      if (isOlderThanFilter(options.timeFilter)) {
        return {
          kind: "search-query",
          site,
          query: `${title} site:linkedin.com/jobs/view${suffix}`,
          filters: site.filters,
        };
      }

      const location = options.location ?? (options.includeRemote ? "Remote" : "United States");
      const recentFilter = LINKEDIN_RECENT_FILTERS[options.timeFilter] ?? "r10800";
      return {
        kind: "direct-url",
        site,
        url: `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(options.keyword)}&location=${encodeURIComponent(location)}&f_TPR=${recentFilter}`,
      };
    }
    default:
      return {
        kind: "search-query",
        site,
        query: `${title} site:${site.site}${suffix}`,
        filters: site.filters,
      };
  }
}
