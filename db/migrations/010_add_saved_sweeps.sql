CREATE TABLE job_search.saved_sweeps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL UNIQUE CHECK (length(trim(name)) > 0),
  keywords text[] NOT NULL CHECK (array_length(keywords, 1) > 0),
  sites text[] NOT NULL CHECK (array_length(sites, 1) > 0),
  time_filter text NOT NULL,
  include_remote boolean NOT NULL DEFAULT true,
  location text,
  max_queries integer NOT NULL CHECK (max_queries > 0),
  search_limit integer NOT NULL CHECK (search_limit > 0),
  search_timeout_ms integer NOT NULL CHECK (search_timeout_ms > 0),
  page_limit integer NOT NULL CHECK (page_limit > 0),
  page_timeout_ms integer NOT NULL CHECK (page_timeout_ms > 0),
  classify_limit integer NOT NULL CHECK (classify_limit > 0),
  duplicate_limit integer NOT NULL CHECK (duplicate_limit > 0),
  duplicate_threshold numeric(5, 4) NOT NULL CHECK (
    duplicate_threshold > 0 AND duplicate_threshold <= 1
  ),
  queue_limit integer NOT NULL CHECK (queue_limit > 0),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX saved_sweeps_enabled_idx
  ON job_search.saved_sweeps(enabled);
