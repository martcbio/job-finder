CREATE SCHEMA IF NOT EXISTS careers;

CREATE TABLE IF NOT EXISTS careers.openings_runs (
    run_id text PRIMARY KEY,
    run_date date NOT NULL,
    scheduled_at timestamptz NOT NULL,
    started_at timestamptz NOT NULL,
    completed_at timestamptz NOT NULL,
    health text NOT NULL CHECK (health IN ('complete', 'degraded', 'failed')),
    matched_openings_count integer NOT NULL CHECK (matched_openings_count >= 0),
    board_status jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(board_status) = 'array'),
    diagnostics jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(diagnostics) = 'array'),
    substrate text NOT NULL CHECK (substrate IN ('modal', 'mac'))
);

ALTER TABLE careers.openings_runs
    ADD COLUMN IF NOT EXISTS raw_openings_count integer NOT NULL DEFAULT 0
        CHECK (raw_openings_count >= 0),
    ADD COLUMN IF NOT EXISTS eligible_openings_count integer NOT NULL DEFAULT 0
        CHECK (eligible_openings_count >= 0),
    ADD COLUMN IF NOT EXISTS suitable_openings_count integer NOT NULL DEFAULT 0
        CHECK (suitable_openings_count >= 0),
    ADD COLUMN IF NOT EXISTS unsuitable_location_openings_count integer NOT NULL DEFAULT 0
        CHECK (unsuitable_location_openings_count >= 0),
    ADD COLUMN IF NOT EXISTS unsuitable_role_openings_count integer NOT NULL DEFAULT 0
        CHECK (unsuitable_role_openings_count >= 0),
    ADD COLUMN IF NOT EXISTS undecided_openings_count integer NOT NULL DEFAULT 0
        CHECK (undecided_openings_count >= 0);

CREATE TABLE IF NOT EXISTS careers.openings (
    org text NOT NULL,
    ats text NOT NULL CHECK (ats IN ('ashby', 'greenhouse', 'lever')),
    external_id text NOT NULL,
    title text,
    company text NOT NULL,
    location text NOT NULL,
    locations text[] NOT NULL DEFAULT '{}',
    url text NOT NULL,
    posted_at timestamptz,
    raw jsonb NOT NULL,
    first_seen_run_id text NOT NULL REFERENCES careers.openings_runs(run_id),
    first_seen_at timestamptz NOT NULL,
    last_seen_run_id text NOT NULL REFERENCES careers.openings_runs(run_id),
    last_seen_at timestamptz NOT NULL,
    PRIMARY KEY (org, ats, external_id)
);

ALTER TABLE careers.openings
    ADD COLUMN IF NOT EXISTS location_eligibility text NOT NULL DEFAULT 'undecided'
        CHECK (location_eligibility IN ('eligible', 'ineligible', 'undecided')),
    ADD COLUMN IF NOT EXISTS location_reason_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS role_relevance text NOT NULL DEFAULT 'undecided'
        CHECK (role_relevance IN ('relevant', 'irrelevant', 'undecided')),
    ADD COLUMN IF NOT EXISTS role_reason_codes text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS disposition text NOT NULL DEFAULT 'undecided'
        CHECK (disposition IN ('suitable', 'unsuitable_location', 'unsuitable_role', 'undecided'));

CREATE INDEX IF NOT EXISTS openings_runs_completed_at_idx
    ON careers.openings_runs (completed_at DESC);
CREATE INDEX IF NOT EXISTS openings_first_seen_idx
    ON careers.openings (first_seen_at DESC, first_seen_run_id);
CREATE INDEX IF NOT EXISTS openings_last_seen_idx
    ON careers.openings (last_seen_at DESC, last_seen_run_id);
CREATE INDEX IF NOT EXISTS openings_first_seen_run_idx
    ON careers.openings (first_seen_run_id);
CREATE INDEX IF NOT EXISTS openings_last_seen_run_idx
    ON careers.openings (last_seen_run_id);

CREATE OR REPLACE FUNCTION careers.preserve_opening_seen_bounds()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    NEW.first_seen_run_id := OLD.first_seen_run_id;
    NEW.first_seen_at := OLD.first_seen_at;
    IF NEW.last_seen_at < OLD.last_seen_at THEN
        NEW.title := OLD.title;
        NEW.company := OLD.company;
        NEW.location := OLD.location;
        NEW.locations := OLD.locations;
        NEW.url := OLD.url;
        NEW.posted_at := OLD.posted_at;
        NEW.location_eligibility := OLD.location_eligibility;
        NEW.location_reason_codes := OLD.location_reason_codes;
        NEW.role_relevance := OLD.role_relevance;
        NEW.role_reason_codes := OLD.role_reason_codes;
        NEW.disposition := OLD.disposition;
        NEW.raw := OLD.raw;
        NEW.last_seen_run_id := OLD.last_seen_run_id;
        NEW.last_seen_at := OLD.last_seen_at;
    END IF;
    RETURN NEW;
END;
$$;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_trigger
        WHERE tgname = 'openings_preserve_seen_bounds'
          AND tgrelid = 'careers.openings'::regclass
          AND NOT tgisinternal
    ) THEN
        CREATE TRIGGER openings_preserve_seen_bounds
        BEFORE UPDATE ON careers.openings
        FOR EACH ROW
        EXECUTE FUNCTION careers.preserve_opening_seen_bounds();
    END IF;
END;
$$;

ALTER TABLE careers.openings_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE careers.openings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON SCHEMA careers FROM PUBLIC, anon;
REVOKE ALL ON TABLE careers.openings_runs, careers.openings FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION careers.preserve_opening_seen_bounds() FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA careers TO authenticated, service_role;
GRANT SELECT ON TABLE careers.openings_runs, careers.openings TO authenticated;
GRANT ALL ON TABLE careers.openings_runs, careers.openings TO service_role;
GRANT EXECUTE ON FUNCTION careers.preserve_opening_seen_bounds() TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'careers'
          AND tablename = 'openings_runs'
          AND policyname = 'authenticated_read_openings_runs'
    ) THEN
        CREATE POLICY authenticated_read_openings_runs
            ON careers.openings_runs
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'careers'
          AND tablename = 'openings'
          AND policyname = 'authenticated_read_openings'
    ) THEN
        CREATE POLICY authenticated_read_openings
            ON careers.openings
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;
END;
$$;
