-- Apply after cloud/schema.sql and cloud/schema_additions.sql.
-- Complete publications are staged in bounded RPC calls, then committed to the
-- three reader-visible tables by one final transaction.

CREATE TABLE IF NOT EXISTS careers.openings_publication_stage (
    publication_id uuid PRIMARY KEY,
    run_id text NOT NULL,
    run_row jsonb NOT NULL CHECK (jsonb_typeof(run_row) = 'object'),
    parity_row jsonb NOT NULL CHECK (jsonb_typeof(parity_row) = 'object'),
    expected_openings integer NOT NULL CHECK (expected_openings >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE careers.openings_publication_stage
    ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE TABLE IF NOT EXISTS careers.openings_publication_rows_stage (
    publication_id uuid NOT NULL
        REFERENCES careers.openings_publication_stage(publication_id)
        ON DELETE CASCADE,
    org text NOT NULL,
    ats text NOT NULL,
    external_id text NOT NULL,
    opening_row jsonb NOT NULL CHECK (jsonb_typeof(opening_row) = 'object'),
    PRIMARY KEY (publication_id, org, ats, external_id)
);

CREATE TABLE IF NOT EXISTS careers.openings_publication_receipts (
    run_id text PRIMARY KEY,
    publication_id uuid NOT NULL,
    ids_sha256 text NOT NULL,
    expected_openings integer NOT NULL CHECK (expected_openings >= 0),
    completed_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS openings_publication_stage_created_at_idx
    ON careers.openings_publication_stage (created_at);

ALTER TABLE careers.openings_publication_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE careers.openings_publication_rows_stage ENABLE ROW LEVEL SECURITY;
ALTER TABLE careers.openings_publication_receipts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE
    careers.openings_publication_stage,
    careers.openings_publication_rows_stage,
    careers.openings_publication_receipts
FROM PUBLIC, anon, authenticated;

GRANT ALL ON TABLE
    careers.openings_publication_stage,
    careers.openings_publication_rows_stage,
    careers.openings_publication_receipts
TO service_role;

CREATE OR REPLACE FUNCTION careers.assert_openings_run_valid(
    p_run jsonb,
    p_allow_complete boolean
)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    run_health text;
    raw_count integer;
BEGIN
    IF p_run IS NULL OR jsonb_typeof(p_run) <> 'object' THEN
        RAISE EXCEPTION 'run must be a JSON object';
    END IF;

    IF NULLIF(p_run->>'run_id', '') IS NULL
       OR NULLIF(p_run->>'run_date', '') IS NULL
       OR NULLIF(p_run->>'scheduled_at', '') IS NULL
       OR NULLIF(p_run->>'started_at', '') IS NULL
       OR NULLIF(p_run->>'completed_at', '') IS NULL
       OR NULLIF(p_run->>'substrate', '') IS NULL THEN
        RAISE EXCEPTION 'run identity and timestamps are required';
    END IF;

    run_health := p_run->>'health';
    IF run_health IS NULL OR run_health NOT IN ('complete', 'degraded', 'failed') THEN
        RAISE EXCEPTION 'unsupported run health: %', run_health;
    END IF;
    IF run_health = 'complete' AND NOT p_allow_complete THEN
        RAISE EXCEPTION 'complete runs cannot use run-only publication';
    END IF;
    IF p_run->>'substrate' NOT IN ('modal', 'mac') THEN
        RAISE EXCEPTION 'unsupported run substrate: %', p_run->>'substrate';
    END IF;

    IF jsonb_typeof(p_run->'board_status') <> 'array'
       OR jsonb_typeof(p_run->'diagnostics') <> 'array' THEN
        RAISE EXCEPTION 'run board_status and diagnostics must be arrays';
    END IF;
    IF EXISTS (
        SELECT 1
        FROM jsonb_array_elements(p_run->'board_status') AS board(value)
        WHERE jsonb_typeof(board.value) <> 'object'
           OR EXISTS (
               SELECT 1
               FROM jsonb_object_keys(board.value) AS field(key)
               WHERE field.key NOT IN (
                   'org',
                   'company',
                   'ats',
                   'status',
                   'totalOpenings',
                   'error'
               )
           )
    ) THEN
        RAISE EXCEPTION 'run board_status contains non-source fields';
    END IF;

    BEGIN
        raw_count := (p_run->>'raw_openings_count')::integer;
    EXCEPTION
        WHEN invalid_text_representation OR numeric_value_out_of_range THEN
            RAISE EXCEPTION 'run raw_openings_count must be an integer';
    END;

    IF raw_count IS NULL THEN
        RAISE EXCEPTION 'run raw_openings_count is required';
    END IF;
    IF raw_count < 0 THEN
        RAISE EXCEPTION 'run raw_openings_count must be non-negative';
    END IF;

    -- Validate casts before any target-table write.
    PERFORM (p_run->>'run_date')::date;
    PERFORM (p_run->>'scheduled_at')::timestamptz;
    PERFORM (p_run->>'started_at')::timestamptz;
    PERFORM (p_run->>'completed_at')::timestamptz;
END;
$$;

CREATE OR REPLACE FUNCTION careers.persist_openings_run_only(p_run jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
    PERFORM careers.assert_openings_run_valid(p_run, false);

    INSERT INTO careers.openings_runs (
        run_id,
        run_date,
        scheduled_at,
        started_at,
        completed_at,
        health,
        matched_openings_count,
        raw_openings_count,
        eligible_openings_count,
        suitable_openings_count,
        unsuitable_location_openings_count,
        unsuitable_role_openings_count,
        undecided_openings_count,
        board_status,
        diagnostics,
        substrate
    )
    VALUES (
        p_run->>'run_id',
        (p_run->>'run_date')::date,
        (p_run->>'scheduled_at')::timestamptz,
        (p_run->>'started_at')::timestamptz,
        (p_run->>'completed_at')::timestamptz,
        p_run->>'health',
        0,
        (p_run->>'raw_openings_count')::integer,
        0,
        0,
        0,
        0,
        (p_run->>'raw_openings_count')::integer,
        p_run->'board_status',
        p_run->'diagnostics',
        p_run->>'substrate'
    )
    ON CONFLICT (run_id) DO NOTHING;

    IF NOT EXISTS (
        SELECT 1
        FROM careers.openings_runs AS existing
        WHERE existing.run_id = p_run->>'run_id'
          AND existing.run_date = (p_run->>'run_date')::date
          AND existing.scheduled_at = (p_run->>'scheduled_at')::timestamptz
          AND existing.started_at = (p_run->>'started_at')::timestamptz
          AND existing.completed_at = (p_run->>'completed_at')::timestamptz
          AND existing.health = p_run->>'health'
          AND existing.raw_openings_count = (p_run->>'raw_openings_count')::integer
          AND existing.board_status = p_run->'board_status'
          AND existing.diagnostics = p_run->'diagnostics'
          AND existing.substrate = p_run->>'substrate'
    ) THEN
        RAISE EXCEPTION 'run_id already exists with different immutable content: %',
            p_run->>'run_id';
    END IF;

    RETURN jsonb_build_object(
        'run_id', p_run->>'run_id',
        'health', p_run->>'health',
        'persisted_openings', 0,
        'parity_openings_count', NULL
    );
END;
$$;

CREATE OR REPLACE FUNCTION careers.begin_openings_publication(
    p_publication_id uuid,
    p_run jsonb,
    p_parity jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    expected_count integer;
BEGIN
    PERFORM careers.assert_openings_run_valid(p_run, true);
    IF p_run->>'health' <> 'complete' THEN
        RAISE EXCEPTION 'atomic publication requires complete health';
    END IF;
    IF p_publication_id IS NULL THEN
        RAISE EXCEPTION 'publication_id is required';
    END IF;
    IF p_parity IS NULL OR jsonb_typeof(p_parity) <> 'object' THEN
        RAISE EXCEPTION 'parity must be a JSON object';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_run->>'run_id', 0));

    expected_count := (p_run->>'raw_openings_count')::integer;
    IF p_parity->>'run_id' IS DISTINCT FROM p_run->>'run_id'
       OR p_parity->>'run_date' IS DISTINCT FROM p_run->>'run_date'
       OR p_parity->>'substrate' IS DISTINCT FROM p_run->>'substrate'
       OR p_parity->>'openings_count' IS NULL
       OR (p_parity->>'openings_count')::integer <> expected_count
       OR NULLIF(p_parity->>'ids_sha256', '') IS NULL THEN
        RAISE EXCEPTION 'parity identity and counts must match the complete run';
    END IF;

    DELETE FROM careers.openings_publication_stage
    WHERE updated_at < now() - interval '24 hours';

    DELETE FROM careers.openings_publication_stage
    WHERE run_id = p_run->>'run_id'
      AND publication_id <> p_publication_id;

    INSERT INTO careers.openings_publication_stage (
        publication_id,
        run_id,
        run_row,
        parity_row,
        expected_openings
    )
    VALUES (
        p_publication_id,
        p_run->>'run_id',
        p_run,
        p_parity,
        expected_count
    )
    ON CONFLICT (publication_id) DO UPDATE SET
        run_id = EXCLUDED.run_id,
        run_row = EXCLUDED.run_row,
        parity_row = EXCLUDED.parity_row,
        expected_openings = EXCLUDED.expected_openings,
        updated_at = now();

    DELETE FROM careers.openings_publication_rows_stage
    WHERE publication_id = p_publication_id;

    RETURN jsonb_build_object(
        'publication_id', p_publication_id,
        'run_id', p_run->>'run_id',
        'health', 'complete',
        'expected_openings', expected_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION careers.stage_openings_publication(
    p_publication_id uuid,
    p_openings jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    publication_run_id text;
    expected_count integer;
    staged_count integer;
    opening jsonb;
    source_opening jsonb;
BEGIN
    SELECT run_id, expected_openings
    INTO publication_run_id, expected_count
    FROM careers.openings_publication_stage
    WHERE publication_id = p_publication_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown publication_id: %', p_publication_id;
    END IF;
    IF p_openings IS NULL OR jsonb_typeof(p_openings) <> 'array' THEN
        RAISE EXCEPTION 'openings batch must be a JSON array';
    END IF;
    IF jsonb_array_length(p_openings) > 200 THEN
        RAISE EXCEPTION 'openings batch exceeds the 200-row limit';
    END IF;

    FOR opening IN SELECT value FROM jsonb_array_elements(p_openings)
    LOOP
        IF jsonb_typeof(opening) <> 'object'
           OR NULLIF(opening->>'org', '') IS NULL
           OR NULLIF(opening->>'ats', '') IS NULL
           OR NULLIF(opening->>'external_id', '') IS NULL
           OR NULLIF(opening->>'company', '') IS NULL
           OR opening->>'location' IS NULL
           OR NULLIF(opening->>'url', '') IS NULL
           OR opening->>'first_seen_run_id' IS DISTINCT FROM publication_run_id
           OR opening->>'last_seen_run_id' IS DISTINCT FROM publication_run_id
           OR jsonb_typeof(opening->'locations') <> 'array'
           OR opening->'raw' IS NULL
           OR opening->'raw' = 'null'::jsonb THEN
            RAISE EXCEPTION 'invalid opening row for publication %', p_publication_id;
        END IF;

        source_opening := jsonb_build_object(
            'org', opening->>'org',
            'ats', opening->>'ats',
            'external_id', opening->>'external_id',
            'title', opening->'title',
            'company', opening->>'company',
            'location', opening->>'location',
            'locations', opening->'locations',
            'url', opening->>'url',
            'posted_at', opening->'posted_at',
            'raw', opening->'raw',
            'first_seen_run_id', opening->>'first_seen_run_id',
            'first_seen_at', opening->>'first_seen_at',
            'last_seen_run_id', opening->>'last_seen_run_id',
            'last_seen_at', opening->>'last_seen_at'
        );

        INSERT INTO careers.openings_publication_rows_stage (
            publication_id,
            org,
            ats,
            external_id,
            opening_row
        )
        VALUES (
            p_publication_id,
            opening->>'org',
            opening->>'ats',
            opening->>'external_id',
            source_opening
        )
        ON CONFLICT (publication_id, org, ats, external_id) DO UPDATE SET
            opening_row = EXCLUDED.opening_row;
    END LOOP;

    SELECT count(*)::integer
    INTO staged_count
    FROM careers.openings_publication_rows_stage
    WHERE publication_id = p_publication_id;

    IF staged_count > expected_count THEN
        RAISE EXCEPTION 'staged opening count % exceeds expected count %',
            staged_count, expected_count;
    END IF;

    UPDATE careers.openings_publication_stage
    SET updated_at = now()
    WHERE publication_id = p_publication_id;

    RETURN jsonb_build_object(
        'publication_id', p_publication_id,
        'run_id', publication_run_id,
        'staged_openings', staged_count,
        'expected_openings', expected_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION careers.finalize_openings_publication(
    p_publication_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    staged careers.openings_publication_stage%ROWTYPE;
    staged_count integer;
    computed_ids_sha256 text;
BEGIN
    SELECT *
    INTO staged
    FROM careers.openings_publication_stage
    WHERE publication_id = p_publication_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'unknown publication_id: %', p_publication_id;
    END IF;

    PERFORM careers.assert_openings_run_valid(staged.run_row, true);
    IF staged.run_row->>'health' <> 'complete' THEN
        RAISE EXCEPTION 'atomic publication requires complete health';
    END IF;

    SELECT count(*)::integer
    INTO staged_count
    FROM careers.openings_publication_rows_stage
    WHERE publication_id = p_publication_id;

    IF staged_count <> staged.expected_openings THEN
        RAISE EXCEPTION 'staged opening count % does not equal expected count %',
            staged_count, staged.expected_openings;
    END IF;
    IF (staged.parity_row->>'openings_count')::integer <> staged_count THEN
        RAISE EXCEPTION 'parity opening count does not equal staged opening count';
    END IF;

    SELECT encode(
        sha256(
            convert_to(
                COALESCE(
                    string_agg(
                        identity_text,
                        E'\n' ORDER BY identity_text COLLATE "C"
                    ),
                    ''
                ),
                'UTF8'
            )
        ),
        'hex'
    )
    INTO computed_ids_sha256
    FROM (
        SELECT org || ':' || ats || ':' || external_id AS identity_text
        FROM careers.openings_publication_rows_stage
        WHERE publication_id = p_publication_id
    ) AS staged_identities;

    IF staged.parity_row->>'ids_sha256' IS DISTINCT FROM computed_ids_sha256 THEN
        RAISE EXCEPTION 'parity identity digest does not match staged openings';
    END IF;

    INSERT INTO careers.openings_runs (
        run_id,
        run_date,
        scheduled_at,
        started_at,
        completed_at,
        health,
        matched_openings_count,
        raw_openings_count,
        eligible_openings_count,
        suitable_openings_count,
        unsuitable_location_openings_count,
        unsuitable_role_openings_count,
        undecided_openings_count,
        board_status,
        diagnostics,
        substrate
    )
    VALUES (
        staged.run_row->>'run_id',
        (staged.run_row->>'run_date')::date,
        (staged.run_row->>'scheduled_at')::timestamptz,
        (staged.run_row->>'started_at')::timestamptz,
        (staged.run_row->>'completed_at')::timestamptz,
        staged.run_row->>'health',
        0,
        (staged.run_row->>'raw_openings_count')::integer,
        0,
        0,
        0,
        0,
        (staged.run_row->>'raw_openings_count')::integer,
        staged.run_row->'board_status',
        staged.run_row->'diagnostics',
        staged.run_row->>'substrate'
    )
    ON CONFLICT (run_id) DO NOTHING;

    IF NOT EXISTS (
        SELECT 1
        FROM careers.openings_runs AS existing
        WHERE existing.run_id = staged.run_row->>'run_id'
          AND existing.run_date = (staged.run_row->>'run_date')::date
          AND existing.scheduled_at = (staged.run_row->>'scheduled_at')::timestamptz
          AND existing.started_at = (staged.run_row->>'started_at')::timestamptz
          AND existing.completed_at = (staged.run_row->>'completed_at')::timestamptz
          AND existing.health = 'complete'
          AND existing.raw_openings_count = staged.expected_openings
          AND existing.board_status = staged.run_row->'board_status'
          AND existing.diagnostics = staged.run_row->'diagnostics'
          AND existing.substrate = staged.run_row->>'substrate'
    ) THEN
        RAISE EXCEPTION 'run_id already exists with different immutable content: %',
            staged.run_id;
    END IF;

    INSERT INTO careers.openings (
        org,
        ats,
        external_id,
        title,
        company,
        location,
        locations,
        url,
        posted_at,
        location_eligibility,
        location_reason_codes,
        role_relevance,
        role_reason_codes,
        disposition,
        raw,
        first_seen_run_id,
        first_seen_at,
        last_seen_run_id,
        last_seen_at
    )
    SELECT
        staged_row.opening_row->>'org',
        staged_row.opening_row->>'ats',
        staged_row.opening_row->>'external_id',
        staged_row.opening_row->>'title',
        staged_row.opening_row->>'company',
        staged_row.opening_row->>'location',
        ARRAY(
            SELECT jsonb_array_elements_text(staged_row.opening_row->'locations')
        ),
        staged_row.opening_row->>'url',
        NULLIF(staged_row.opening_row->>'posted_at', '')::timestamptz,
        'undecided',
        ARRAY[]::text[],
        'undecided',
        ARRAY[]::text[],
        'undecided',
        staged_row.opening_row->'raw',
        staged_row.opening_row->>'first_seen_run_id',
        (staged_row.opening_row->>'first_seen_at')::timestamptz,
        staged_row.opening_row->>'last_seen_run_id',
        (staged_row.opening_row->>'last_seen_at')::timestamptz
    FROM careers.openings_publication_rows_stage AS staged_row
    WHERE staged_row.publication_id = p_publication_id
    ON CONFLICT (org, ats, external_id) DO UPDATE SET
        title = EXCLUDED.title,
        company = EXCLUDED.company,
        location = EXCLUDED.location,
        locations = EXCLUDED.locations,
        url = EXCLUDED.url,
        posted_at = EXCLUDED.posted_at,
        location_eligibility = EXCLUDED.location_eligibility,
        location_reason_codes = EXCLUDED.location_reason_codes,
        role_relevance = EXCLUDED.role_relevance,
        role_reason_codes = EXCLUDED.role_reason_codes,
        disposition = EXCLUDED.disposition,
        raw = EXCLUDED.raw,
        first_seen_run_id = EXCLUDED.first_seen_run_id,
        first_seen_at = EXCLUDED.first_seen_at,
        last_seen_run_id = EXCLUDED.last_seen_run_id,
        last_seen_at = EXCLUDED.last_seen_at;

    -- The seen-bounds trigger can preserve an existing row during an
    -- out-of-order replay. Normalize the compatibility projection separately so
    -- no previously persisted candidate judgment survives a Radar publication.
    UPDATE careers.openings AS persisted
    SET
        location_eligibility = 'undecided',
        location_reason_codes = ARRAY[]::text[],
        role_relevance = 'undecided',
        role_reason_codes = ARRAY[]::text[],
        disposition = 'undecided'
    WHERE EXISTS (
        SELECT 1
        FROM careers.openings_publication_rows_stage AS staged_row
        WHERE staged_row.publication_id = p_publication_id
          AND staged_row.org = persisted.org
          AND staged_row.ats = persisted.ats
          AND staged_row.external_id = persisted.external_id
    );

    INSERT INTO careers.parity_runs (
        run_date,
        substrate,
        run_id,
        openings_count,
        ids_sha256,
        targets_sha256
    )
    VALUES (
        (staged.parity_row->>'run_date')::date,
        staged.parity_row->>'substrate',
        staged.parity_row->>'run_id',
        (staged.parity_row->>'openings_count')::integer,
        staged.parity_row->>'ids_sha256',
        staged.parity_row->>'targets_sha256'
    )
    ON CONFLICT (run_date, substrate, run_id) DO UPDATE SET
        openings_count = EXCLUDED.openings_count,
        ids_sha256 = EXCLUDED.ids_sha256,
        targets_sha256 = EXCLUDED.targets_sha256;

    INSERT INTO careers.openings_publication_receipts (
        run_id,
        publication_id,
        ids_sha256,
        expected_openings
    )
    VALUES (
        staged.run_id,
        p_publication_id,
        computed_ids_sha256,
        staged_count
    )
    ON CONFLICT (run_id) DO UPDATE SET
        publication_id = EXCLUDED.publication_id,
        ids_sha256 = EXCLUDED.ids_sha256,
        expected_openings = EXCLUDED.expected_openings,
        completed_at = now()
    WHERE careers.openings_publication_receipts.ids_sha256 = EXCLUDED.ids_sha256
      AND careers.openings_publication_receipts.expected_openings =
          EXCLUDED.expected_openings;

    IF NOT EXISTS (
        SELECT 1
        FROM careers.openings_publication_receipts AS receipt
        WHERE receipt.run_id = staged.run_id
          AND receipt.ids_sha256 = computed_ids_sha256
          AND receipt.expected_openings = staged_count
    ) THEN
        RAISE EXCEPTION 'run_id already has a conflicting publication receipt: %',
            staged.run_id;
    END IF;

    DELETE FROM careers.openings_publication_stage
    WHERE publication_id = p_publication_id;

    RETURN jsonb_build_object(
        'publication_id', p_publication_id,
        'run_id', staged.run_id,
        'health', 'complete',
        'expected_openings', staged.expected_openings,
        'persisted_openings', staged_count,
        'parity_openings_count',
            (staged.parity_row->>'openings_count')::integer
    );
END;
$$;

CREATE OR REPLACE FUNCTION careers.verify_openings_publication(
    p_run_id text,
    p_ids_sha256 text
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
    verified_count integer;
BEGIN
    IF NULLIF(p_run_id, '') IS NULL OR NULLIF(p_ids_sha256, '') IS NULL THEN
        RAISE EXCEPTION 'run_id and ids_sha256 are required';
    END IF;

    SELECT receipt.expected_openings
    INTO verified_count
    FROM careers.openings_runs AS run_row
    INNER JOIN careers.parity_runs AS parity_row
        ON parity_row.run_date = run_row.run_date
       AND parity_row.substrate = run_row.substrate
       AND parity_row.run_id = run_row.run_id
    INNER JOIN careers.openings_publication_receipts AS receipt
        ON receipt.run_id = run_row.run_id
    WHERE run_row.run_id = p_run_id
      AND run_row.health = 'complete'
      AND parity_row.openings_count = run_row.raw_openings_count
      AND parity_row.ids_sha256 = p_ids_sha256
      AND receipt.ids_sha256 = p_ids_sha256
      AND receipt.expected_openings = run_row.raw_openings_count;

    IF NOT FOUND THEN
        RETURN jsonb_build_object('published', false);
    END IF;

    RETURN jsonb_build_object(
        'published', true,
        'run_id', p_run_id,
        'health', 'complete',
        'expected_openings', verified_count,
        'persisted_openings', verified_count,
        'parity_openings_count', verified_count
    );
END;
$$;

REVOKE ALL ON FUNCTION
    careers.assert_openings_run_valid(jsonb, boolean),
    careers.persist_openings_run_only(jsonb),
    careers.begin_openings_publication(uuid, jsonb, jsonb),
    careers.stage_openings_publication(uuid, jsonb),
    careers.finalize_openings_publication(uuid),
    careers.verify_openings_publication(text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    careers.assert_openings_run_valid(jsonb, boolean),
    careers.persist_openings_run_only(jsonb),
    careers.begin_openings_publication(uuid, jsonb, jsonb),
    careers.stage_openings_publication(uuid, jsonb),
    careers.finalize_openings_publication(uuid),
    careers.verify_openings_publication(text, text)
TO service_role;

NOTIFY pgrst, 'reload schema';
