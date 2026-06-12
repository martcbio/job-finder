# Quality Report

Generated: 2026-06-05T04:33:21.387Z

## Counts

- Jobs fetched/imported by refresh: 124 reported by fast-refresh
- Canonical jobs returned from refreshed run IDs: 69
- Usable jobs with non-thin full text: 69
- Duplicate-candidate jobs: 20
- Stale/closed flags: 0
- Thin descriptions: 0

## Top Recurring Signals

- vague ai mention without concrete system: 41 jobs
- architecture roadmap and technical leadership: 18 jobs
- llm application development: 15 jobs
- agentic workflow orchestration: 11 jobs
- data pipelines and analytics engineering: 8 jobs
- python backend engineering: 8 jobs
- client facing solutions delivery: 7 jobs
- aws ai cloud stack: 6 jobs
- azure ai cloud stack: 6 jobs
- c++ performance systems: 6 jobs
- api integration and enterprise systems: 4 jobs
- evaluation harness and llm quality: 4 jobs
- financial services regulated domain: 4 jobs
- snowflake databricks medallion: 4 jobs
- security compliance governance: 3 jobs
- typescript react node product engineering: 3 jobs
- context engineering and memory design: 2 jobs
- internal tools and developer workflows: 2 jobs
- mlops deployment and model serving: 2 jobs
- retrieval and grounding systems: 2 jobs

## Top Inferred Clusters

- c01 LLM application engineers shipping product or internal workflows: 20 jobs, confidence high
- c02 Enterprise AI architects and adoption leads: 6 jobs, confidence medium
- c03 Evaluation, context engineering, and LLM reliability: 5 jobs, confidence medium
- c04 Data and analytics platforms as the substrate for AI: 4 jobs, confidence medium
- c06 Forward-deployed and solutions AI delivery: 4 jobs, confidence medium
- c07 Retrieval and knowledge-system engineering: 2 jobs, confidence low

## Weak Clusters

- c07 Retrieval and knowledge-system engineering: 2 jobs; 
- c_misc Miscellaneous or thin AI-adjacent evidence: 30 jobs; job_811, job_801, job_808, job_825, job_823, job_821, job_820, job_841

## Noisy Keywords

- AI/GenAI in a title without concrete system responsibilities.
- Transformation/enablement language without stack, workflow, or ownership detail.
- Recruiter-normalized company/title fields that collapse role context.

## Classification Uncertainty

- Cluster inference used extracted signals from job text, not the existing deterministic labels as the clustering source.
- Existing labels are retained in jobs.jsonl metadata for audit, but they should be treated as input context rather than ground truth.
- JobServe aggregator postings are useful market evidence but weaker public anchors than employer career pages.

## Recommended Improvements

- Add more direct employer sources to reduce aggregator/title normalization bias.
- Store explicit posted_at/work_mode fields during ingestion instead of parsing markdown metadata later.
- Add a human-reviewed duplicate merge/read model for market reporting while preserving non-destructive duplicate candidates.
- Add an extraction pass that scores whether each AI mention is a role requirement, product context, or marketing phrase.

