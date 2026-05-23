# Fast Refresh API And Source Contract

This document is the detailed contract for promoting the native fast-refresh proof into a stable API-backed service and source-adapter layer.

The goal is to make new sources boring to add while preserving the evidence that tells us whether a source is actually useful: identity, links, full-text status, eligibility flags, ranking, cost, and latency.

## Scope

The next backend milestone should do three things:

- Extract fast-refresh orchestration out of `scripts/fast-refresh.ts` into a reusable module.
- Expose the same behavior through the local JSON API and the CLI.
- Define source-adapter outputs that can handle normal ATS/direct sources and awkward sources without pretending they all behave the same.

The UI should consume this API. It should not parse CLI markdown, query Postgres directly, or encode source-specific scraping logic.

## Core API Routes

The first stable UI-facing API should include:

- `POST /api/refresh/fast`
- `GET /api/jobs/latest?limit=20`
- `GET /api/jobs/:id`
- `GET /api/runs/:id`

`POST /api/refresh/fast` should run the native fast-refresh path and return JSON with:

- elapsed milliseconds
- source-by-source discovery counts
- source-by-source imported counts
- source-by-source full-text/page counts
- classification count
- token/cost usage by stage
- run ids created
- latest ranked jobs
- direct-source jobs
- explicit errors or blocked states

`GET /api/jobs/latest` should be fast DB readback. It should not trigger network calls.

`GET /api/jobs/:id` should expose job detail, including full text where available.

`GET /api/runs/:id` should expose run evidence: source attempts, errors, costs, timings, and counts.

## Job Summary Shape

The UI should build mostly from a stable `JobSummary` style shape:

```ts
type JobSummary = {
  id: number;
  title: string;
  company: string | null;
  location: string | null;
  source: {
    id: string;
    label: string;
    kind: "direct_employer" | "ats" | "recruiter" | "aggregator" | "search" | "protected";
    quality: "high" | "medium" | "low" | "opportunistic";
  };
  links: Array<{
    kind: "canonical" | "source" | "apply" | "employer" | "tracking";
    url: string;
    blocked?: boolean;
    note?: string;
  }>;
  classification: {
    category: string;
    labels: string[];
    ragFocus: "yes" | "no" | "unknown";
    enterpriseFocus: "yes" | "no" | "unknown";
    confidence: number | null;
  };
  eligibility: {
    status: "likely_ok" | "needs_review" | "likely_reject";
    flags: string[];
    reasons: string[];
  };
  ingest: {
    fullTextStatus:
      | "success"
      | "snippet_only"
      | "blocked"
      | "expired"
      | "error"
      | "pending";
    firstSeenAt: string;
    lastSeenAt: string;
    postedAt: string | null;
  };
  ranking: {
    tier: number | null;
    score: number | null;
    reasons: string[];
  };
  reviewState: string;
};
```

The existing normalized ingest shape remains useful as the adapter ingress shape:

```ts
type NormalizedJobInput = {
  sourceId: string;
  sourceLabel: string;
  searchLabel: string | null;
  searchTerm: string | null;
  title: string;
  company: string | null;
  url: string;
  sourceUrl: string | null;
  description: string;
  location: string | null;
  employmentType: string | null;
  compensation: string | null;
  raw: unknown;
};
```

But the API should not stop there. It should add extracted link, eligibility, source-quality, full-text, and ranking facts.

## Source Adapter Contract

Each source should have a small adapter contract:

```ts
type SourceAdapter = {
  id: string;
  label: string;
  kind: "direct_employer" | "ats" | "recruiter" | "aggregator" | "search" | "protected";
  discover(input: SourceDiscoveryInput): Promise<SourceDiscoveryResult>;
  normalize(raw: unknown): NormalizedJobInput[];
  extractFacts?(job: NormalizedJobInput): ExtractedJobFacts;
};
```

Adapter outputs must include:

- candidate count or explicit zero-results state
- normalized jobs where available
- raw payload/evidence
- source-specific identity if known
- link facts if known
- full-text status if attempted
- explicit failure reason if blocked or errored
- cost and latency metrics

No adapter should silently degrade into vague rows. If the source is snippet-only, redirect-only, CAPTCHA-gated, stale, or missing identity, that must be visible.

## Source Outcomes

Every source attempt should preserve the detailed internal outcome and expose a
smaller UI/API `status`.

Detailed internal outcomes:

- `success`
- `zero_results`
- `snippet_only`
- `blocked_captcha`
- `blocked_auth`
- `blocked_robots_or_waf`
- `redirect_only`
- `expired`
- `parse_error`
- `timeout`
- `http_error`
- `not_implemented`

UI/API source-attempt statuses:

- `success`
- `zero_results`
- `partial`
- `blocked`
- `timeout`
- `parser_error`
- `rate_limited`
- `auth_required`

These states are not all fatal. For example, `partial` can still produce
reviewable candidates; `blocked` can demote a source to opportunistic;
`zero_results` is a successful empty search.

## Identity And Dedupe

Source adapters should emit the strongest identity available:

- ATS identity: `greenhouse:<org>:<job_id>`, `lever:<org>:<job_id>`, `ashby:<org>:<job_id>`, `workable:<org>:<job_id>`
- direct-source identity: `linear:<uuid>` or equivalent
- JobServe identity: `jobserve:<job_id>`
- fallback canonical URL
- weak fallback: company plus normalized title plus location plus posted date

Dedupe remains conservative:

- exact identities may upsert the same normalized job
- fuzzy or cross-source matches become duplicate candidates
- do not auto-delete, auto-merge, auto-hide, or suppress plausible distinct listings
- two recruiters advertising the same underlying role is acceptable; mark possible duplicates rather than discarding one

## Link Semantics

Do not treat every URL as the same thing. Store and expose links by kind:

- `canonical`: the best readable job detail URL
- `source`: the listing or board URL where we found it
- `apply`: application URL
- `employer`: direct employer/careers URL, if known
- `tracking`: tracking or redirect URL

If a link is CAPTCHA-gated, auth-gated, or redirect-only, mark it as blocked rather than dropping it.

JobG8 is the motivating example: the JobServe detail page is readable, while the JobG8 traffic/apply URL is CAPTCHA-gated. Both facts are useful, but they are not equivalent.

## Full-Text Status

Full-text ingest must be separately visible from discovery.

Possible statuses:

- `success`: public full text is stored
- `snippet_only`: only outward search/listing text is available
- `blocked`: source blocks automated detail access
- `expired`: job page indicates the role is closed/removed
- `error`: fetch or parse failed
- `pending`: detail ingest has not yet been attempted

Ranking and classification should prefer full text when available, but source/listing snippets can still produce candidates for human review.

## Classification Versus Ranking

Classification answers: what kind of job is this?

Examples:

- `agentic_engineer`
- `agentic_architect`
- `fde`
- `inference_engineer`
- `rag_enterprise`
- `solutions_engineer`
- `security_ai`
- `backend_product_engineering`
- `ai_enablement`
- `internal_ai_tooling`
- `business_automation_ai`
- `ai_operations`
- `workplace_ai`
- `ai_adoption_transformation`

Ranking answers: should this be looked at now?

Ranking should consider:

- category match
- eligibility flags
- geography
- source quality
- posted/freshness signals
- full-text availability
- recruiter/agency status
- compensation/contract status when known

A role can be correctly classified as `agentic_engineer` and still be ranked low because it is US-only, security-clearance gated, stale, or staffing spam.

## Eligibility Flags

The API should expose reviewable eligibility flags instead of hard-coded pass/fail hiding.

Current user constraints:

- US remote is generally bad because of passport/work authorization constraints.
- EU-based jobs are generally bad if they require in-situ EU presence.
- EU remote may be fine, especially if only occasional business meetings are required.
- Switzerland remote likely needs special review because in-situ requirements may apply.
- London, Singapore, UAE, and interesting AI-lab in-person roles are worth review.
- Inside IR35 is a strong negative unless the company or role is exceptional.
- UK security clearance requirements are likely reject.
- Generic `remote` or `distributed` alone is not enough to mark high signal.

Possible API flags:

- `us_remote_problem`
- `eu_in_situ_problem`
- `eu_remote_possible`
- `switzerland_review`
- `inside_ir35`
- `outside_ir35`
- `security_clearance_required`
- `interesting_location`
- `ai_lab_exception_possible`
- `generic_remote_needs_review`
- `recruiter_or_agency`

Eligibility status should be one of:

- `likely_ok`
- `needs_review`
- `likely_reject`

Strong roles should remain reviewable rather than silently filtered unless the evidence is decisive.

## Source Quality

Sources should carry quality metadata:

- `high`: direct employer or clean ATS/public endpoint
- `medium`: useful board or recruiter source with readable detail pages
- `low`: weak snippets, stale pages, or noisy aggregators
- `opportunistic`: hostile/protected, CAPTCHA-gated, auth-gated, or search-result-only

Known examples:

- JobServe: useful medium-quality contract/recruiter source
- Linear Careers: high-quality direct employer source
- JobG8 apply hops: protected/opportunistic because traffic URLs lead to CAPTCHA
- LinkedIn, Glassdoor, Wellfound, Remote Rocketship: draft/opportunistic unless a cheap reliable path is proven

## Cost And Latency Accounting

Every refresh result should report:

- elapsed milliseconds
- source network calls
- billable search API calls
- Jina Search tokens
- Jina Reader tokens
- OpenAI/LLM tokens
- rows discovered
- rows persisted
- rows classified
- rows with full text
- failure/blocked counts by source

Unknown usage should be reported as unknown, not zero. True zero should be used only when the path does not touch a billable API.

## Verification

Completion evidence for this milestone should include:

- deterministic unit tests for source parsing and API shape
- API contract tests for the new refresh/latest/detail routes
- a timed live CLI run
- a timed live API-triggered run
- evidence that CLI and API use the same underlying fast-refresh module
- evidence that JobServe and Linear Careers both write normalized jobs to Postgres
- evidence that latest jobs include direct links, classification labels, full-text status, eligibility flags, ranking reasons, token/cost usage, and elapsed time

The goal is not to make every source perfect. It is to make source behavior honest and cheap to extend.
