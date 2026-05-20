CREATE TABLE job_search.job_pages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'jina_reader' CHECK (
    source IN ('jina_reader')
  ),
  status text NOT NULL CHECK (
    status IN ('success', 'error', 'timeout')
  ),
  fetched_at timestamptz NOT NULL DEFAULT now(),
  source_url text NOT NULL,
  title_raw text,
  markdown text,
  usage_tokens bigint CHECK (usage_tokens IS NULL OR usage_tokens >= 0),
  decompressed_bytes bigint CHECK (decompressed_bytes IS NULL OR decompressed_bytes >= 0),
  error text,
  UNIQUE (job_id, source)
);

ALTER TABLE job_search.jobs
  ADD COLUMN page_ingest_status text NOT NULL DEFAULT 'pending' CHECK (
    page_ingest_status IN ('pending', 'success', 'error', 'timeout')
  ),
  ADD COLUMN page_ingested_at timestamptz;

CREATE INDEX job_pages_job_id_idx
  ON job_search.job_pages(job_id);

CREATE INDEX jobs_page_ingest_status_idx
  ON job_search.jobs(page_ingest_status);
