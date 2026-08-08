ALTER TABLE job_search.search_results
  ADD COLUMN raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb;
