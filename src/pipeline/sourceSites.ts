import type { TimeFilter } from "./searchEngines";

export const JOB_SOURCE_SITES = [
  {
    id: "greenhouse",
    label: "Greenhouse",
    site: "greenhouse.io",
    filters: ["greenhouse.io"],
    jobUrlPatterns: [/greenhouse\.io\/(?:[^/?#]+\/jobs\/\d+|job-boards\/[^/?#]+\/jobs\/\d+)/],
  },
  {
    id: "lever",
    label: "Lever",
    site: "lever.co",
    filters: ["lever.co"],
    jobUrlPatterns: [/jobs\.lever\.co\/[^/?#]+\/[0-9a-f-]{16,}/],
  },
  {
    id: "ashby",
    label: "Ashby",
    site: "ashbyhq.com",
    filters: ["ashbyhq.com"],
    jobUrlPatterns: [/jobs\.ashbyhq\.com\/[^/?#]+\/[0-9a-f-]{16,}/],
  },
  {
    id: "remote-rocketship",
    label: "Remote Rocketship",
    site: "remoterocketship.com",
    filters: ["remoterocketship.com"],
  },
  {
    id: "pinpoint",
    label: "Pinpoint",
    site: "pinpointhq.com",
    filters: ["pinpointhq.com"],
    jobUrlPatterns: [/pinpointhq\.com\/(?:[^/?#]+\/)?postings\//],
  },
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
  {
    id: "workable",
    label: "Workable",
    site: "jobs.workable.com",
    filters: ["jobs.workable.com"],
    jobUrlPatterns: [/jobs\.workable\.com\/(?:view|j)\//],
  },
  {
    id: "breezyhr",
    label: "BreezyHR",
    site: "breezy.hr",
    filters: ["breezy.hr"],
    jobUrlPatterns: [/breezy\.hr\/p\//],
  },
  { id: "wellfound", label: "Wellfound", site: "wellfound.com", filters: ["wellfound.com"] },
  {
    id: "y-combinator",
    label: "Y Combinator Work at a Startup",
    site: "workatastartup.com",
    filters: ["workatastartup.com"],
    jobUrlPatterns: [/workatastartup\.com\/jobs\/\d+/],
  },
  {
    id: "oracle-cloud",
    label: "Oracle Cloud",
    site: "oraclecloud.com",
    filters: ["oraclecloud.com"],
    jobUrlPatterns: [/oraclecloud\.com\/hcmui\/candidateexperience\/(?:en\/)?sites\//],
  },
  {
    id: "workday",
    label: "Workday Jobs",
    site: "myworkdayjobs.com",
    filters: ["myworkdayjobs.com"],
    jobUrlPatterns: [/myworkdayjobs\.com\/[^/?#]+\/job\//],
  },
  {
    id: "recruitee",
    label: "Recruitee",
    site: "recruitee.com",
    filters: ["recruitee.com"],
    jobUrlPatterns: [/recruitee\.com\/o\//],
  },
  {
    id: "rippling",
    label: "Rippling",
    site: "rippling",
    filters: ["rippling.com", "rippling-ats.com"],
    jobUrlPatterns: [/rippling-ats\.com\/job\//, /rippling\.com\/[^?#]*\/jobs?\//],
  },
  {
    id: "gusto",
    label: "Gusto",
    site: "jobs.gusto.com",
    filters: ["jobs.gusto.com"],
    jobUrlPatterns: [/jobs\.gusto\.com\/jobs\//],
  },
  {
    id: "careerpuck",
    label: "CareerPuck",
    site: "careerpuck.com",
    filters: ["careerpuck.com"],
    jobUrlPatterns: [/careerpuck\.com\/jobs?\//],
  },
  {
    id: "teamtailor",
    label: "Teamtailor",
    site: "teamtailor.com",
    filters: ["teamtailor.com"],
    jobUrlPatterns: [/teamtailor\.com\/jobs\/\d+/],
  },
  {
    id: "smartrecruiters",
    label: "SmartRecruiters",
    site: "jobs.smartrecruiters.com",
    filters: ["jobs.smartrecruiters.com"],
    jobUrlPatterns: [/jobs\.smartrecruiters\.com\/[^/?#]+\/\d+/],
  },
  {
    id: "talentreef",
    label: "TalentReef",
    site: "jobappnetwork.com",
    filters: ["jobappnetwork.com"],
    jobUrlPatterns: [/jobappnetwork\.com\/clients\//],
  },
  {
    id: "homerun",
    label: "Homerun",
    site: "homerun.co",
    filters: ["homerun.co"],
    jobUrlPatterns: [/homerun\.co\/[^/?#]+\/jobs\//],
  },
  {
    id: "gem",
    label: "Gem",
    site: "gem.com",
    filters: ["gem.com"],
    jobUrlPatterns: [/gem\.com\/jobs?\//],
  },
  {
    id: "trakstar",
    label: "Trakstar",
    site: "trakstar.com",
    filters: ["trakstar.com"],
    jobUrlPatterns: [/trakstar\.com\/jobs?\//],
  },
  {
    id: "cats",
    label: "Cats",
    site: "catsone.com",
    filters: ["catsone.com"],
    jobUrlPatterns: [/catsone\.com\/careers\//],
  },
  {
    id: "jazzhr",
    label: "JazzHR",
    site: "applytojob.com",
    filters: ["applytojob.com"],
    jobUrlPatterns: [/applytojob\.com\/apply\//],
  },
  {
    id: "jobvite",
    label: "Jobvite",
    site: "jobvite.com",
    filters: ["jobvite.com"],
    jobUrlPatterns: [/jobvite\.com\/[^?#]*\/jobs?\//],
  },
  {
    id: "icims",
    label: "iCIMS",
    site: "icims.com",
    filters: ["icims.com"],
    jobUrlPatterns: [/icims\.com\/jobs\/\d+\//],
  },
  {
    id: "dover",
    label: "Dover",
    site: "dover.io",
    filters: ["dover.io"],
    jobUrlPatterns: [/dover\.io\/(?:jobs|open-roles|openings)\//],
  },
  {
    id: "notion",
    label: "Notion",
    site: "notion.site",
    filters: ["notion.site"],
    jobUrlPatterns: [/notion\.site\/[^?#]*(?:job|career|role|opening)/],
  },
  { id: "builtin", label: "Builtin", site: "builtin.com/job/", filters: ["builtin.com/job/"] },
  {
    id: "adp",
    label: "ADP",
    site: "adp",
    filters: ["workforcenow.adp.com", "myjobs.adp.com"],
    jobUrlPatterns: [
      /workforcenow\.adp\.com\/[^?#]*\/recruitment\/recruitment\.html/,
      /myjobs\.adp\.com\/[^?#]*\/jobs\//,
    ],
  },
  { id: "linkedin", label: "LinkedIn", site: "linkedin.com", filters: ["linkedin.com/jobs"] },
  {
    id: "glassdoor",
    label: "Glassdoor",
    site: "glassdoor.com/job-listing/",
    filters: ["glassdoor.com/job-listing/"],
  },
  {
    id: "factorial",
    label: "Factorial",
    site: "factorialhr.com",
    filters: ["factorialhr.com"],
    jobUrlPatterns: [/factorialhr\.com\/jobs?\//],
  },
  {
    id: "trinet-hire",
    label: "TriNet Hire",
    site: "trinethire.com",
    filters: ["trinethire.com"],
    jobUrlPatterns: [/trinethire\.com\/jobs?\//],
  },
  {
    id: "other-pages",
    label: "Other Pages",
    site: "other-pages",
    filters: ["/employment/", "/opportunities/", "/openings/", "/join-us/", "/work-with-us/"],
  },
] as const;

export type JobSourceSite = (typeof JOB_SOURCE_SITES)[number];
export type JobSourceSiteId = JobSourceSite["id"];

export const DRAFT_JOB_SOURCE_IDS = [
  "linkedin",
  "glassdoor",
  "wellfound",
  "remote-rocketship",
] as const satisfies readonly JobSourceSiteId[];

export type DraftJobSourceId = (typeof DRAFT_JOB_SOURCE_IDS)[number];

const DRAFT_JOB_SOURCE_ID_SET = new Set<JobSourceSiteId>(DRAFT_JOB_SOURCE_IDS);

export const REQUIRED_JOB_SOURCE_SITES = JOB_SOURCE_SITES.filter(
  (site) => !DRAFT_JOB_SOURCE_ID_SET.has(site.id),
);

export interface JobSourceSearchOptions {
  keyword: string;
  includeRemote: boolean;
  location: string | null;
  timeFilter: TimeFilter;
}

export type JobSourceSearchTarget =
  | {
      kind: "search-query";
      site: JobSourceSite;
      query: string;
      filters: readonly string[];
      jobUrlPatterns: readonly RegExp[];
    }
  | {
      kind: "direct-url";
      site: JobSourceSite;
      url: string;
    };

const LINKEDIN_RECENT_FILTERS: Partial<Record<TimeFilter, string>> = {
  "1hour": "r3600",
  "4hours": "r14400",
  "8hours": "r28800",
  "12hours": "r43200",
  "24hours": "r86400",
  "48hours": "r172800",
  "72hours": "r259200",
  year: "r31536000",
};

const REMOTE_ELIGIBILITY_EXCLUSIONS = [
  '-"United States"',
  '-"US Remote"',
  '-"Remote US"',
  '-"Remote, US"',
  "-LATAM",
  '-"Latin America"',
  "-Intern",
  "-Internship",
  '-"General Application"',
];

function normalizeLookupValue(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isOlderThanFilter(timeFilter: TimeFilter): boolean {
  return ["older1month", "older3months", "older6months"].includes(timeFilter);
}

function getQuerySuffix(options: JobSourceSearchOptions): string {
  const parts: string[] = [];
  if (options.includeRemote) parts.push("remote");
  if (options.location) parts.push(options.location);
  if (options.includeRemote) parts.push(...REMOTE_ELIGIBILITY_EXCLUSIONS);
  return parts.length > 0 ? ` ${parts.join(" ")}` : "";
}

function quotedKeyword(keyword: string): string {
  return `"${keyword.replaceAll('"', '\\"')}"`;
}

export function resolveJobSourceSites(values: string[]): JobSourceSite[] {
  if (values.length === 0) return [];
  if (values.some((value) => value.toLowerCase() === "all")) return [...JOB_SOURCE_SITES];

  const sitesByLookup = new Map<string, JobSourceSite>();
  for (const site of JOB_SOURCE_SITES) {
    sitesByLookup.set(site.id, site);
    sitesByLookup.set(normalizeLookupValue(site.label), site);
    sitesByLookup.set(normalizeLookupValue(site.site), site);
  }

  const resolved: JobSourceSite[] = [];
  for (const value of values) {
    const site = sitesByLookup.get(normalizeLookupValue(value));
    if (!site) {
      throw new Error(
        `Unsupported job source "${value}". Supported sources: all, ${JOB_SOURCE_SITES.map((item) => item.id).join(", ")}`,
      );
    }
    if (!resolved.some((item) => item.id === site.id)) {
      resolved.push(site);
    }
  }

  return resolved;
}

export function isDraftJobSourceSite(site: JobSourceSite): boolean {
  return DRAFT_JOB_SOURCE_ID_SET.has(site.id);
}

export function buildJobSourceSearchTarget(
  site: JobSourceSite,
  options: JobSourceSearchOptions,
): JobSourceSearchTarget {
  const suffix = getQuerySuffix(options);
  const title = quotedKeyword(options.keyword);

  switch (site.id) {
    case "remote-rocketship":
      return {
        kind: "direct-url",
        site,
        url: `https://remoterocketship.com/?ref=job-finder&jobTitle=${encodeURIComponent(options.keyword)}`,
      };
    case "adp":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:workforcenow.adp.com OR site:myjobs.adp.com)${suffix}`,
        filters: site.filters,
        jobUrlPatterns: getJobUrlPatterns(site),
      };
    case "rippling":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:rippling.com OR site:rippling-ats.com)${suffix}`,
        filters: site.filters,
        jobUrlPatterns: getJobUrlPatterns(site),
      };
    case "careers-pages":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:careers.* OR site:*/careers/* OR site:*/career/*)${suffix}`,
        filters: site.filters,
        jobUrlPatterns: getJobUrlPatterns(site),
      };
    case "other-pages":
      return {
        kind: "search-query",
        site,
        query: `${title} (site:*/employment/* OR site:*/opportunities/* OR site:*/openings/* OR site:*/join-us/* OR site:*/work-with-us/*)${suffix}`,
        filters: site.filters,
        jobUrlPatterns: getJobUrlPatterns(site),
      };
    case "linkedin": {
      if (isOlderThanFilter(options.timeFilter)) {
        return {
          kind: "search-query",
          site,
          query: `${title} site:linkedin.com/jobs/view${suffix}`,
          filters: site.filters,
          jobUrlPatterns: getJobUrlPatterns(site),
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
        jobUrlPatterns: getJobUrlPatterns(site),
      };
  }
}

function getJobUrlPatterns(site: JobSourceSite): readonly RegExp[] {
  return "jobUrlPatterns" in site ? site.jobUrlPatterns : [];
}
