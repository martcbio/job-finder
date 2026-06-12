CREATE TABLE IF NOT EXISTS job_search.job_skill_extractions (
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  extractor text NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  signal_count integer NOT NULL DEFAULT 0 CHECK (signal_count >= 0),
  PRIMARY KEY (job_id, extractor)
);

CREATE TABLE IF NOT EXISTS job_search.job_skill_signals (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  normalized_signal text NOT NULL,
  signal_kind text NOT NULL CHECK (
    signal_kind IN (
      'required_skill',
      'responsibility',
      'infrastructure_context',
      'domain_context',
      'vague_keyword'
    )
  ),
  evidence_snippet text NOT NULL,
  confidence text NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
  extractor text NOT NULL,
  extracted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, normalized_signal, signal_kind, extractor)
);

CREATE INDEX IF NOT EXISTS job_skill_signals_signal_idx
  ON job_search.job_skill_signals (normalized_signal);

CREATE INDEX IF NOT EXISTS job_skill_signals_job_idx
  ON job_search.job_skill_signals (job_id);
