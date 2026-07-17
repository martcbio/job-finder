# Phase-3 CV staging

`bun run cv:stage -- <applicationId>` stages a shortlisted `careers.applications` row in
resume3. It creates `pipeline/apply/app-<id>-<slug>/`, syncs resume3's safe per-case inputs,
writes a mechanically selected `inputs/recent.md`, renders with dummy identity, stores the case
path in `cv_ref`, and transitions the application to `cv_staged` as `agent`.

Every resume3 subprocess receives `AGENT_MODE=1` and `--identity=dummy`. A non-zero sync or
compose exit aborts the lifecycle update and includes stdout/stderr in the error.

## Mechanical fragment selection v1

The selector parses `resume3/resume/resume-fragments.md`; each `##` heading is a soft lane/tag and
each Markdown list item is a candidate fragment. Tokenization lowercases words, removes Markdown,
and drops a small fixed stop-word list.

For each fragment:

- each unique keyword shared by the bullet and job text scores 2 points;
- each unique lane/tag keyword shared with the job text scores 4 points;
- zero-score fragments are excluded;
- candidates sort by score descending, then canonical source order, and the first seven are used.

The job text is title + company + the best available description. Local applications prefer the
latest successful local job-page Markdown, then the latest search observation. Lab applications
read the matching `careers.openings.raw` payload through PostgREST and inspect common ATS
description fields. If no description exists, staging continues against title + company and says
so in its output.

`inputs/recent.md` records the score, matched keywords, lane, and tags in HTML comments and always
includes `mechanically selected v1 — refine before send`. This is a deterministic floor, not a
send-ready tailoring pass: it cannot understand transferable evidence, chronology, claim quality,
negation, synonyms, or whether a high-overlap bullet is actually the best proof for the role.
