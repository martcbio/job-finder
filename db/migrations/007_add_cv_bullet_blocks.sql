CREATE TABLE job_search.cv_focus_themes (
  key text PRIMARY KEY,
  label text NOT NULL,
  description text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_search.cv_bullet_blocks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  theme_key text NOT NULL REFERENCES job_search.cv_focus_themes(key),
  title text NOT NULL,
  bullet_text text NOT NULL,
  evidence_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'draft' CHECK (
    status IN ('draft', 'approved', 'retired')
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_search.job_cv_drafts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id bigint NOT NULL REFERENCES job_search.jobs(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'needs_human_review' CHECK (
    status IN ('needs_human_review', 'approved', 'rejected', 'superseded')
  ),
  generated_at timestamptz NOT NULL DEFAULT now(),
  theme_keys text[] NOT NULL DEFAULT ARRAY[]::text[],
  bullet_block_ids bigint[] NOT NULL DEFAULT ARRAY[]::bigint[],
  draft_markdown text NOT NULL,
  note text
);

CREATE INDEX cv_bullet_blocks_theme_status_idx
  ON job_search.cv_bullet_blocks(theme_key, status);

CREATE INDEX job_cv_drafts_job_id_idx
  ON job_search.job_cv_drafts(job_id);

INSERT INTO job_search.cv_focus_themes (key, label, description)
VALUES
  ('agentic_engineer', 'Agentic engineer', 'Production AI agent systems, orchestration, tool use, memory, evaluation, and reliability.'),
  ('agentic_architect', 'Agentic architect', 'Architecture-level ownership for multi-agent systems and LLM platform direction.'),
  ('rag_enterprise', 'Enterprise RAG', 'Retrieval, grounding, knowledge systems, enterprise trust, security, and compliance.'),
  ('fde', 'Forward deployed engineering', 'Customer-facing engineering, implementation ownership, and deployment in ambiguous environments.'),
  ('solutions_engineer', 'Solutions engineering', 'Pre-sales, technical discovery, customer demos, and implementation guidance.'),
  ('inference_engineer', 'Inference engineer', 'Model serving, latency, throughput, routing, GPU, and inference reliability.'),
  ('ml_platform', 'ML platform', 'ML tooling, evaluation, MLOps, model lifecycle, and platform infrastructure.'),
  ('backend_product_engineering', 'Backend product engineering', 'Backend systems, APIs, product delivery, and operational ownership.'),
  ('developer_tools', 'Developer tools', 'SDKs, CLIs, API platforms, developer experience, and platform usability.'),
  ('data_engineering', 'Data engineering', 'Pipelines, warehouses, analytics engineering, and data reliability.'),
  ('security_ai', 'Security AI', 'Security-focused AI systems, compliance, safety, and adversarial resilience.'),
  ('founding_engineer', 'Founding engineer', 'Early-stage product engineering, broad ownership, and ambiguous zero-to-one execution.'),
  ('ai_product_manager', 'AI product manager', 'AI product strategy, discovery, roadmaps, and cross-functional delivery.')
ON CONFLICT (key) DO NOTHING;
