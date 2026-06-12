# Resume2 Job Market Skill Clusters

Date: 2026-06-04

## Context

There is a separate project at `/Users/mcb/Codelocal/resume2` that pulls live jobs from several sources and does some minimal intelligence on them, including naive skill-overlap analysis.

This should connect back to the RAG/context-engineering blog project because job postings are a useful, relatively structured external corpus. Unlike blog post summarization, job descriptions are already written to expose requirements, bullet points, tools, and role expectations. The hard task is less "summarize this beautifully" and more "extract the repeated demand signals without flattening them."

## Core Idea

Use summarization mechanics from the ingest-summary work as a second layer on top of `resume2` job ingestion.

Instead of asking only:

- Which jobs match my skills?
- Which skills overlap with this posting?
- Which technologies appear most often?

Ask:

- What clusters of skill demand recur across the job set?
- How is the same apparent topic described differently across employers?
- Which clusters indicate deep mastery rather than superficial keyword familiarity?
- What writing project would indirectly demonstrate mastery of those clusters?

Example hypothesis:

- 150 live jobs are pulled.
- 100 mention RAG or adjacent context-engineering work.
- Those mentions break into five or six clusters: naive document QA, enterprise governed retrieval, agentic tool retrieval, eval/observability, indexing/chunking at scale, and context/memory systems.
- A strong blog post on "Is RAG dead?" can cover many of those clusters indirectly, showing fluency with the field without becoming a resume keyword dump.

## Why Summarization Mechanics Fit

Job postings are good candidates for structured extraction because they tend to have:

- explicit bullet points,
- repeated skill names,
- role-level context,
- relatively stable requirement language,
- enough redundancy across postings to form clusters,
- weaker need for literary interpretation than a blog essay or transcript.

The summarization pipeline pattern could work well if adapted from "summarize source" to "extract market signal":

- extract claims/requirements from each job,
- normalize skill mentions and aliases,
- preserve source evidence and employer wording,
- cluster similar requirements,
- identify contradictions or divergent meanings,
- score salience across the corpus,
- generate writing prompts that demonstrate mastery.

## Useful Output Shape

For each cluster, produce something like:

- Cluster name.
- Representative job-language excerpts.
- Skills/tools mentioned.
- Underlying capability being requested.
- Evidence count across jobs.
- Common shallow interpretation.
- Stronger mastery interpretation.
- Blog-post angle that would demonstrate the capability indirectly.
- Missing personal proof or portfolio evidence.

## Example Cluster Framing

For RAG/context engineering, the cluster output might distinguish:

- "Build a chatbot over docs" as the naive version.
- "Design governed evidence retrieval over live enterprise systems" as the serious architecture version.
- "Agentic context assembly" as the newer framing.
- "Eval and observability for retrieval" as the operational version.
- "Chunking/indexing/versioning/freshness" as the data-infrastructure version.

This matters for the RAG blog post because the article can become evidence of understanding the market's real requirements. It should not merely argue about terminology. It can show awareness of the architecture, failure modes, security constraints, evals, and source-system tradeoffs that employers are actually asking for.

## Prompt For The Resume2 Agent

Use the live job corpus to identify demand clusters, not just keyword matches.

For each job, extract:

- explicit skills,
- implied capabilities,
- tools/platforms,
- domain constraints,
- seniority signals,
- evidence snippets,
- ambiguity or buzzword risk.

Then cluster across jobs and answer:

- What are the top recurring technical themes?
- What are the subclusters within each theme?
- Which terms are being used inconsistently?
- Which clusters look like naive keyword matching and which imply real engineering depth?
- What blog post, demo, diagram, or portfolio artifact would indirectly demonstrate mastery of each cluster?
- Which existing writing project already covers several clusters?
- Which missing artifacts would create the highest leverage for applications?

For the RAG case specifically, test whether the "Is RAG dead?" article can be positioned as evidence for:

- retrieval and context engineering judgment,
- enterprise architecture awareness,
- security/freshness/permission concerns,
- chunking/indexing tradeoffs,
- eval and observability discipline,
- agentic retrieval/tool-use framing,
- ability to resolve confused industry terminology.

## Link Back To Current RAG Investigation

The TechRadar/Pangea critique is useful because it names real enterprise objections to naive RAG: copied data stores, stale indexes, weakened authorization, and compliance burden. But it also makes the useful overgeneralization for the article: it treats centralized vector-store RAG as RAG itself, while its proposed "agent-based" replacement still depends on permissioned runtime retrieval.

That maps cleanly to job-market evidence. If many job postings say "RAG," the useful question is not whether they mean the naive 2023 pipeline. The useful question is which underlying capability they are actually hiring for: document QA, governed retrieval, source-system integration, context engineering, evals, or agent workflows.

## Open Follow-Up

Ask an agent in `/Users/mcb/Codelocal/resume2` to inspect the current job ingestion and skill-overlap logic, then propose a structured extraction and clustering layer. The goal is not a full rewrite first. The goal is a report that shows what the current pipeline is missing and what small schema/output changes would make job-market clusters usable for writing strategy and portfolio planning.
