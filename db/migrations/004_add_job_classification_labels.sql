CREATE TABLE job_search.job_classification_labels (
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  label text NOT NULL CHECK (
    label IN (
      'agentic_engineer',
      'agentic_architect',
      'rag_enterprise',
      'fde',
      'solutions_engineer',
      'inference_engineer',
      'ml_platform',
      'backend_product_engineering',
      'developer_tools',
      'data_engineering',
      'security_ai',
      'founding_engineer',
      'ai_product_manager',
      'non_engineering',
      'staffing_agency',
      'index_not_job'
    )
  ),
  source_stage text NOT NULL CHECK (source_stage IN ('metadata', 'page', 'manual')),
  confidence numeric(5, 4) NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  reason text NOT NULL,
  classified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job_id, label, source_stage)
);

CREATE INDEX job_classification_labels_label_idx
  ON job_search.job_classification_labels(label);

CREATE INDEX job_classification_labels_stage_idx
  ON job_search.job_classification_labels(source_stage);

INSERT INTO job_search.job_classification_labels (
  job_id,
  label,
  source_stage,
  confidence,
  reason,
  classified_at
)
SELECT
  id,
  category,
  CASE
    WHEN page_ingested_at IS NULL THEN 'metadata'
    ELSE 'page'
  END,
  COALESCE(classification_confidence, 0.5000),
  COALESCE(classification_reason, 'backfilled from legacy category'),
  COALESCE(classified_at, now())
FROM job_search.jobs
WHERE category IN ('agentic_engineer', 'agentic_architect', 'fde', 'inference_engineer')
ON CONFLICT DO NOTHING;

INSERT INTO job_search.job_classification_labels (
  job_id,
  label,
  source_stage,
  confidence,
  reason,
  classified_at
)
SELECT
  id,
  'rag_enterprise',
  CASE
    WHEN page_ingested_at IS NULL THEN 'metadata'
    ELSE 'page'
  END,
  COALESCE(classification_confidence, 0.6000),
  'backfilled from legacy rag_focus=yes and enterprise_focus=yes',
  COALESCE(classified_at, now())
FROM job_search.jobs
WHERE rag_focus = 'yes'
  AND enterprise_focus = 'yes'
ON CONFLICT DO NOTHING;
