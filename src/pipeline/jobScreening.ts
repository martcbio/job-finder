import { isInsideIr35 } from "./ir35Signals";

export type JobScreeningStatus = "high_signal" | "needs_human_review" | "rejected";

export type JobScreeningReasonCode =
  | "closed_or_expired"
  | "inaccessible_page"
  | "index_or_not_job"
  | "us_remote_or_auth"
  | "latam_only"
  | "country_local_remote"
  | "locality_restricted_or_ambiguous"
  | "security_clearance"
  | "citizenship_or_work_authorization"
  | "candidate_identity_requirement"
  | "language_requirement"
  | "inside_ir35"
  | "government_ir35_risk"
  | "regular_hybrid_or_onsite"
  | "location_or_remote_unclear"
  | "missing_job_body"
  | "junior_or_intern"
  | "ops_primary"
  | "not_target_role";

export interface JobScreeningReason {
  code: JobScreeningReasonCode;
  detail: string;
}

export interface JobScreeningInput {
  title: string;
  companyHint: string | null;
  canonicalUrl: string;
  markdown: string | null;
  locationHint?: string | null;
  descriptionSample?: string | null;
  labels?: readonly { label: string }[];
}

export interface JobScreeningDecision {
  status: JobScreeningStatus;
  reasons: JobScreeningReason[];
  summary: string;
}

const CLOSED_PATTERNS = [
  /\bno longer accepting applications\b/i,
  /\bnot accepting applications\b/i,
  /\bapplication(?:s)? (?:are )?closed\b/i,
  /\bposition (?:has been )?closed\b/i,
  /\bjob (?:has )?expired\b/i,
  /\bjob is inactive\b/i,
  /\bjob (?:was|has been) removed\b/i,
  /\bjob posting is not available anymore\b/i,
  /\bjob posting (?:is )?not available\b/i,
  /\bnot currently active\b/i,
  /\bdeleted or hidden\b/i,
  /\brole is closed\b/i,
  /\bposition (?:has been )?filled\b/i,
  /\bthis job is no longer available\b/i,
  /\bthis position is no longer available\b/i,
];

const INACCESSIBLE_PATTERNS = [
  /\b404\b/i,
  /\btarget url returned error (?:400|401|403|404|410|429|500|502|503)\b/i,
  /\bexception occurred\b/i,
  /\bpage not found\b/i,
  /\bpage (?:you are looking for )?(?:does not|doesn't) exist\b/i,
  /\bnot found\b/i,
  /\b(?:does not|doesn't) exist\b/i,
  /\baccess denied\b/i,
  /\bverify you are human\b/i,
  /\bcaptcha\b/i,
  /\benable javascript\b/i,
  /\bjust a moment\b/i,
];

const COOKIE_WALL_PATTERNS = [
  /\bselect which cookies you accept\b/i,
  /\bplease enable cookies to continue\b/i,
  /\bcookie settings\b/i,
];

const INDEX_PATTERNS = [
  /\bview all jobs\b/i,
  /\bbrowse jobs\b/i,
  /\bopen positions\b/i,
  /\bopen roles\b/i,
  /\bjob board\b/i,
  /\bcareers page\b/i,
  /\bgeneral application\b/i,
  /%LABEL_DEPARTMENTS%/i,
  /%LABEL_NO_POSITIONS%/i,
  /%HEADER_OUR_OPENINGS%/i,
  /%DROPDOWN_/i,
  /%BUTTON_APPLY%/i,
];

const US_REMOTE_PATTERNS = [
  /\bremote\s*[-(,]?\s*(?:united states|u\.s\.|usa|us)\b/i,
  /\b(?:united states|u\.s\.|usa|us)\s*[-(,]?\s*remote\b/i,
  /\bus[-\s]?only\b/i,
  /\bmust be (?:based|located|resident) in (?:the )?(?:united states|u\.s\.|usa|us)\b/i,
  /\bauthorized to work in (?:the )?(?:united states|u\.s\.|usa|us)\b/i,
  /\bus work authorization\b/i,
  /\bus persons?\b/i,
];

const US_RESTRICTED_PATTERNS = [
  /\bremote\s*\(\s*(?:united states|u\.s\.|usa|us)\s*\)/i,
  /\bremote\s*[-–]\s*north america\b/i,
  /\bnorth america\s*\(\s*est\s*\)/i,
  /\bprimary location:\s*(?:united states|u\.s\.|usa|us)\b[\s\S]{0,180}\bworkplace type:\s*remote\b/i,
  /\ball listed locations:\s*(?:united states|u\.s\.|usa|us)\b[\s\S]{0,180}\bworkplace type:\s*remote\b/i,
  /\bfor this position,? we are looking to hire in (?:the )?(?:united states|u\.s\.|usa|us)\b/i,
  /\b(?:focusing on|prioriti[sz]ing) candidates in (?:the )?(?:united states|u\.s\.|usa|us)(?:\/canada)?\b/i,
  /\bmust be based in (?:the )?(?:united states|u\.s\.|usa|us)\b/i,
  /\bmust be based in (?:the )?(?:u\.s\.|us) and\b/i,
];

const US_ROLE_LOCATION_PATTERNS = [
  /^(?:united states|u\.s\.|usa|us)\s*$/im,
  /^north america\s*$/im,
  /\bsan francisco,\s*ca,\s*us\b/i,
  /\bnew york,\s*ny,\s*us\b/i,
  /\b(?:careers\s+)?[a-z0-9 ,/-]+\s+in\s+[a-z .'-]+,\s*(?:alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|washington dc|washington d\.c\.|west virginia|wisconsin|wyoming|dc|d\.c\.)\b/i,
  /\b(?:tysons corner|sunnyvale|mountain view|san francisco|new york|washington),\s*(?:va|ca|ny|dc|d\.c\.|virginia|california|new york)\b/i,
];

const LATAM_PATTERNS = [
  /\blatam\b/i,
  /\blatin america\b/i,
  /\bargentina\b/i,
  /\bbrazil\b/i,
  /\bcolombia\b/i,
  /\bmexico\b/i,
  /\bchile\b/i,
  /\bperu\b/i,
];

interface RestrictedLocalityPolicy {
  label: string;
  mentionPatterns: readonly RegExp[];
  restrictionPatterns: readonly RegExp[];
}

const RESTRICTED_LOCALITY_POLICIES: readonly RestrictedLocalityPolicy[] = [
  {
    label: "Switzerland",
    mentionPatterns: [/\bswitzerland\b/i, /\bswiss\b/i, /\bzurich\b/i, /\bgeneva\b/i, /\bbasel\b/i],
    restrictionPatterns: [
      /\bremote within switzerland\b/i,
      /\bswitzerland[-\s]?only\b/i,
      /\bswitzerland[-\s]?based\b/i,
      /\bswiss[-\s]?based\b/i,
      /\bmust be (?:based|located|resident) in switzerland\b/i,
      /\bbased in switzerland\b/i,
      /\bwork(?:ing)? from switzerland\b/i,
      /\b(?:zurich|geneva|basel)[-\s]?based\b/i,
      /\b(?:work|working|located|based) (?:from|in) (?:zurich|geneva|basel)\b/i,
      /\b(?:zurich|geneva|basel).{0,80}\bhybrid\b/i,
      /\bhybrid.{0,80}\b(?:zurich|geneva|basel)\b/i,
    ],
  },
];

const CLEARANCE_PATTERNS = [
  /\bactive (?:uk )?(?:sc|dv|nppv)\b/i,
  /\bcurrent (?:uk )?(?:sc|dv|nppv)\b/i,
  /\buk security clearance\b/i,
  /\b(?:sc|dv|nppv) clearance\b/i,
  /\b(?:secret|top secret|ts\/sci) clearance\b/i,
  /\bsecurity clearance required\b/i,
  /\brequired to (?:obtain|undergo|pass).{0,80}\b(?:security )?clearance\b/i,
  /\b(?:security )?clearance (?:will be|required|must be).{0,80}\b(?:obtained|undertaken|completed)\b/i,
  /\bmust (?:hold|have) .*security clearance\b/i,
  /\bpublic trust\b/i,
];

const CITIZENSHIP_OR_WORK_AUTHORIZATION_PATTERNS = [
  /\bmust (?:hold|have|possess) (?:a |an )?(?:valid )?(?:us|u\.s\.|united states|eu|e\.u\.|european union) passport\b/i,
  /\b(?:us|u\.s\.|united states|eu|e\.u\.|european union) (?:passport|citizenship) (?:is )?(?:required|mandatory)\b/i,
  /\bmust be (?:a |an )?(?:us|u\.s\.|united states|eu|e\.u\.|european union) citizen\b/i,
  /\b(?:us|u\.s\.|united states|eu|e\.u\.|european union) citizens? only\b/i,
  /\bmust (?:have|hold) (?:us|u\.s\.|united states|eu|e\.u\.|european union) work authori[sz]ation\b/i,
  /\b(?:must be|are) authori[sz]ed to work in (?:the )?(?:us|u\.s\.|united states|eu|e\.u\.|european union)\b/i,
];

const CANDIDATE_IDENTITY_REQUIREMENT_PATTERNS = [
  /\b(?:applicants?|candidates?) must be (?:a )?(?:woman|women|female)\b/i,
  /\b(?:women|female candidates?|women candidates?) only\b/i,
  /\bopen (?:only|exclusively) to women\b/i,
  /\bopen to women only\b/i,
];

const LANGUAGE_REQUIREMENT_PATTERNS = [
  /\bfluent (?:communication skills )?in english and (?:hungarian|italian|german|french|spanish|mandarin)\b/i,
  /\b(?:are|be)\s+fluent\s+in\s+(?:hungarian|italian|german|french|spanish|mandarin)\b/i,
  /\b(?:hungarian|italian|german|french|spanish|mandarin) (?:language skills|fluency) (?:are |is )?required\b/i,
  /\bindispensabile la conoscenza fluente di italiano\b/i,
];

const HYBRID_PATTERNS = [
  /\bhybrid\b/i,
  /\b(?:\d+|one|two|three|four|five)\s+days?\s+(?:a|per)\s+week.{0,40}\boffice\b/i,
  /\b(?:weekly|monthly)\s+(?:office|onsite|on-site)\b/i,
  /\bmust be able to commute\b/i,
  /\bin[-\s]?office\b/i,
  /\bon[-\s]?site\b/i,
  /\bin[-\s]?person\b/i,
];

const GOVERNMENT_WORK_PATTERNS = [
  /\b(?:uk|central|local) government (?:department|agency|client|contract|programme|program|project)\b/i,
  /\bpublic sector(?:\s+(?:client|contract|organisation|organization|department|agency|programme|program|project|environment))?\b/i,
  /\bcivil service\b/i,
];

const LOCAL_REMOTE_PATTERNS = [
  /\bremote[,:\s-]+india\b/i,
  /\bindia[,:\s-]+remote\b/i,
  /\bjob locations?\s+in[-\s]?remote\b/i,
  /\bin[-\s]?remote\b/i,
  /\bremote[,:\s-]+philippines\b/i,
  /\bremote[,:\s-]+pakistan\b/i,
  /\bremote[,:\s-]+egypt\b/i,
  /\bremote[,:\s-]+georgia\b/i,
  /\bremote[,:\s-]+serbia\b/i,
];

const JUNIOR_OR_INTERN_PATTERNS = [
  /\bintern(?:ship)?\b/i,
  /\bjunior (?:engineer|developer|software engineer|data scientist|machine learning engineer)\b/i,
  /\bnew grads? ok\b/i,
  /\bentry[-\s]?level\b/i,
];

const OPS_PRIMARY_PATTERNS = [
  /\bdevops engineer\b/i,
  /\bsre\b/i,
  /\bsite reliability engineer\b/i,
  /\binfrastructure engineer\b/i,
  /\bplatform engineer\b/i,
];

const NON_TARGET_TITLE_PATTERNS = [
  /\bcontroller\b/i,
  /\baccountant\b/i,
  /\baccounting\b/i,
  /\bfinance\b/i,
  /\btalent\b/i,
  /\brecruiter\b/i,
  /\bsales executive\b/i,
  /\baccount executive\b/i,
  /\b(?:pmo|project|product|program|programme|delivery) manage(?:r)?\b/i,
  /\bbusiness analyst\b/i,
  /\bvfx artist\b/i,
  /\bprivacy (?:&|and) responsible ai manager\b/i,
  /\bresponsible ai governance specialist\b/i,
  /\bcaregiver\b/i,
  /\bdisplay installer\b/i,
  /\bcustomer stories\b/i,
  /\bhome page\b/i,
  /\bnavigating the dashboard\b/i,
  /\bleave and attendance\b/i,
];

const GLOBAL_REMOTE_PATTERNS = [
  /\bworldwide\b/i,
  /\bwork from anywhere\b/i,
  /\bglobally distributed\b/i,
  /\bhire globally\b/i,
  /\bemployees worldwide\b/i,
  /\bremote across europe\b/i,
  /\bremote in europe\b/i,
  /\beurope[-\s]?wide\b/i,
];

const GENERIC_REMOTE_LOCATION_PATTERNS = [
  /\bremote\b/i,
  /\bwork from home\b/i,
  /\bdistributed (?:team|company|workforce|organization|organisation)\b/i,
];

const ACCEPTABLE_WORK_LOCATION_PATTERNS = [
  ...GLOBAL_REMOTE_PATTERNS,
  /\bworldwide\b/i,
  /\bwork from anywhere\b/i,
  /\b(?:singapore|london|united kingdom|uk|uae|dubai|abu dhabi)\b/i,
];

export function screenJob(input: JobScreeningInput): JobScreeningDecision {
  const text = [
    input.title,
    input.companyHint ?? "",
    input.canonicalUrl,
    input.locationHint ?? "",
    input.descriptionSample ?? "",
    input.markdown ?? "",
  ].join("\n");
  const locationText = input.locationHint
    ? [input.title, input.canonicalUrl, input.locationHint, input.descriptionSample ?? ""].join(
        "\n",
      )
    : text;
  const hardRejects: JobScreeningReason[] = [];
  const reviewReasons: JobScreeningReason[] = [];
  const globalRemote = matchesAny(text, GLOBAL_REMOTE_PATTERNS);
  const hasUsableJobBody = hasUsableJobDescription(text);
  const hasGenericRemoteLocationSignal = matchesAny(text, GENERIC_REMOTE_LOCATION_PATTERNS);
  const hasAcceptableWorkLocationSignal =
    globalRemote || matchesAny(text, ACCEPTABLE_WORK_LOCATION_PATTERNS);
  const restrictedLocality = detectRestrictedLocality(locationText);

  if (matchesAny(text, CLOSED_PATTERNS)) {
    hardRejects.push({
      code: "closed_or_expired",
      detail: "page says the role is closed, expired, filled, or no longer accepting applications",
    });
  }

  if (matchesAny(text, INACCESSIBLE_PATTERNS)) {
    hardRejects.push({
      code: "inaccessible_page",
      detail: "page snapshot is an inaccessible/error/CAPTCHA page rather than a usable job body",
    });
  }

  if (
    isMetadataOnly(input.markdown) ||
    isShortReaderSnapshot(input.markdown) ||
    (matchesAny(text, COOKIE_WALL_PATTERNS) && !hasUsableJobBody)
  ) {
    hardRejects.push({
      code: "inaccessible_page",
      detail: "page snapshot does not contain a usable job body",
    });
  }

  if (
    input.labels?.some((label) => label.label === "index_not_job") ||
    matchesAny(text, INDEX_PATTERNS) ||
    isCareersIndexPage(input, text)
  ) {
    hardRejects.push({
      code: "index_or_not_job",
      detail: "page looks like an index, careers page, or general application rather than one job",
    });
  }

  if (
    matchesAny(text, US_RESTRICTED_PATTERNS) ||
    matchesAny(locationText, US_ROLE_LOCATION_PATTERNS) ||
    (matchesAny(text, US_REMOTE_PATTERNS) && !globalRemote)
  ) {
    hardRejects.push({
      code: "us_remote_or_auth",
      detail: "listing appears US-remote, US-only, or US-work-authorization restricted",
    });
  }

  if (isLatamOnlyRemote(text, globalRemote)) {
    hardRejects.push({
      code: "latam_only",
      detail: "listing appears LATAM-only remote rather than broadly eligible remote",
    });
  }

  if (matchesAny(text, LOCAL_REMOTE_PATTERNS) && !globalRemote) {
    hardRejects.push({
      code: "country_local_remote",
      detail: "listing appears remote only within a specific country the candidate has not cleared",
    });
  }

  if (restrictedLocality?.explicitlyRestricted) {
    hardRejects.push({
      code: "locality_restricted_or_ambiguous",
      detail: `listing appears local to ${restrictedLocality.label}, where work eligibility has not been cleared`,
    });
  } else if (restrictedLocality && !globalRemote) {
    reviewReasons.push({
      code: "locality_restricted_or_ambiguous",
      detail: `${restrictedLocality.label} appears without an explicit global remote signal`,
    });
  }

  if (matchesAny(text, CLEARANCE_PATTERNS)) {
    hardRejects.push({
      code: "security_clearance",
      detail:
        "listing requires existing clearance or requires the candidate to obtain/undergo clearance",
    });
  }

  if (matchesAny(text, CITIZENSHIP_OR_WORK_AUTHORIZATION_PATTERNS)) {
    hardRejects.push({
      code: "citizenship_or_work_authorization",
      detail:
        "listing explicitly requires US/EU citizenship, a US/EU passport, or corresponding work authorization",
    });
  }

  if (matchesAny(text, CANDIDATE_IDENTITY_REQUIREMENT_PATTERNS)) {
    hardRejects.push({
      code: "candidate_identity_requirement",
      detail: "listing explicitly restricts eligibility to a candidate identity requirement",
    });
  }

  if (matchesAny(text, LANGUAGE_REQUIREMENT_PATTERNS)) {
    hardRejects.push({
      code: "language_requirement",
      detail: "listing appears to require a non-English language that has not been cleared",
    });
  }

  if (matchesAny(text, JUNIOR_OR_INTERN_PATTERNS)) {
    hardRejects.push({
      code: "junior_or_intern",
      detail: "listing is internship, junior, new-grad, or entry-level",
    });
  }

  if (isOpsPrimary(input.title, text)) {
    hardRejects.push({
      code: "ops_primary",
      detail:
        "listing is primarily DevOps/SRE/infrastructure operations rather than target AI product engineering",
    });
  }

  if (isNonTargetRole(input.title)) {
    hardRejects.push({
      code: "not_target_role",
      detail:
        "listing title is for a non-target business function rather than engineering/architecture/FDE/inference work",
    });
  }

  if (isInsideIr35(text)) {
    reviewReasons.push({
      code: "inside_ir35" as const,
      detail: "Inside IR35 is a strong negative",
    });
  }

  if (/\bcontract(?:or|ing)?\b/i.test(text) && matchesAny(text, GOVERNMENT_WORK_PATTERNS)) {
    reviewReasons.push({
      code: "government_ir35_risk",
      detail:
        "government contract requires manual IR35 verification even if advertised outside IR35",
    });
  }

  if (matchesAny(text, HYBRID_PATTERNS) && !isRemoteFirstOptionalOffice(text)) {
    reviewReasons.push({
      code: "regular_hybrid_or_onsite" as const,
      detail: "listing appears to require regular hybrid or on-site attendance",
    });
  }

  if (
    hardRejects.length === 0 &&
    hasUsableJobBody &&
    !hasGenericRemoteLocationSignal &&
    !hasAcceptableWorkLocationSignal
  ) {
    reviewReasons.push({
      code: "location_or_remote_unclear",
      detail: "listing has a usable body but no explicit remote or acceptable-location signal",
    });
  }

  if (
    hardRejects.length === 0 &&
    hasUsableJobBody &&
    hasGenericRemoteLocationSignal &&
    !hasAcceptableWorkLocationSignal
  ) {
    reviewReasons.push({
      code: "location_or_remote_unclear",
      detail:
        "listing only says remote/distributed without an explicit global, Europe-remote, or acceptable-region signal",
    });
  }

  if (hardRejects.length > 0) {
    return {
      status: "rejected",
      reasons: uniqueReasons(hardRejects),
      summary: formatSummary("rejected", hardRejects),
    };
  }

  if (reviewReasons.length > 0) {
    return {
      status: "needs_human_review",
      reasons: uniqueReasons(reviewReasons),
      summary: formatSummary("needs human review", reviewReasons),
    };
  }

  return {
    status: "high_signal",
    reasons: [],
    summary: "high signal: no deterministic blocker found",
  };
}

function isLatamOnlyRemote(text: string, globalRemote: boolean): boolean {
  if (globalRemote) return false;
  if (!matchesAny(text, LATAM_PATTERNS)) return false;
  if (!/\bremote\b/i.test(text)) return false;
  return (
    /\blatam(?:[-\s]?only)?\b/i.test(text) ||
    /\blatin america(?:[-\s]?only)?\b/i.test(text) ||
    /\b(?:based|located|resident) in latam\b/i.test(text) ||
    /\bremote(?:\s+role|\s+job)?\s+(?:for|in)\s+(?:latam|latin america)\b/i.test(text)
  );
}

function detectRestrictedLocality(
  text: string,
): { label: string; explicitlyRestricted: boolean } | null {
  const roleText = text
    .split("\n")
    .filter(
      (line) => !/\b(?:personal data|privacy notice|privacy shield|data protection)\b/i.test(line),
    )
    .join("\n");
  for (const policy of RESTRICTED_LOCALITY_POLICIES) {
    if (!matchesAny(roleText, policy.mentionPatterns)) continue;
    return {
      label: policy.label,
      explicitlyRestricted: matchesAny(roleText, policy.restrictionPatterns),
    };
  }
  return null;
}

function isRemoteFirstOptionalOffice(text: string): boolean {
  return (
    /\bremote[-\s]?first\b/i.test(text) ||
    /\boptional office\b/i.test(text) ||
    /\boffice access\b/i.test(text) ||
    /\boption to use (?:our )?offices\b/i.test(text)
  );
}

function isMetadataOnly(markdown: string | null): boolean {
  if (!markdown) return true;
  const trimmed = markdown.trim();
  return /^## ATS Structured Data\b/i.test(trimmed) && trimmed.length < 700;
}

function isShortReaderSnapshot(markdown: string | null): boolean {
  if (!markdown) return true;
  const trimmed = markdown.trim();
  return /^Title:\s*/i.test(trimmed) && /\nURL Source:\s*/i.test(trimmed) && trimmed.length < 700;
}

function isCareersIndexPage(input: JobScreeningInput, text: string): boolean {
  const url = input.canonicalUrl.toLowerCase();
  const title = input.title.trim().toLowerCase();
  const looksLikeCareersRoot =
    /\/careers\/?$/.test(url) ||
    /\/jobs\/?$/.test(url) ||
    title === "careers" ||
    title.startsWith("careers at ");
  if (!looksLikeCareersRoot) return false;
  if (/\/jobdetails\//.test(url) || /\/jobs\/[a-z0-9-]+/i.test(url)) return false;

  const jobDetailLinks = text.match(/\/(?:careers\/)?jobdetails\/\d+/gi)?.length ?? 0;
  const indexFields = [
    /\bdepartment\b/i,
    /\blocation\b/i,
    /\bjob type\b/i,
    /\bopen positions\b/i,
    /\bfull time\b/i,
  ].filter((pattern) => pattern.test(text)).length;

  return jobDetailLinks >= 2 || indexFields >= 3;
}

function hasUsableJobDescription(text: string): boolean {
  if (text.length < 1200) return false;
  return /\b(responsibilities|requirements|qualifications|what you.?ll do|about the role|about you)\b/i.test(
    text,
  );
}

function isOpsPrimary(title: string, text: string): boolean {
  if (!matchesAny(title, OPS_PRIMARY_PATTERNS)) return false;
  if (/\bai platform engineer\b/i.test(title)) return false;
  if (/\bsoftware engineer\b/i.test(title) && !/\bdevops\b/i.test(title)) return false;
  return matchesAny(text, [
    /\bprovisioning\b/i,
    /\binfrastructure-as-code\b/i,
    /\bci\/cd\b/i,
    /\bdeployment pipelines?\b/i,
    /\bobservability\b/i,
    /\bincident response\b/i,
    /\bproduction operations\b/i,
  ]);
}

function isNonTargetRole(title: string): boolean {
  return matchesAny(title, NON_TARGET_TITLE_PATTERNS);
}

function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

function uniqueReasons(reasons: JobScreeningReason[]): JobScreeningReason[] {
  const seen = new Set<JobScreeningReasonCode>();
  const unique: JobScreeningReason[] = [];
  for (const reason of reasons) {
    if (seen.has(reason.code)) continue;
    seen.add(reason.code);
    unique.push(reason);
  }
  return unique;
}

function formatSummary(status: string, reasons: JobScreeningReason[]): string {
  return `${status}: ${uniqueReasons(reasons)
    .map((reason) => reason.code)
    .join(", ")}`;
}
