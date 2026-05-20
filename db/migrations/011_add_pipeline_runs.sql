CREATE TABLE job_search.pipeline_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  saved_sweep_id bigint REFERENCES job_search.saved_sweeps(id) ON DELETE SET NULL,
  sweep_name text,
  status text NOT NULL DEFAULT 'running' CHECK (
    status IN ('running', 'completed', 'failed')
  ),
  command_args text[] NOT NULL DEFAULT ARRAY[]::text[],
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_summary text
);

CREATE TABLE job_search.pipeline_run_steps (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  pipeline_run_id bigint NOT NULL REFERENCES job_search.pipeline_runs(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position > 0),
  step_name text NOT NULL,
  description text NOT NULL,
  command_args text[] NOT NULL DEFAULT ARRAY[]::text[],
  command_display text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'completed', 'failed')
  ),
  started_at timestamptz,
  finished_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  exit_code integer,
  error text,
  UNIQUE (pipeline_run_id, position)
);

CREATE INDEX pipeline_runs_started_at_idx
  ON job_search.pipeline_runs(started_at DESC);

CREATE INDEX pipeline_runs_status_idx
  ON job_search.pipeline_runs(status);

CREATE INDEX pipeline_run_steps_run_id_idx
  ON job_search.pipeline_run_steps(pipeline_run_id);
