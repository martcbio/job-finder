CREATE SCHEMA IF NOT EXISTS careers;

CREATE TABLE IF NOT EXISTS careers.parity_runs (
    run_date date NOT NULL,
    substrate text NOT NULL CHECK (substrate IN ('mac', 'modal')),
    run_id text NOT NULL,
    openings_count integer NOT NULL,
    ids_sha256 text NOT NULL,
    targets_sha256 text,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_date, substrate, run_id)
);

ALTER TABLE careers.parity_runs
    ADD COLUMN IF NOT EXISTS targets_sha256 text;

DO $$
DECLARE
    primary_key_columns text[];
    primary_key_name text;
BEGIN
    SELECT
        constraint_row.conname,
        array_agg(attribute_row.attname ORDER BY key_column.ordinality)
    INTO primary_key_name, primary_key_columns
    FROM pg_constraint constraint_row
    CROSS JOIN LATERAL unnest(constraint_row.conkey) WITH ORDINALITY AS key_column(attnum, ordinality)
    JOIN pg_attribute attribute_row
      ON attribute_row.attrelid = constraint_row.conrelid
     AND attribute_row.attnum = key_column.attnum
    WHERE constraint_row.conrelid = 'careers.parity_runs'::regclass
      AND constraint_row.contype = 'p'
    GROUP BY constraint_row.conname;

    IF primary_key_columns IS DISTINCT FROM ARRAY['run_date', 'substrate', 'run_id'] THEN
        IF primary_key_name IS NOT NULL THEN
            EXECUTE format(
                'ALTER TABLE careers.parity_runs DROP CONSTRAINT %I',
                primary_key_name
            );
        END IF;
        ALTER TABLE careers.parity_runs
            ADD PRIMARY KEY (run_date, substrate, run_id);
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS parity_runs_created_at_idx
    ON careers.parity_runs (created_at DESC);

CREATE TABLE IF NOT EXISTS careers.targets (
    org text PRIMARY KEY,
    ats text CHECK (ats IN ('ashby', 'greenhouse', 'lever') OR ats IS NULL),
    company text NOT NULL,
    active boolean NOT NULL DEFAULT true,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE careers.parity_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE careers.targets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA careers FROM PUBLIC, anon;
REVOKE ALL ON TABLE careers.parity_runs, careers.targets FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA careers TO authenticated, service_role;
GRANT SELECT ON TABLE careers.parity_runs, careers.targets TO authenticated;
GRANT ALL ON TABLE careers.parity_runs, careers.targets TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'careers'
          AND tablename = 'parity_runs'
          AND policyname = 'authenticated_read_parity_runs'
    ) THEN
        CREATE POLICY authenticated_read_parity_runs
            ON careers.parity_runs
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'careers'
          AND tablename = 'targets'
          AND policyname = 'authenticated_read_targets'
    ) THEN
        CREATE POLICY authenticated_read_targets
            ON careers.targets
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;
END;
$$;

-- seed: generated from cloud/targets.json
INSERT INTO careers.targets (org, ats, company, active)
VALUES
    ('anthropic', 'greenhouse', 'Anthropic', true),
    ('openai', 'ashby', 'OpenAI', true),
    ('cursor', 'ashby', 'Cursor / Anysphere', true),
    ('cognition', 'ashby', 'Cognition', true),
    ('databricks', 'greenhouse', 'Databricks', true),
    ('Sierra', 'ashby', 'Sierra', true),
    ('imbue', 'greenhouse', 'Imbue', true),
    ('cohere', 'ashby', 'Cohere', true),
    ('mistral', 'lever', 'Mistral AI', true),
    ('perplexity', 'ashby', 'Perplexity', true),
    ('ramp', 'ashby', 'Ramp', true)
ON CONFLICT (org) DO UPDATE SET
    ats = EXCLUDED.ats,
    company = EXCLUDED.company,
    active = EXCLUDED.active,
    updated_at = now();
