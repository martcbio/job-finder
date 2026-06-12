# Blog Posts After GPT Pro Review - 2026-06-09

This file supersedes the title wording in `artifacts/job-market/2026-06-07/blog_posts_curated.md`.

The underlying themes remain mostly right, but the titles have been revised from taxonomy labels into reader promises. The review also identified one important evidence correction: `job_801` is not weak "AI garnish"; its raw body supports a separate inference/runtime engineering lane.

## Top 3 To Write First

### 1. The Permission Model Is Part of the Prompt

- Why first: strongest title and crosses security, RAG, context, product boundaries, and enterprise AI.
- Supported themes: `t02`, `t05`; audit clusters `c02`, `c06`.
- Best evidence:
  - `job_846`: "data governance, and responsible AI principles" in complex multi-stakeholder AI/ML/data-heavy product setting.
  - `job_817`: observability, guardrails, output validation, human-in-the-loop design, and risk mitigation.
  - `job_814`: secure, scalable, production-ready agent systems.
  - `job_663`: security and architecture reviews, integration workshops, repeatable patterns and playbooks.
- Concrete post artifact: permission matrix, prompt/context access rules, redaction strategy, audit event schema, human-review gate.
- Risk: do not over-cite `job_922` as direct security evidence; use it only as an enterprise-documents scenario.

### 2. The Eval Set Is the Spec

- Why first: crisp technical worldview, directly supported by eval/reliability postings.
- Supported themes: `t04`, `t06`; audit cluster `c03`.
- Best evidence:
  - `job_826`: "Designing and implementing evaluation frameworks for LLM-based systems" and "Improving output quality through structured evals."
  - `job_827`: "improving relevance, quality, and reliability in a live, customer-facing system."
  - `job_800`: "Context Engineering" and "Evaluation Harness" in title/body.
  - `job_817`: observability, logging, tracing, evaluation pipelines, guardrails, and output validation.
  - `job_762`: production-grade multi-agent workflows, orchestration, RAG, observability, and evaluation.
- Concrete post artifact: feature spec converted into eval cases, trace examples, prompt/context diffs, regression test before/after.
- Risk: avoid making this only about "context engineering"; evidence is broader: context, evals, traces, reliability.

### 3. Your LLM Feature Needs a Rollback Plan

- Why first: best broad signal for production AI engineering and maps to the strongest market centre of gravity.
- Supported themes: `t01`, `t04`; audit clusters `c01`, `c03`.
- Best evidence:
  - `job_923`: production-grade autonomous/agentic platform work, workflow automation, intelligent decision support, deep commercial-platform integration.
  - `job_826`: AI-powered services in Python plus LLM evaluation frameworks.
  - `job_827`: relevance, quality, reliability in a live customer-facing system.
  - `job_814`: secure, scalable, production-ready agent systems.
  - `job_817`: observability, guardrails, output validation, human review, and risk mitigation.
- Concrete post artifact: API contract, eval suite, traces, feature flag, rollback rule, incident checklist.
- Risk: keep it scoped to one feature; otherwise it becomes generic "production AI" prose.

## Revised 10-Post Shortlist

1. **Your LLM Feature Needs a Rollback Plan**
   - Replaces: "Build the LLM feature like production software, not a demo"
   - Status: keep, high priority.

2. **Your Agent Needs Fewer Tools and Better Boundaries**
   - Replaces: "Agentic workflows need product boundaries before autonomy"
   - Status: keep, high priority.
   - Add evidence from `job_817` and `job_762`.

3. **The Eval Set Is the Spec**
   - Replaces: "Context engineering is the test surface"
   - Status: keep, top priority.
   - Broaden evidence to context + evals + traces + reliability.

4. **Enterprise AI Happens in the Glue Code**
   - Replaces: "Enterprise AI architecture is mostly integration architecture"
   - Status: keep.
   - Focus on APIs, identity, source systems, audit, ownership, deployment, handoff.

5. **The Permission Model Is Part of the Prompt**
   - Replaces: "Security and governance as AI product requirements"
   - Status: keep, top priority.
   - Use `job_846`, `job_817`, `job_814`, `job_928`, `job_663`.

6. **RAG Fails Before Search**
   - Replaces: "Retrieval quality before vector database selection"
   - Status: revise, medium evidence.
   - Safer subtitle: "RAG quality is an ingestion, indexing, and eval problem."

7. **AI Products Inherit the Data Mess**
   - Replaces: "AI data engineering is still data engineering"
   - Status: keep.
   - Focus on freshness, permissions, data contracts, lineage, ingestion, downstream answer quality.

8. **The Demo Was the Easy Part**
   - Replaces: "Forward-deployed AI without theatre"
   - Status: keep but not top-three.
   - Must be a concrete discovery-to-handoff case study.

9. **AI-Native, AI-Adjacent, or Just Recruiter SEO?**
   - Replaces: "How to tell an AI-native role from AI garnish"
   - Status: keep, but fix evidence.
   - Do not use `job_801` as weak evidence. Collapse duplicate 83Zero roles.

10. **What Goes in the Backlog When the Brief Just Says "Use AI"?**
   - Replaces: "AI product ownership: from vague transformation brief to buildable backlog"
   - Status: keep, later priority.
   - Needs backlog slices and acceptance criteria to remain engineering-relevant.

## Added Candidate Post

### Inference Engineering Is Where AI Becomes Systems Engineering

- Why add: GPT Pro identified a missing role-family lane.
- Evidence:
  - `job_801`: concrete inference/runtime role, "porting and optimising inference engines to run efficiently on edge hardware."
  - `job_773`: inference engines such as llama.cpp, ggml, ONNX runtimes, memory efficiency, runtime stability, on-device AI performance.
- Status: promising but needs more evidence before replacing the top-three.
- Concrete post artifact: latency/memory budget, runtime profile, model-load path, edge deployment constraints, fallback behavior.

## Evidence Corrections

- `job_801` must move out of "AI garnish"; it is a real inference/runtime role.
- `job_817` must move up; bland title but strong body evidence for agentic systems, guardrails, observability, and risk controls.
- The 83Zero `AI+Fullstack` postings should be deduplicated before using them as demand evidence.
- Title-only snippets should be treated as extraction weakness, not proof that a role is weak.
- Metadata/search labels such as priority notes must not count as job-market evidence.

## Next Pipeline Improvements

- Add body-only evidence extraction.
- Add evidence grades:
  - body-level responsibility
  - body-level required skill
  - body-level stack/platform
  - title-only
  - metadata-only
  - inferred label only
  - recruiter boilerplate
  - likely false positive
- Separate weak AI role from weak extraction.
- Duplicate-adjust counts before market-shape claims.
- Add role-family layer before blog generation:
  - LLM application engineer
  - agentic workflow engineer
  - RAG/knowledge systems engineer
  - AI data/platform engineer
  - inference/runtime engineer
  - enterprise AI architect
  - forward-deployed/solutions AI engineer
  - AI product owner/lead
  - AI garnish or weak AI-adjacent
- Add exact sentence IDs such as `job_817.s12`.
