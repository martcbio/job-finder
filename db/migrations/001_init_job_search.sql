CREATE SCHEMA IF NOT EXISTS job_search;

CREATE TABLE IF NOT EXISTS job_search.schema_migrations (
  version text PRIMARY KEY,
  filename text NOT NULL,
  checksum text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS job_search.search_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'completed_with_errors', 'failed')
  ),
  keyword text NOT NULL,
  source_set jsonb NOT NULL DEFAULT '[]'::jsonb,
  time_filter text NOT NULL,
  include_remote boolean NOT NULL DEFAULT true,
  location text,
  limit_per_query integer NOT NULL CHECK (limit_per_query > 0),
  timeout_ms integer NOT NULL CHECK (timeout_ms > 0),
  total_reported_tokens bigint NOT NULL DEFAULT 0 CHECK (total_reported_tokens >= 0),
  error_summary text
);

CREATE TABLE IF NOT EXISTS job_search.search_queries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES job_search.search_runs(id) ON DELETE CASCADE,
  source_label text NOT NULL,
  source_id text NOT NULL,
  query text,
  direct_url text,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('pending', 'running', 'success', 'timeout', 'error', 'direct')
  ),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  usage_tokens bigint CHECK (usage_tokens IS NULL OR usage_tokens >= 0),
  decompressed_bytes bigint CHECK (decompressed_bytes IS NULL OR decompressed_bytes >= 0),
  error text,
  CONSTRAINT search_queries_has_query_or_direct_url CHECK (
    query IS NOT NULL OR direct_url IS NOT NULL
  )
);

CREATE TABLE IF NOT EXISTS job_search.search_results (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  query_id bigint NOT NULL REFERENCES job_search.search_queries(id) ON DELETE CASCADE,
  rank integer NOT NULL CHECK (rank > 0),
  title_raw text NOT NULL,
  description_raw text NOT NULL DEFAULT '',
  url_raw text NOT NULL,
  url_canonical text NOT NULL,
  company_hint text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (query_id, rank)
);

CREATE TABLE IF NOT EXISTS job_search.jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  canonical_key text NOT NULL UNIQUE,
  canonical_url text NOT NULL,
  title_normalized text NOT NULL,
  company_hint text,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  review_state text NOT NULL DEFAULT 'new' CHECK (
    review_state IN (
      'new',
      'needs_page_ingest',
      'needs_classification',
      'ready_for_review',
      'shortlisted',
      'needs_cv_tailoring',
      'ready_to_apply',
      'applied',
      'waiting',
      'rejected_by_us',
      'rejected_by_company',
      'stale',
      'duplicate_candidate',
      'not_relevant'
    )
  )
);

CREATE TABLE IF NOT EXISTS job_search.job_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  search_result_id bigint NOT NULL REFERENCES job_search.search_results(id) ON DELETE CASCADE,
  observed_at timestamptz NOT NULL DEFAULT now(),
  observed_title text NOT NULL,
  observed_url text NOT NULL,
  observed_company_hint text,
  UNIQUE (job_id, search_result_id)
);

CREATE TABLE IF NOT EXISTS job_search.duplicate_candidates (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id_a bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  job_id_b bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  confidence numeric(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason text NOT NULL,
  state text NOT NULL DEFAULT 'suggested' CHECK (
    state IN ('suggested', 'confirmed_same', 'confirmed_distinct', 'ignored')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT duplicate_candidates_distinct_jobs CHECK (job_id_a <> job_id_b),
  UNIQUE (job_id_a, job_id_b)
);

CREATE TABLE IF NOT EXISTS job_search.review_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  note text,
  actor text NOT NULL DEFAULT 'system' CHECK (actor IN ('system', 'human', 'agent')),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS search_runs_started_at_idx
  ON job_search.search_runs(started_at DESC);

CREATE INDEX IF NOT EXISTS search_queries_run_id_idx
  ON job_search.search_queries(run_id);

CREATE INDEX IF NOT EXISTS search_queries_source_status_idx
  ON job_search.search_queries(source_id, status);

CREATE INDEX IF NOT EXISTS search_results_query_id_idx
  ON job_search.search_results(query_id);

CREATE INDEX IF NOT EXISTS search_results_url_canonical_idx
  ON job_search.search_results(url_canonical);

CREATE INDEX IF NOT EXISTS jobs_review_state_idx
  ON job_search.jobs(review_state);

CREATE INDEX IF NOT EXISTS jobs_last_seen_at_idx
  ON job_search.jobs(last_seen_at DESC);

CREATE INDEX IF NOT EXISTS job_observations_job_id_idx
  ON job_search.job_observations(job_id);

CREATE INDEX IF NOT EXISTS review_events_job_id_idx
  ON job_search.review_events(job_id);

