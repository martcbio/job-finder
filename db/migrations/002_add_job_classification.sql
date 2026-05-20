ALTER TABLE job_search.jobs
  ADD COLUMN category text NOT NULL DEFAULT 'unclassified' CHECK (
    category IN (
      'unclassified',
      'agentic_engineer',
      'agentic_architect',
      'fde',
      'inference_engineer',
      'other'
    )
  ),
  ADD COLUMN rag_focus text NOT NULL DEFAULT 'unknown' CHECK (
    rag_focus IN ('yes', 'no', 'unknown')
  ),
  ADD COLUMN enterprise_focus text NOT NULL DEFAULT 'unknown' CHECK (
    enterprise_focus IN ('yes', 'no', 'unknown')
  ),
  ADD COLUMN classification_confidence numeric(5, 4) CHECK (
    classification_confidence IS NULL OR (
      classification_confidence >= 0 AND classification_confidence <= 1
    )
  ),
  ADD COLUMN classification_reason text,
  ADD COLUMN classified_at timestamptz;

CREATE INDEX jobs_category_idx
  ON job_search.jobs(category);

CREATE INDEX jobs_rag_focus_idx
  ON job_search.jobs(rag_focus);
