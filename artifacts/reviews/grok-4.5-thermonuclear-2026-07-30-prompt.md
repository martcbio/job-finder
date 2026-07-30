# Thermonuclear code review brief

Review this repository read-only:

`/Users/mcb/Claudelocal/careers/resume2/projects/job-finder-cursor-party`

The owner considers the current project name ridiculous and is considering
moving the system to:

`/Users/mcb/Claudelocal/careers/jobsradar`

This is a Bun/TypeScript job-acquisition, normalization, persistence, review,
API, UI, local Postgres, Modal and Supabase system. The immediate architectural
question is how to make raw job ingestion an explicit, wholly deterministic
product boundary: fetch public sources, preserve raw evidence, normalize,
deduplicate, persist, and report source health. Exclude summarization, subjective
ranking, ChatGPT Picks, CV generation and application submission from that
boundary.

Perform a thermonuclear review of the actual repository. Do not edit anything.
Use the available read/grep/find/ls tools and inspect source rather than trusting
docs. Avoid resume3 and any identity/private-output material.

Review:

1. Whether the current architecture really has a model-free deterministic raw
   ingestion path, and every place where it is coupled to classification,
   bookmark signals, ranking, URL verification, email or agent orchestration.
2. Source acquisition for lab ATS boards, Linear Careers, Google Careers and
   bounded JobServe; raw-response preservation, schemas, pagination, body
   completeness, retry/rate-limit/WAF behaviour and source-health semantics.
3. Normalization, canonical URL identity, deduplication, observation history,
   transactionality, idempotency and provenance.
4. Modal/Mac/Supabase/Postgres boundaries, fallback behaviour, parity and the
   possibility of a partial or stale run being presented as fresh.
5. The current `opps` wrapper and whether a pure `opps ingest`/jobsradar command
   can be carved out cleanly.
6. Naming, module boundaries, legacy Notion residue and whether the repository
   can safely move to `careers/jobsradar` without hard-coded-path or launchd,
   Modal, API, UI, database, backup or skill breakage.
7. Security, privacy, secret handling, SSRF, SQL construction, external side
   effects and destructive behaviour.
8. Test coverage, missing contract tests, observability and operational recovery.

Output one decisive report with:

- executive verdict;
- findings ordered P0 to P3;
- exact file and line evidence for every finding;
- confirmed strengths that should not be rewritten;
- a proposed target architecture for deterministic raw ingestion;
- a staged rename/migration plan to `careers/jobsradar`;
- tests and acceptance criteria for every stage;
- explicit non-goals;
- a smallest-safe-first implementation handoff for Codex.

Be adversarial. Reject speculative findings that the code does not support.
Distinguish source/network nondeterminism from model dependence and from
replayability. Do not praise generally; provide evidence.
