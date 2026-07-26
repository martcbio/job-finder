# PRD: Database-Backed Job Search, Classification, and Review Pipeline

## Problem Statement

The current job-search workflow is too manual and too ephemeral.

The user has a working search pattern: generate targeted search queries across many applicant tracking systems and job-board surfaces, then click through results manually. This finds better opportunities than browsing generic aggregators, but the process is tedious, hard to repeat, and hard to inspect after the fact.

The current fork of `job-finder` proves that automated source fanout is feasible. It can generate source-specific search links, call search providers, report token usage where applicable, and capture outward job result data such as title, URL, source, and description. A proof sweep captured outward records from most configured sources, but also showed real source-level differences: some sources are direct-link generators, some named ATS sources work well, and some broad or hostile sources time out or return poor results.

The user wants to move beyond proof artifacts into a normalized, durable database-backed system. The system should ingest broadly, dedupe conservatively, classify jobs into useful opportunity categories, support human review until trust is established, and eventually assemble CV/application material from trusted bullet blocks based on job focus.

Notion may remain useful as an integration target or review/export layer, but it is secondary. The source of truth should be a normal database, likely local Postgres.

## Solution

Build a local Postgres-backed job-search pipeline inside the current `job-finder` fork.

The first implementation milestone is durable search persistence:

- Store every search run, query, result, timeout, token report, and normalized job observation in a schema-separated Postgres namespace.
- Preserve raw outward data from search results while also creating normalized job records.
- Dedupe exact duplicates automatically and record possible duplicates conservatively rather than discarding plausible jobs.
- Generate proof/review summaries from Postgres instead of transient JSON files.
- Keep Notion, scheduling, deep classification, CV generation, and application automation out of the first milestone.

Subsequent milestones add:

- Full-page ingestion using native ATS APIs first, then HTTP extraction, then Jina Reader, then browser automation only as a last resort.
- Two-stage classification: lightweight classification from search metadata, then upgraded classification from full-page snapshots.
- Human review state and structured feedback.
- CV bullet libraries and per-job draft generation.
- Optional Notion export/import once the database-backed pipeline is stable.

The system should optimize first for correctness and auditability, second for token cost visibility, and third for speed/concurrency.

## User Stories

1. As a job seeker, I want to run one command that fans out across configured job sources, so that I do not need to manually click dozens of source checkboxes and search links.

2. As a job seeker, I want every run to be saved in Postgres, so that I can inspect what happened after the command exits.

3. As a job seeker, I want every source query to record success, timeout, error, duration, and token usage, so that I can understand which sources are useful and which are expensive.

4. As a job seeker, I want search result titles, descriptions, URLs, and source labels preserved, so that the outward evidence is immediately reviewable.

5. As a job seeker, I want search failures stored as first-class records, so that a source timing out is visible instead of silently disappearing.

6. As a job seeker, I want direct-link sources to be represented differently from search-result sources, so that LinkedIn and Remote Rocketship do not look like failed scrapes.

7. As a job seeker, I want the system to ingest broadly across many ATS and career surfaces, so that I see opportunities outside the obvious Greenhouse/Lever/Ashby paths.

8. As a job seeker, I want exact duplicates merged conservatively, so that repeated runs do not flood my review queue with identical postings.

9. As a job seeker, I want fuzzy or cross-source duplicates recorded as possible duplicate relationships instead of being discarded, so that similar postings from different advertisers are not accidentally lost.

10. As a job seeker, I want source-specific health metrics, so that high-yield sources can run more often and low-yield sources can run less often.

11. As a job seeker, I want every normalized job to point back to the raw search result that created it, so that I can audit why it exists.

12. As a job seeker, I want every job observation to be retained, so that I can see how a job appeared across repeated runs or multiple sources.

13. As a job seeker, I want the runner to fail loudly when Postgres is unavailable, so that I do not accidentally run an ephemeral scrape.

14. As a job seeker, I want database setup to be explicit and versioned, so that schema changes are reviewable and reproducible.

15. As a job seeker, I want the job-search database schema isolated from unrelated Postgres workloads, so that this project cannot collide with other local databases or schemas.

16. As a developer, I want plain SQL migrations with checksums, so that database evolution is transparent and not hidden behind a migration framework.

17. As a developer, I want a database preflight command, so that connection, schema, migration status, and search path problems are caught before ingestion.

18. As a developer, I want a migration command that is idempotent and non-destructive, so that I can safely apply pending migrations during iteration.

19. As a developer, I want the DB-backed search runner to reuse the existing source fanout logic, so that source definitions do not drift between proof and production paths.

20. As a developer, I want generated Markdown summaries to come from Postgres, so that reports reflect durable data rather than ad hoc JSON artifacts.

21. As a job seeker, I want lightweight classification from search metadata, so that the system can prioritize which results deserve full-page ingestion.

22. As a job seeker, I want full-page classification after ingestion, so that final labels are based on richer job text and not only search snippets.

23. As a job seeker, I want job categories to be multi-label, so that a role can be both agentic engineering and enterprise RAG, or FDE and solutions engineering.

24. As a job seeker, I want classification labels separated from fit decisions, so that category discovery does not prematurely hide jobs.

25. As a job seeker, I want initial categories for agentic engineer, agentic architect, RAG enterprise, FDE, inference engineer, ML platform, backend product engineering, developer tools, internal AI tooling, AI enablement, AI operations, AI/business automation, workplace AI, AI adoption/transformation, data engineering, security AI, founding engineer, AI product manager, non-engineering, staffing/agency, and index/not-job patterns, so that the review queue reflects the kinds of roles I care about.

26. As a job seeker, I want human review to remain mandatory until the pipeline is trusted, so that automation does not apply or discard too aggressively.

27. As a job seeker, I want structured review states, so that jobs can move from new to review, shortlist, CV tailoring, application, waiting, rejection, or stale states without ambiguous booleans.

28. As a job seeker, I want review feedback reason codes, so that the system can later learn which sources, categories, and patterns are useful.

29. As a job seeker, I want review feedback to be stored without automatic retraining at first, so that we can gather evidence before changing pipeline behavior.

30. As a job seeker, I want full-page ingestion to prefer native ATS APIs when available, so that we avoid unnecessary Jina Reader token spend and brittle scraping.

31. As a job seeker, I want Jina Search to be used for discovery but not automatically for every page ingestion, so that token cost stays measurable and controlled.

32. As a job seeker, I want Jina Reader used only when cheaper structured paths fail or are unavailable, so that expensive ingestion is reserved for cases where it adds value.

33. As a job seeker, I want browser automation treated as a last resort, so that the core pipeline remains headless, cheap, and reproducible.

34. As a job seeker, I want manual saved sweeps before scheduled recurring sweeps, so that cost and source quality are understood before automation runs unattended.

35. As a job seeker, I want scheduling deferred until source health is visible, so that timeout-heavy sources do not burn budget repeatedly.

36. As a job seeker, I want reusable CV bullet blocks organized by focus area, so that future applications can be tailored without hallucinating experience.

37. As a job seeker, I want the system to recommend CV focus themes from job classifications, so that applications can emphasize agentic engineering, enterprise RAG, FDE, inference, or other relevant strengths.

38. As a job seeker, I want generated CV/application drafts to remain human-reviewed, so that the system assists rather than acts autonomously.

39. As a developer, I want Notion integration to remain optional, so that the database-backed pipeline can work even without Notion credentials.

40. As a developer, I want the current local fork to continue as the implementation home, so that existing ATS clients, tests, and search fanout work can be reused.

41. As a developer, I want the original upstream repository to remain available as a reference, so that useful future changes can be copied in without constraining this local fork.

42. As a developer, I want no Docker dependency in the local workflow, so that the system fits the user's local Postgres setup and machine conventions.

43. As a developer, I want every external dependency failure to be explicit, so that missing tokens, broken search paths, DB errors, and source timeouts are distinguishable.

44. As a developer, I want source timeout and retry behavior to be configurable per run, so that broad sweeps cannot hang indefinitely.

45. As a developer, I want token usage stored per completed Jina call, so that cost can be analyzed by source, query, keyword, and run.

46. As a developer, I want timeout calls to record that usage was not reported, so that the cost accounting does not claim false precision.

47. As a developer, I want exact canonical URL dedupe in the first DB-backed runner, so that durable ingestion can ship before fuzzy dedupe is perfect.

48. As a developer, I want possible duplicate detection to be added as a relationship table, so that later fuzzy logic can be reviewed and corrected.

49. As a job seeker, I want index pages and generic career pages marked as low-quality or not-job candidates, so that noisy broad-source results do not pollute the review queue.

50. As a job seeker, I want the first milestone to produce the same kind of proof summary already generated from JSON, so that behavior can be compared before and after Postgres persistence.

## Implementation Decisions

- The current fork remains the implementation home. It has a clean imported baseline commit and follow-up local work that adds Notion-free source fanout. The project can keep evolving locally; useful upstream changes can be copied in later.

- Notion is secondary. The normalized Postgres database becomes the source of truth. Notion may later be used as an export, review, or synchronization target, but it should not gate the main ingestion pipeline.

- The first implementation milestone is Postgres persistence for search runs, search queries, search results, normalized jobs, job observations, duplicate candidate relationships, and review event foundations.

- The database target is local Postgres only. Docker is out of scope. Colima is a stretch option only if absolutely necessary, but the expected path is an existing local Postgres instance.

- The job-search data must be schema-separated from other workloads. Use a dedicated schema named `job_search` and explicitly set search path to `job_search, public, pg_temp` for application connections.

- Database setup is explicit. The runner must not silently create tables on first use. It should require a versioned migration step before ingestion.

- Migrations are plain versioned SQL files. Each migration is append-only, runs in a transaction, records a checksum, and fails loudly on checksum drift.

- The migration tracker lives inside the `job_search` schema.

- The first database commands are:
  - database check command
  - migration command
  - DB-backed search command
  - proof-summary export command

- The database check command validates connection, current user, current database, server version, effective schema/search path, and migration status.

- The migration command creates or updates only the `job_search` schema and its owned tables. It must be idempotent and non-destructive.

- The DB-backed search runner reuses the existing source definitions, search engine URL builder, query construction, search wrapper, timeout handling, progress logging, and title-preserving result filtering.

- The first DB-backed runner should support manual saved sweeps. Scheduling is deferred until source-level cost and yield are understood.

- The search runner must persist both successful and failed source attempts. A timeout is a result of the run and must be stored.

- Source health metrics should be derivable from stored query records. Metrics include success rate, timeout count, last success, average duration, average reported tokens, and average result count.

- Token usage is tracked per Jina call when response headers are available. Timeout calls may not report token usage and must be represented as unknown rather than zero.

- Direct URL sources are valid but distinct from search-result sources. LinkedIn and Remote Rocketship should be represented as direct link observations, not as failed scrapes.

- Search result persistence stores raw outward evidence: title, description, raw URL, canonical URL, source label, query, rank, and company hint.

- Normalized job records are created from search results using conservative exact dedupe first.

- The dedupe hierarchy is:
  1. exact canonical job URL
  2. ATS-native identity when parseable
  3. redirect-resolved canonical URL when cheap and safe
  4. company plus normalized title plus source family
  5. fuzzy title/company similarity as a possible duplicate only

- Ingest should not hard-drop plausible jobs. Exact canonical duplicates update the existing job and add a new observation. Fuzzy or cross-source duplicates are stored as candidate relationships with confidence, reason, and review state.

- A `job` means one advertised posting. A stricter `role` abstraction above job is deferred.

- The initial schema includes foundations for review state and review events, but does not implement a full review UI.

- The first review states should support at least: new, needs page ingest, needs classification, ready for review, shortlisted, needs CV tailoring, ready to apply, applied, waiting, rejected by us, rejected by company, stale, duplicate candidate, and not relevant.

- Human review remains mandatory until the pipeline proves itself. Agents may prepare recommendations and drafts, but application/outreach behavior stays human-gated.

- Location and authorization preferences are maintained in `docs/opportunity-criteria.md` and mirrored by the first evaluation filter. Current high-level rules: reject US-only roles and explicit US/EU passport, citizenship, or work-authorization requirements; keep hybrid/on-site roles but flag their attendance requirements; treat Switzerland-only remote as suspect unless outside-Switzerland remote is explicit; reject security-clearance and explicit unsatisfied candidate-identity requirements; keep Inside IR35 roles but flag them as a major caveat.

- Review feedback should be structured from day one. Store shortlist/reject/maybe/duplicate/stale/bad-parse/wrong-category decisions, reason codes, and freeform notes.

- Classification is intentionally deferred until after durable search persistence, but its architecture is decided.

- Classification is two-stage:
  - stage 1: lightweight classification from search metadata
  - stage 2: upgraded classification from full-page ingestion

- Classification labels are multi-label and non-destructive. Fit/review assessment is separate from category labels.

- Initial classification labels include agentic engineer, agentic architect, RAG enterprise, FDE, solutions engineer, inference engineer, ML platform, backend product engineer, developer tools, internal AI tooling, AI enablement, AI operations, AI/business automation, workplace AI, AI adoption/transformation, data engineer, security AI, founding engineer, AI product manager, non-engineering, staffing/agency, and index/not-job.

- Full-page ingestion is deferred until after durable search persistence.

- Full-page ingestion fallback order is:
  1. native ATS API/client where available
  2. plain HTTP fetch and HTML extraction
  3. Jina Reader
  4. browser automation

- Existing native ATS clients are valuable and should be reused before adding new scraping routes.

- Jina Search is for discovery. Jina Reader should not be the default ingestion path.

- Browser automation is a last resort, not the default path.

- CV tailoring is deferred until classification and review foundations exist, but the chosen unit is reusable CV bullet blocks rather than whole generated CVs.

- CV bullet blocks should be keyed by themes such as agentic engineer, agentic architect, RAG enterprise, FDE, inference engineer, platform/backend, developer tools, internal AI tooling, AI enablement, and AI/business automation.

- Application drafts should compose trusted bullet blocks and remain human-reviewed.

- Generated proof artifacts are derived outputs. JSON and Markdown proof files should not be treated as the durable source of truth once Postgres persistence exists.

The initial schema decision from the prototype/Q&A is:

```text
job_search.schema_migrations

job_search.search_runs
  id
  started_at
  finished_at
  status
  keyword
  source_set
  time_filter
  include_remote
  location
  limit_per_query
  timeout_ms
  total_reported_tokens
  error_summary

job_search.search_queries
  id
  run_id
  source_label
  source_id
  query
  direct_url
  status
  started_at
  finished_at
  usage_tokens
  decompressed_bytes
  error

job_search.search_results
  id
  query_id
  rank
  title_raw
  description_raw
  url_raw
  url_canonical
  company_hint
  created_at

job_search.jobs
  id
  canonical_key
  canonical_url
  title_normalized
  company_hint
  first_seen_at
  last_seen_at
  review_state

job_search.job_observations
  id
  job_id
  search_result_id
  observed_at
  observed_title
  observed_url
  observed_company_hint

job_search.duplicate_candidates
  id
  job_id_a
  job_id_b
  confidence
  reason
  state
  created_at

job_search.review_events
  id
  job_id
  from_state
  to_state
  reason_codes
  note
  actor
  created_at
```

## Testing Decisions

- Tests should focus on externally visible behavior, not internal implementation details.

- Database migration tests should verify that migrations can be applied to an empty schema, are idempotent, and record checksum/version state.

- Migration drift tests should verify that a changed migration checksum fails loudly.

- Database preflight tests should verify that missing connection configuration, missing schema, and pending migrations fail with clear errors.

- Search persistence tests should verify that a run creates one run record, query records, result records, job records, and job observation records.

- Search failure tests should verify that timeouts and source errors are persisted as query failures rather than dropped.

- Direct URL source tests should verify that direct links are stored as direct observations without requiring Jina Search.

- Exact dedupe tests should verify that repeated canonical URLs update an existing job's last-seen timestamp and add a new observation rather than creating a duplicate job.

- Possible duplicate tests should verify that fuzzy or cross-source duplicate candidates can be stored without suppressing either job.

- Canonical URL tests should cover scheme normalization, tracking parameter removal, fragment removal, trailing slash handling, and known ATS URL shapes.

- Source health export tests should verify that success counts, failure counts, result counts, and token usage are computed from persisted query records.

- Proof-summary export tests should verify that Markdown summaries are generated from Postgres and include coverage and outward evidence rows.

- Existing tests around search, ATS parsing, retry, rate limiting, and structural filtering should remain in place and be used as prior art for behavior-first tests.

- Jina network calls should not be required in unit tests. Use mocked search responses for persistence and export tests.

- Integration tests may run against a real local Postgres schema, but they must use a clearly isolated test schema or transaction cleanup.

- Tests must not require Docker.

- Tests should make timeout and missing-token failures explicit rather than assuming credential absence.

## Out of Scope

- Auto-applying to jobs.

- Sending outreach or externally visible messages.

- Fully restoring Notion as the primary persistence layer.

- Scheduling recurring sweeps.

- Browser automation for job pages.

- Deep full-page ingestion.

- Stage-1 or stage-2 classification implementation.

- LLM-based fit assessment.

- CV bullet library implementation.

- Generated CV/application drafts.

- UI work beyond CLI output and Markdown export.

- Aggressive fuzzy dedupe that suppresses jobs automatically.

- Docker-based Postgres setup.

- Cloud deployment.

- Websocket or push-notification behavior.

## Further Notes

- The proof sweep showed that broad searches can be expensive. Completed calls across the proof and retries reported 671143 Jina tokens, not counting failed timeout calls where usage headers were unavailable.

- The proof sweep captured outward records for most named sources, but ADP, Glassdoor, and Other Pages timed out, Dover returned no useful records, and LinkedIn/Remote Rocketship are direct-link sources rather than scrape-result sources.

- Source failures are not a reason to remove sources yet. They are evidence that source-level health metrics and query-shape experimentation are needed.

- The first DB-backed implementation should preserve the current search-only behavior while adding durable persistence. It should not attempt to solve classification, CV tailoring, scheduling, or Notion in the same pass.

- The local branch currently has a clean history shape: one baseline import commit and one search-fanout commit. The PRD describes the next milestone on top of that local fork.
