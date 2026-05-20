ALTER TABLE job_search.job_pages
  DROP CONSTRAINT job_pages_source_check,
  ADD CONSTRAINT job_pages_source_check CHECK (
    source IN ('jina_reader', 'ats_api')
  );

CREATE TABLE job_search.job_page_ingest_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  source text NOT NULL CHECK (
    source IN ('ats_api', 'jina_reader', 'http_extract', 'browser')
  ),
  status text NOT NULL CHECK (
    status IN ('success', 'skipped', 'error', 'timeout')
  ),
  attempted_at timestamptz NOT NULL DEFAULT now(),
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  usage_tokens bigint CHECK (usage_tokens IS NULL OR usage_tokens >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text
);

CREATE INDEX job_page_ingest_attempts_job_id_idx
  ON job_search.job_page_ingest_attempts(job_id);

CREATE INDEX job_page_ingest_attempts_source_status_idx
  ON job_search.job_page_ingest_attempts(source, status);
