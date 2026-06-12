# External Review Prompt

You are reviewing a job-market artifact generated from refreshed job postings.

Artifact directory:
`artifacts/job-market/2026-06-05`

Files to inspect:
- `jobs.jsonl`
- `extracted_signals.jsonl`
- `inferred_clusters.jsonl`
- `market_shape.md`
- `blog_ideas.md`
- `quality_report.md`

Please red-team the analysis:

1. Check whether each inferred cluster is supported by repeated combinations of signals, not a single keyword.
2. Identify overfit clusters that should be merged, renamed, or demoted to thin evidence.
3. Identify missed clusters visible in `jobs.jsonl` and `extracted_signals.jsonl`.
4. Judge whether each blog idea is supported by cluster and job evidence.
5. Call out noisy AI terminology and title-only AI mentions.
6. Rank the strongest blog ideas by hiring signal, not by novelty.
7. Preserve uncertainty. Prefer saying "thin evidence" over inventing structure.

Constraints:
- Do not use a preselected RAG/agents/LLM taxonomy.
- Do not equate "mentions AI" with "AI-native role."
- Every criticism should cite job IDs and, where possible, evidence snippets.
