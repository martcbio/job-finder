ALTER TABLE job_search.duplicate_candidates
  ADD COLUMN reviewed_at timestamptz,
  ADD COLUMN reviewed_by text CHECK (
    reviewed_by IS NULL OR reviewed_by IN ('system', 'human', 'agent')
  ),
  ADD COLUMN review_reason_codes text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN review_note text;

CREATE INDEX duplicate_candidates_state_idx
  ON job_search.duplicate_candidates(state);
