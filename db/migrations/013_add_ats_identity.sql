ALTER TABLE job_search.search_results
  ADD COLUMN IF NOT EXISTS ats_source text,
  ADD COLUMN IF NOT EXISTS ats_org text,
  ADD COLUMN IF NOT EXISTS ats_job_id text;

ALTER TABLE job_search.jobs
  ADD COLUMN IF NOT EXISTS ats_source text,
  ADD COLUMN IF NOT EXISTS ats_org text,
  ADD COLUMN IF NOT EXISTS ats_job_id text;

CREATE INDEX IF NOT EXISTS search_results_ats_identity_idx
  ON job_search.search_results(ats_source, ats_org, ats_job_id)
  WHERE ats_source IS NOT NULL;

CREATE INDEX IF NOT EXISTS jobs_ats_identity_idx
  ON job_search.jobs(ats_source, ats_org, ats_job_id)
  WHERE ats_source IS NOT NULL;
