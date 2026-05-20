CREATE TABLE job_search.job_applications (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  cv_draft_id bigint REFERENCES job_search.job_cv_drafts(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (
    status IN ('prepared', 'applied', 'waiting', 'rejected_by_company', 'withdrawn')
  ),
  channel text,
  external_url text,
  applied_at timestamptz,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX job_applications_job_id_idx
  ON job_search.job_applications(job_id);

CREATE INDEX job_applications_status_idx
  ON job_search.job_applications(status);
