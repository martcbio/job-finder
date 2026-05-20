ALTER TABLE job_search.job_cv_drafts
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by text CHECK (
    reviewed_by IS NULL OR reviewed_by IN ('system', 'human', 'agent')
  ),
  ADD COLUMN review_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN review_note text;

CREATE INDEX job_cv_drafts_status_idx
  ON job_search.job_cv_drafts(status);
