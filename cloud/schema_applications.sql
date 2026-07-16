CREATE SCHEMA IF NOT EXISTS careers;

CREATE TABLE IF NOT EXISTS careers.applications (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    org text,
    ats text,
    external_id text,
    source text NOT NULL CHECK (source IN ('lab-openings', 'jobserve', 'manual')),
    title text NOT NULL,
    company text NOT NULL,
    url text,
    status text NOT NULL DEFAULT 'interested' CHECK (
        status IN (
            'interested',
            'shortlisted',
            'cv_staged',
            'sent',
            'response',
            'interview',
            'offer',
            'closed'
        )
    ),
    status_history jsonb NOT NULL DEFAULT '[]'::jsonb
        CHECK (jsonb_typeof(status_history) = 'array'),
    cv_ref text,
    notes text,
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS applications_provenance_unique_idx
    ON careers.applications (org, ats, external_id)
    WHERE org IS NOT NULL AND ats IS NOT NULL AND external_id IS NOT NULL;

ALTER TABLE careers.applications ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE careers.applications FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE careers.applications_id_seq FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SCHEMA careers TO authenticated, service_role;
GRANT SELECT ON TABLE careers.applications TO authenticated;
GRANT ALL ON TABLE careers.applications TO service_role;
GRANT ALL ON SEQUENCE careers.applications_id_seq TO service_role;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
        WHERE schemaname = 'careers'
          AND tablename = 'applications'
          AND policyname = 'authenticated_read_applications'
    ) THEN
        CREATE POLICY authenticated_read_applications
            ON careers.applications
            FOR SELECT
            TO authenticated
            USING (true);
    END IF;
END;
$$;
