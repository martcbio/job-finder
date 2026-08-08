WITH dishonest_pages AS (
  UPDATE job_search.job_pages page
  SET status = 'error',
      error = 'Historical JobServe skipped-detail stub; retained as evidence and queued for safe re-enrichment'
  FROM job_search.jobs job
  WHERE page.job_id = job.id
    AND page.source = 'http_extract'
    AND page.status = 'success'
    AND page.markdown LIKE '%- Source: JobServe%'
    AND page.markdown LIKE '%- Detail status: skipped%'
  RETURNING page.job_id
)
UPDATE job_search.jobs job
SET page_ingest_status = 'pending',
    page_ingested_at = NULL
WHERE job.id IN (SELECT job_id FROM dishonest_pages)
  AND NOT EXISTS (
    SELECT 1
    FROM job_search.job_pages other_page
    WHERE other_page.job_id = job.id
      AND other_page.status = 'success'
  );
