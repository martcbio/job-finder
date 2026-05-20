ALTER TABLE job_search.job_pages
  DROP CONSTRAINT job_pages_source_check,
  ADD CONSTRAINT job_pages_source_check CHECK (
    source IN ('jina_reader', 'ats_api', 'http_extract')
  );
