# Evidence Pipeline Review - 2026-06-09

This captures the concrete critique from the GPT Pro review and turns it into implementation requirements for the market-signals layer.

## Main Finding

The blog strategy is good, but the evidence pipeline is too permissive about what counts as proof.

The pipeline currently lets title-level AI wording, metadata/search terms, and actual body responsibilities sit too close together. This produces both false positives and false negatives.

## Corrections To Current Evidence

- `job_801` is not weak evidence. It is a concrete inference/runtime role:
  - "porting and optimising inference engines to run efficiently on edge hardware"
  - deploys models to edge devices
  - should be in an inference/edge/runtime cluster.

- `job_817` is underweighted. The title is bland, but the body has strong agentic-system evidence:
  - autonomous agents
  - multi-agent pipelines
  - tool-use workflows
  - planning loops
  - memory-augmented reasoning
  - observability
  - guardrails
  - human-in-the-loop design
  - risk mitigation

- `job_825`, `job_823`, `job_821`, and `job_820` are duplicate 83Zero AI/fullstack signals and should count once for market-shape purposes.

## Required Evidence Grades

Every extracted signal should carry one of:

- `body_responsibility`
- `body_required_skill`
- `body_stack_or_platform`
- `title_only`
- `metadata_only`
- `inferred_label_only`
- `recruiter_boilerplate`
- `likely_false_positive`

Downstream cluster generation should weight body-level responsibility and required-skill evidence highest.

## Split "AI Garnish" Into Three Labels

Current `AI garnish` mixes unlike cases. Split into:

- `weak_ai_role`: posting has AI language but body lacks concrete AI work.
- `weak_extraction`: artifact only preserved title/snippet but raw body may be stronger.
- `false_positive_non_ai`: civil/site/maintenance/quality/customer/support roles pulled in by keyword collisions.

## False Positive Suppression

Add suppressors or warning flags for:

- site engineer
- field support
- water/civil pipelines
- maintenance reliability
- WAF engineering
- electrical/mechanical engineering
- generic customer/quality wording

These should not automatically delete jobs, but they should lower confidence and mark the role as a boundary case.

## Better Review Artifact

For each proposed blog post, generate a `top_evidence_snippets` section:

- five best body-level snippets
- two weak snippets
- one counterexample

This is faster to review than jumping between themes, jobs JSON, raw descriptions, and cluster files.

## Better Market Shape Representation

Use role-family intersections rather than keyword taxonomy.

Suggested role families:

- LLM application engineer
- agentic workflow engineer
- RAG/knowledge systems engineer
- AI data/platform engineer
- inference/runtime engineer
- enterprise AI architect
- forward-deployed/solutions AI engineer
- AI product owner/lead
- AI garnish or weak AI-adjacent

Use duplicate-adjusted co-occurrence rather than literal Venn diagrams.
