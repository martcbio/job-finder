CREATE SCHEMA IF NOT EXISTS careers;

CREATE TABLE IF NOT EXISTS careers.parity_runs (
    run_date date NOT NULL,
    substrate text NOT NULL CHECK (substrate IN ('mac', 'modal')),
    run_id text NOT NULL,
    openings_count integer NOT NULL,
    ids_sha256 text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (run_date, substrate)
);

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
    ('cursor', NULL, 'Cursor / Anysphere', true),
    ('cognition', 'ashby', 'Cognition', true),
    ('databricks', NULL, 'Databricks', true),
    ('Sierra', 'ashby', 'Sierra', true),
    ('imbue', 'greenhouse', 'Imbue', true),
    ('cohere', 'ashby', 'Cohere', true),
    ('mistral', 'lever', 'Mistral AI', true),
    ('perplexity', NULL, 'Perplexity', true)
ON CONFLICT (org) DO UPDATE SET
    ats = EXCLUDED.ats,
    company = EXCLUDED.company,
    active = EXCLUDED.active,
    updated_at = now();
