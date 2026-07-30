CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $migration$
DECLARE
  pgcrypto_schema text;
BEGIN
  SELECT extension_namespace.nspname
  INTO STRICT pgcrypto_schema
  FROM pg_catalog.pg_extension extension
  JOIN pg_catalog.pg_namespace extension_namespace
    ON extension_namespace.oid = extension.extnamespace
  WHERE extension.extname = 'pgcrypto';

  EXECUTE pg_catalog.format(
    $definition$
      CREATE OR REPLACE FUNCTION job_search.pgcrypto_digest_sha256(input bytea)
      RETURNS bytea
      LANGUAGE sql
      IMMUTABLE
      STRICT
      PARALLEL SAFE
      SECURITY DEFINER
      SET search_path = pg_catalog, pg_temp
      AS $function$
        SELECT %I.digest($1, 'sha256')
      $function$
    $definition$,
    pgcrypto_schema
  );
END;
$migration$;

-- This definer surface exposes only fixed SHA-256 over caller-provided bytes.
-- Runtime writers need no privileges on pgcrypto's installation schema.
GRANT EXECUTE ON FUNCTION job_search.pgcrypto_digest_sha256(bytea) TO PUBLIC;

CREATE OR REPLACE FUNCTION job_search.canonical_json_number(input jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  rendered text;
BEGIN
  rendered := input #>> '{}';
  IF rendered::numeric = 0 THEN
    RETURN '0';
  END IF;
  IF position('.' IN rendered) > 0 THEN
    rendered := regexp_replace(rendered, '(\.[0-9]*?)0+$', '\1');
    rendered := regexp_replace(rendered, '\.$', '');
  END IF;
  RETURN rendered;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.canonical_json_text(input jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
STRICT
AS $$
DECLARE
  kind text;
  rendered text;
BEGIN
  kind := jsonb_typeof(input);
  CASE kind
    WHEN 'null' THEN
      RETURN 'null';
    WHEN 'boolean' THEN
      RETURN input::text;
    WHEN 'number' THEN
      RETURN job_search.canonical_json_number(input);
    WHEN 'string' THEN
      RETURN to_json(input #>> '{}')::text;
    WHEN 'array' THEN
      SELECT '[' || COALESCE(string_agg(job_search.canonical_json_text(item.value), ',' ORDER BY item.position), '') || ']'
      INTO rendered
      FROM jsonb_array_elements(input) WITH ORDINALITY AS item(value, position);
      RETURN rendered;
    WHEN 'object' THEN
      SELECT '{' || COALESCE(
        string_agg(
          to_json(item.key)::text || ':' || job_search.canonical_json_text(item.value),
          ',' ORDER BY item.key COLLATE "C"
        ),
        ''
      ) || '}'
      INTO rendered
      FROM jsonb_each(input) AS item(key, value);
      RETURN rendered;
    ELSE
      RAISE EXCEPTION 'unsupported jsonb kind %', kind
        USING ERRCODE = 'check_violation';
  END CASE;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.canonical_json_sha256(input jsonb)
RETURNS text
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT pg_catalog.encode(
    job_search.pgcrypto_digest_sha256(
      pg_catalog.convert_to(job_search.canonical_json_text(input), 'UTF8')
    ),
    'hex'
  );
$$;

CREATE OR REPLACE FUNCTION job_search.json_numbers_fit_typescript(input jsonb)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
STRICT
PARALLEL SAFE
SET extra_float_digits = 3
AS $$
DECLARE
  kind text;
  numeric_value numeric;
  float_value double precision;
  float_rendered text;
BEGIN
  kind := jsonb_typeof(input);
  IF kind = 'number' THEN
    numeric_value := (input #>> '{}')::numeric;
    BEGIN
      float_value := (input #>> '{}')::double precision;
    EXCEPTION
      WHEN numeric_value_out_of_range THEN
        RETURN false;
    END;
    float_rendered := float_value::text;
    IF float_rendered IN ('Infinity', '-Infinity', 'NaN') THEN
      RETURN false;
    END IF;
    RETURN numeric_value = float_rendered::numeric;
  END IF;
  IF kind = 'array' THEN
    RETURN NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(input) AS item(value)
      WHERE NOT job_search.json_numbers_fit_typescript(item.value)
    );
  END IF;
  IF kind = 'object' THEN
    RETURN NOT EXISTS (
      SELECT 1
      FROM jsonb_each(input) AS item(key, value)
      WHERE NOT job_search.json_numbers_fit_typescript(item.value)
    );
  END IF;
  RETURN true;
END;
$$;

CREATE TABLE IF NOT EXISTS job_search.ingest_runs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_hash text NOT NULL UNIQUE CHECK (run_hash ~ '^[0-9a-f]{64}$'),
  producer text NOT NULL,
  contract_version integer NOT NULL,
  scope_plan jsonb NOT NULL CHECK (
    jsonb_typeof(scope_plan) = 'array'
    AND jsonb_array_length(scope_plan) > 0
  ),
  status text NOT NULL DEFAULT 'collecting' CHECK (
    status IN ('collecting', 'ready', 'committed', 'failed')
  ),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  ready_at timestamptz,
  committed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  CONSTRAINT ingest_runs_producer_canonical CHECK (
    producer <> '' AND producer = btrim(producer)
  ),
  CONSTRAINT ingest_runs_contract_version CHECK (contract_version = 1),
  CONSTRAINT ingest_runs_scope_plan_typescript_numbers CHECK (
    job_search.json_numbers_fit_typescript(scope_plan)
  ),
  CONSTRAINT ingest_runs_created_at_millisecond CHECK (
    date_trunc('milliseconds', created_at) = created_at
  ),
  CONSTRAINT ingest_runs_ready_at_millisecond CHECK (
    ready_at IS NULL OR date_trunc('milliseconds', ready_at) = ready_at
  ),
  CONSTRAINT ingest_runs_committed_at_millisecond CHECK (
    committed_at IS NULL OR date_trunc('milliseconds', committed_at) = committed_at
  ),
  CONSTRAINT ingest_runs_failed_at_millisecond CHECK (
    failed_at IS NULL OR date_trunc('milliseconds', failed_at) = failed_at
  ),
  CONSTRAINT ingest_runs_failed_after_ready CHECK (
    failed_at IS NULL OR ready_at IS NULL OR failed_at >= ready_at
  ),
  CONSTRAINT ingest_runs_committed_after_ready CHECK (
    committed_at IS NULL OR ready_at IS NULL OR committed_at >= ready_at
  ),
  CONSTRAINT ingest_runs_status_fields CHECK (
    (status = 'collecting' AND ready_at IS NULL AND committed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'ready' AND ready_at IS NOT NULL AND committed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'committed' AND ready_at IS NOT NULL AND committed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL)
    OR (status = 'failed' AND committed_at IS NULL AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND btrim(failure_code) <> '')
  )
);

CREATE TABLE IF NOT EXISTS job_search.ingest_source_scopes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL REFERENCES job_search.ingest_runs(id) ON DELETE RESTRICT,
  scope_hash text NOT NULL CHECK (scope_hash ~ '^[0-9a-f]{64}$'),
  source_id text NOT NULL,
  scope_key text NOT NULL,
  request_payload jsonb NOT NULL CHECK (jsonb_typeof(request_payload) = 'object'),
  status text NOT NULL DEFAULT 'pending' CHECK (
    status IN ('pending', 'running', 'complete', 'failed')
  ),
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  failure_code text,
  result_count integer CHECK (result_count IS NULL OR result_count >= 0),
  CONSTRAINT ingest_source_scopes_source_id_canonical CHECK (
    source_id <> '' AND source_id = btrim(source_id)
  ),
  CONSTRAINT ingest_source_scopes_scope_key_canonical CHECK (
    scope_key <> '' AND scope_key = btrim(scope_key)
  ),
  CONSTRAINT ingest_source_scopes_request_typescript_numbers CHECK (
    job_search.json_numbers_fit_typescript(request_payload)
  ),
  CONSTRAINT ingest_source_scopes_started_at_millisecond CHECK (
    started_at IS NULL OR date_trunc('milliseconds', started_at) = started_at
  ),
  CONSTRAINT ingest_source_scopes_completed_at_millisecond CHECK (
    completed_at IS NULL OR date_trunc('milliseconds', completed_at) = completed_at
  ),
  CONSTRAINT ingest_source_scopes_failed_at_millisecond CHECK (
    failed_at IS NULL OR date_trunc('milliseconds', failed_at) = failed_at
  ),
  CONSTRAINT ingest_source_scopes_status_fields CHECK (
    (status = 'pending' AND started_at IS NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND result_count IS NULL)
    OR (status = 'running' AND started_at IS NOT NULL AND completed_at IS NULL AND failed_at IS NULL AND failure_code IS NULL AND result_count IS NULL)
    OR (status = 'complete' AND completed_at IS NOT NULL AND failed_at IS NULL AND failure_code IS NULL AND result_count IS NOT NULL)
    OR (status = 'failed' AND completed_at IS NULL AND failed_at IS NOT NULL AND failure_code IS NOT NULL AND btrim(failure_code) <> '' AND result_count IS NULL)
  ),
  UNIQUE (run_id, scope_hash),
  UNIQUE (run_id, source_id, scope_key)
);

CREATE TABLE IF NOT EXISTS job_search.ingest_observations (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_id bigint NOT NULL REFERENCES job_search.ingest_source_scopes(id) ON DELETE RESTRICT,
  observation_hash text NOT NULL CHECK (observation_hash ~ '^[0-9a-f]{64}$'),
  source_record_key text NOT NULL,
  observed_at timestamptz NOT NULL,
  raw_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT ingest_observations_source_record_key_canonical CHECK (
    source_record_key <> '' AND source_record_key = btrim(source_record_key)
  ),
  CONSTRAINT ingest_observations_raw_typescript_numbers CHECK (
    job_search.json_numbers_fit_typescript(raw_payload)
  ),
  CONSTRAINT ingest_observations_observed_at_millisecond CHECK (
    date_trunc('milliseconds', observed_at) = observed_at
  ),
  CONSTRAINT ingest_observations_created_at_millisecond CHECK (
    date_trunc('milliseconds', created_at) = created_at
  ),
  UNIQUE (scope_id, observation_hash)
);

CREATE TABLE IF NOT EXISTS job_search.ingest_listing_versions (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  created_by_scope_id bigint NOT NULL REFERENCES job_search.ingest_source_scopes(id) ON DELETE RESTRICT,
  contract_version integer NOT NULL,
  version_hash text NOT NULL UNIQUE CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  listing_key text NOT NULL,
  normalizer text NOT NULL,
  normalized_payload jsonb NOT NULL CHECK (jsonb_typeof(normalized_payload) = 'object'),
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT ingest_listing_versions_contract_version CHECK (contract_version = 1),
  CONSTRAINT ingest_listing_versions_listing_key_canonical CHECK (
    listing_key <> '' AND listing_key = btrim(listing_key)
  ),
  CONSTRAINT ingest_listing_versions_normalizer_canonical CHECK (
    normalizer <> '' AND normalizer = btrim(normalizer)
  ),
  CONSTRAINT ingest_listing_versions_normalized_typescript_numbers CHECK (
    job_search.json_numbers_fit_typescript(normalized_payload)
  ),
  CONSTRAINT ingest_listing_versions_created_at_millisecond CHECK (
    date_trunc('milliseconds', created_at) = created_at
  )
);

CREATE TABLE IF NOT EXISTS job_search.ingest_observation_versions (
  observation_id bigint NOT NULL REFERENCES job_search.ingest_observations(id) ON DELETE RESTRICT,
  listing_version_id bigint NOT NULL REFERENCES job_search.ingest_listing_versions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT date_trunc('milliseconds', clock_timestamp()),
  CONSTRAINT ingest_observation_versions_created_at_millisecond CHECK (
    date_trunc('milliseconds', created_at) = created_at
  ),
  PRIMARY KEY (observation_id, listing_version_id)
);

CREATE TABLE IF NOT EXISTS job_search.ingest_commit_manifests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id bigint NOT NULL UNIQUE REFERENCES job_search.ingest_runs(id) ON DELETE RESTRICT,
  manifest_hash text NOT NULL UNIQUE CHECK (manifest_hash ~ '^[0-9a-f]{64}$'),
  manifest_payload jsonb NOT NULL CHECK (jsonb_typeof(manifest_payload) = 'object'),
  scope_count integer NOT NULL CHECK (scope_count > 0),
  observation_count integer NOT NULL CHECK (observation_count >= 0),
  listing_version_count integer NOT NULL CHECK (listing_version_count >= 0),
  edge_count integer NOT NULL CHECK (edge_count >= 0),
  committed_at timestamptz NOT NULL,
  CONSTRAINT ingest_commit_manifests_payload_typescript_numbers CHECK (
    job_search.json_numbers_fit_typescript(manifest_payload)
  ),
  CONSTRAINT ingest_commit_manifests_committed_at_millisecond CHECK (
    date_trunc('milliseconds', committed_at) = committed_at
  )
);

CREATE OR REPLACE FUNCTION job_search.require_collecting_ingest_run(parent_run_id bigint)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
AS $$
DECLARE
  run_status text;
  run_contract_version integer;
BEGIN
  SELECT status, contract_version
  INTO run_status, run_contract_version
  FROM job_search.ingest_runs
  WHERE id = parent_run_id
  FOR UPDATE;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'ingest run % does not exist', parent_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF run_status <> 'collecting' THEN
    RAISE EXCEPTION 'ingest run % is %, not collecting', parent_run_id, run_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN run_contract_version;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_run_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  expected_hash text;
  sorted_scope_plan jsonb;
BEGIN
  NEW.created_at := date_trunc('milliseconds', clock_timestamp());

  IF NEW.status <> 'collecting' THEN
    RAISE EXCEPTION 'new ingest runs must start collecting'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT jsonb_agg(planned_scope.value ORDER BY planned_scope.value->>'scopeHash' COLLATE "C")
  INTO sorted_scope_plan
  FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value);

  IF NEW.scope_plan IS DISTINCT FROM sorted_scope_plan THEN
    RAISE EXCEPTION 'ingest run scope_plan must be sorted by scopeHash'
      USING ERRCODE = 'check_violation';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value)
    WHERE jsonb_typeof(planned_scope.value) <> 'object'
       OR planned_scope.value <> jsonb_strip_nulls(
         jsonb_build_object(
           'scopeHash', planned_scope.value->'scopeHash',
           'sourceId', planned_scope.value->'sourceId',
           'scopeKey', planned_scope.value->'scopeKey',
           'request', planned_scope.value->'request'
         )
       )
       OR COALESCE(planned_scope.value->>'scopeHash', '') !~ '^[0-9a-f]{64}$'
       OR btrim(COALESCE(planned_scope.value->>'sourceId', '')) = ''
       OR btrim(COALESCE(planned_scope.value->>'scopeKey', '')) = ''
       OR planned_scope.value->>'sourceId' IS DISTINCT FROM btrim(planned_scope.value->>'sourceId')
       OR planned_scope.value->>'scopeKey' IS DISTINCT FROM btrim(planned_scope.value->>'scopeKey')
       OR COALESCE(jsonb_typeof(planned_scope.value->'request'), 'null') <> 'object'
       OR planned_scope.value->>'scopeHash' IS DISTINCT FROM job_search.canonical_json_sha256(
         jsonb_build_object(
           'contractVersion', NEW.contract_version,
           'sourceId', planned_scope.value->>'sourceId',
           'scopeKey', planned_scope.value->>'scopeKey',
           'request', planned_scope.value->'request'
         )
       )
  ) THEN
    RAISE EXCEPTION 'ingest run scope_plan contains an invalid scope identity'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value)
  ) <> (
    SELECT count(DISTINCT planned_scope.value->>'scopeHash')
    FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value)
  ) THEN
    RAISE EXCEPTION 'ingest run scope_plan contains duplicate scope hashes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF (
    SELECT count(*)
    FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value)
  ) <> (
    SELECT count(DISTINCT (
      planned_scope.value->>'sourceId',
      planned_scope.value->>'scopeKey'
    ))
    FROM jsonb_array_elements(NEW.scope_plan) AS planned_scope(value)
  ) THEN
    RAISE EXCEPTION 'ingest run scope_plan contains duplicate source identities'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_hash := job_search.canonical_json_sha256(
    jsonb_build_object(
      'contractVersion', NEW.contract_version,
      'producer', NEW.producer,
      'scopes', NEW.scope_plan
    )
  );
  IF NEW.run_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'ingest run hash does not match canonical identity'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_source_scope_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_contract_version integer;
  run_scope_plan jsonb;
  expected_identity jsonb;
  expected_hash text;
BEGIN
  run_contract_version := job_search.require_collecting_ingest_run(NEW.run_id);
  SELECT scope_plan
  INTO run_scope_plan
  FROM job_search.ingest_runs
  WHERE id = NEW.run_id;

  IF NEW.status <> 'pending' THEN
    RAISE EXCEPTION 'new ingest source scopes must start pending'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_hash := job_search.canonical_json_sha256(
    jsonb_build_object(
      'contractVersion', run_contract_version,
      'sourceId', NEW.source_id,
      'scopeKey', NEW.scope_key,
      'request', NEW.request_payload
    )
  );
  IF NEW.scope_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'ingest source scope hash does not match canonical identity'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_identity := jsonb_build_object(
    'sourceId', NEW.source_id,
    'scopeKey', NEW.scope_key,
    'scopeHash', NEW.scope_hash,
    'request', NEW.request_payload
  );
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(run_scope_plan) AS planned_scope(value)
    WHERE planned_scope.value = expected_identity
  ) THEN
    RAISE EXCEPTION 'ingest source scope is not declared in the parent run plan'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.reject_ingest_ledger_delete()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ingest ledger rows are durable and cannot be deleted from %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION job_search.reject_ingest_ledger_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'ingest ledger rows are immutable in %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION job_search.reject_ingest_child_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id bigint;
BEGIN
  CASE TG_TABLE_NAME
    WHEN 'ingest_source_scopes' THEN
      parent_run_id := OLD.run_id;
    WHEN 'ingest_observations' THEN
      SELECT source_scope.run_id
      INTO parent_run_id
      FROM job_search.ingest_source_scopes source_scope
      WHERE source_scope.id = OLD.scope_id;
    WHEN 'ingest_listing_versions' THEN
      SELECT source_scope.run_id
      INTO parent_run_id
      FROM job_search.ingest_source_scopes source_scope
      WHERE source_scope.id = OLD.created_by_scope_id;
    WHEN 'ingest_observation_versions' THEN
      SELECT source_scope.run_id
      INTO parent_run_id
      FROM job_search.ingest_observations observation
      JOIN job_search.ingest_source_scopes source_scope ON source_scope.id = observation.scope_id
      WHERE observation.id = OLD.observation_id;
    ELSE
      RAISE EXCEPTION 'unsupported ingest child table %', TG_TABLE_NAME
        USING ERRCODE = 'check_violation';
  END CASE;

  PERFORM job_search.require_collecting_ingest_run(parent_run_id);
  RAISE EXCEPTION 'ingest ledger rows are immutable in %.%', TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_observation_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id bigint;
  run_contract_version integer;
  scope_status text;
  scope_started_at timestamptz;
  expected_hash text;
BEGIN
  SELECT run_id
  INTO parent_run_id
  FROM job_search.ingest_source_scopes
  WHERE id = NEW.scope_id;

  run_contract_version := job_search.require_collecting_ingest_run(parent_run_id);

  SELECT status, started_at
  INTO scope_status, scope_started_at
  FROM job_search.ingest_source_scopes
  WHERE id = NEW.scope_id
  FOR UPDATE;

  IF scope_status IS NULL THEN
    RAISE EXCEPTION 'ingest source scope % does not exist', NEW.scope_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF scope_status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'cannot append an observation to source scope % in state %', NEW.scope_id, scope_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF scope_started_at IS NOT NULL
     AND NEW.observed_at < scope_started_at THEN
    RAISE EXCEPTION 'ingest observation observed_at cannot precede source scope started_at'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.created_at := date_trunc('milliseconds', clock_timestamp());

  expected_hash := job_search.canonical_json_sha256(
    jsonb_build_object(
      'contractVersion', run_contract_version,
      'scopeHash', (
        SELECT scope_hash
        FROM job_search.ingest_source_scopes
        WHERE id = NEW.scope_id
      ),
      'sourceRecordKey', NEW.source_record_key,
      'observedAt', to_char(
        NEW.observed_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'raw', NEW.raw_payload
    )
  );
  IF NEW.observation_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'ingest observation hash does not match canonical identity'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_listing_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id bigint;
  run_contract_version integer;
  scope_status text;
  expected_hash text;
BEGIN
  SELECT run_id
  INTO parent_run_id
  FROM job_search.ingest_source_scopes
  WHERE id = NEW.created_by_scope_id;

  run_contract_version := job_search.require_collecting_ingest_run(parent_run_id);

  SELECT status
  INTO scope_status
  FROM job_search.ingest_source_scopes
  WHERE id = NEW.created_by_scope_id
  FOR UPDATE;

  IF scope_status IS NULL THEN
    RAISE EXCEPTION 'ingest source scope % does not exist', NEW.created_by_scope_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF scope_status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'cannot create a listing version from source scope % in state %', NEW.created_by_scope_id, scope_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.contract_version IS DISTINCT FROM run_contract_version THEN
    RAISE EXCEPTION 'listing version contract_version does not match its parent run'
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.created_at := date_trunc('milliseconds', clock_timestamp());

  expected_hash := job_search.canonical_json_sha256(
    jsonb_build_object(
      'contractVersion', NEW.contract_version,
      'listingKey', NEW.listing_key,
      'normalizer', NEW.normalizer,
      'normalized', NEW.normalized_payload
    )
  );
  IF NEW.version_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'ingest listing version hash does not match canonical identity'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_observation_version_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_run_id bigint;
  run_contract_version integer;
  scope_status text;
  database_created_at timestamptz;
BEGIN
  SELECT source_scope.run_id
  INTO parent_run_id
  FROM job_search.ingest_observations observation
  JOIN job_search.ingest_source_scopes source_scope ON source_scope.id = observation.scope_id
  WHERE observation.id = NEW.observation_id;

  run_contract_version := job_search.require_collecting_ingest_run(parent_run_id);

  IF (
    SELECT contract_version
    FROM job_search.ingest_listing_versions
    WHERE id = NEW.listing_version_id
  ) IS DISTINCT FROM run_contract_version THEN
    RAISE EXCEPTION 'provenance cannot cross ingest contract versions'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT source_scope.status
  INTO scope_status
  FROM job_search.ingest_observations observation
  JOIN job_search.ingest_source_scopes source_scope ON source_scope.id = observation.scope_id
  WHERE observation.id = NEW.observation_id
  FOR UPDATE OF source_scope;

  IF scope_status IS NULL THEN
    RAISE EXCEPTION 'ingest observation % does not exist', NEW.observation_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF scope_status NOT IN ('pending', 'running') THEN
    RAISE EXCEPTION 'cannot append provenance to an observation in source scope state %', scope_status
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT GREATEST(
    date_trunc('milliseconds', clock_timestamp()),
    observation.created_at,
    listing_version.created_at
  )
  INTO database_created_at
  FROM job_search.ingest_observations observation
  CROSS JOIN job_search.ingest_listing_versions listing_version
  WHERE observation.id = NEW.observation_id
    AND listing_version.id = NEW.listing_version_id;

  NEW.created_at := database_created_at;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_source_scope_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  persisted_observation_count integer;
BEGIN
  PERFORM job_search.require_collecting_ingest_run(OLD.run_id);

  IF NEW.run_id IS DISTINCT FROM OLD.run_id
     OR NEW.scope_hash IS DISTINCT FROM OLD.scope_hash
     OR NEW.source_id IS DISTINCT FROM OLD.source_id
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.request_payload IS DISTINCT FROM OLD.request_payload THEN
    RAISE EXCEPTION 'ingest source scope identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW = OLD THEN
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'ingest source scope state fields cannot change without a legal transition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    (OLD.status = 'pending' AND NEW.status IN ('running', 'complete', 'failed'))
    OR (OLD.status = 'running' AND NEW.status IN ('complete', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal ingest source scope transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.started_at IS NOT NULL
     AND NEW.started_at IS DISTINCT FROM OLD.started_at THEN
    RAISE EXCEPTION 'ingest source scope started_at is immutable once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'pending'
     AND NEW.status IN ('complete', 'failed')
     AND NEW.started_at IS NOT NULL THEN
    RAISE EXCEPTION 'pending source scope terminal transition must preserve null started_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.completed_at IS NOT NULL
     AND NEW.started_at IS NOT NULL
     AND NEW.completed_at < NEW.started_at THEN
    RAISE EXCEPTION 'ingest source scope completed_at cannot precede started_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.failed_at IS NOT NULL
     AND NEW.started_at IS NOT NULL
     AND NEW.failed_at < NEW.started_at THEN
    RAISE EXCEPTION 'ingest source scope failed_at cannot precede started_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.started_at IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM job_search.ingest_observations
       WHERE scope_id = NEW.id
         AND observed_at < NEW.started_at
     ) THEN
    RAISE EXCEPTION 'source scope started_at cannot follow a persisted observation observed_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'complete'
     AND EXISTS (
       SELECT 1
       FROM job_search.ingest_observations
       WHERE scope_id = NEW.id
         AND observed_at > NEW.completed_at
     ) THEN
    RAISE EXCEPTION 'source scope completed_at cannot precede a persisted observation observed_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'failed'
     AND EXISTS (
       SELECT 1
       FROM job_search.ingest_observations
       WHERE scope_id = NEW.id
         AND observed_at > NEW.failed_at
     ) THEN
    RAISE EXCEPTION 'source scope failed_at cannot precede a persisted observation observed_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'complete' THEN
    SELECT count(*)::integer
    INTO persisted_observation_count
    FROM job_search.ingest_observations
    WHERE scope_id = NEW.id;

    IF NEW.result_count IS DISTINCT FROM persisted_observation_count THEN
      RAISE EXCEPTION 'source scope result_count % does not match % persisted observations', NEW.result_count, persisted_observation_count
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_run_transition()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  source_scope_count integer;
  persisted_manifest_committed_at timestamptz;
BEGIN
  IF NEW.run_hash IS DISTINCT FROM OLD.run_hash
     OR NEW.producer IS DISTINCT FROM OLD.producer
     OR NEW.contract_version IS DISTINCT FROM OLD.contract_version
     OR NEW.scope_plan IS DISTINCT FROM OLD.scope_plan
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'ingest run identity is immutable'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW = OLD THEN
    RETURN NEW;
  END IF;

  IF NEW.status = OLD.status THEN
    RAISE EXCEPTION 'ingest run state fields cannot change without a legal transition'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NOT (
    (OLD.status = 'collecting' AND NEW.status IN ('ready', 'failed'))
    OR (OLD.status = 'ready' AND NEW.status IN ('committed', 'failed'))
  ) THEN
    RAISE EXCEPTION 'illegal ingest run transition: % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status = 'collecting'
     AND NEW.status = 'failed'
     AND NEW.ready_at IS NOT NULL THEN
    RAISE EXCEPTION 'collecting ingest run failure must preserve null ready_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.ready_at IS NOT NULL
     AND NEW.ready_at IS DISTINCT FROM OLD.ready_at THEN
    RAISE EXCEPTION 'ingest run ready_at is immutable once set'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'failed'
     AND NEW.ready_at IS NOT NULL
     AND NEW.failed_at < NEW.ready_at THEN
    RAISE EXCEPTION 'ingest run failed_at cannot precede ready_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'failed'
     AND EXISTS (
       SELECT 1
       FROM job_search.ingest_source_scopes source_scope
       LEFT JOIN job_search.ingest_observations observation
         ON observation.scope_id = source_scope.id
       WHERE source_scope.run_id = NEW.id
         AND (
           source_scope.started_at > NEW.failed_at
           OR source_scope.completed_at > NEW.failed_at
           OR source_scope.failed_at > NEW.failed_at
           OR observation.observed_at > NEW.failed_at
         )
     ) THEN
    RAISE EXCEPTION 'ingest run failed_at cannot precede recorded scope or evidence lifecycle timestamps'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status = 'ready' THEN
    SELECT count(*)::integer
    INTO source_scope_count
    FROM job_search.ingest_source_scopes
    WHERE run_id = NEW.id;

    IF source_scope_count = 0 THEN
      RAISE EXCEPTION 'ingest run % has no explicit source scopes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF source_scope_count IS DISTINCT FROM jsonb_array_length(NEW.scope_plan) THEN
      RAISE EXCEPTION 'ingest run % does not contain every declared source scope', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM job_search.ingest_source_scopes
      WHERE run_id = NEW.id
        AND status <> 'complete'
    ) THEN
      RAISE EXCEPTION 'ingest run % has incomplete source scopes', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM job_search.ingest_source_scopes
      WHERE run_id = NEW.id
        AND completed_at > NEW.ready_at
    ) THEN
      RAISE EXCEPTION 'ingest run ready_at cannot precede a source scope completed_at'
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM job_search.ingest_observations observation
      JOIN job_search.ingest_source_scopes source_scope ON source_scope.id = observation.scope_id
      WHERE source_scope.run_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM job_search.ingest_observation_versions provenance
          WHERE provenance.observation_id = observation.id
        )
    ) THEN
      RAISE EXCEPTION 'ingest run % contains observations without normalized-version provenance', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM job_search.ingest_listing_versions listing_version
      JOIN job_search.ingest_source_scopes producer_scope
        ON producer_scope.id = listing_version.created_by_scope_id
      WHERE producer_scope.run_id = NEW.id
        AND NOT EXISTS (
          SELECT 1
          FROM job_search.ingest_observation_versions provenance
          JOIN job_search.ingest_observations observation
            ON observation.id = provenance.observation_id
          JOIN job_search.ingest_source_scopes observation_scope
            ON observation_scope.id = observation.scope_id
          WHERE provenance.listing_version_id = listing_version.id
            AND observation_scope.run_id = NEW.id
        )
    ) THEN
      RAISE EXCEPTION 'ingest run % contains listing versions without same-run provenance', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status = 'committed' THEN
    SELECT committed_at
    INTO persisted_manifest_committed_at
    FROM job_search.ingest_commit_manifests
    WHERE run_id = NEW.id;

    IF persisted_manifest_committed_at IS NULL THEN
      RAISE EXCEPTION 'ingest run % cannot commit without a manifest', NEW.id
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.committed_at IS DISTINCT FROM persisted_manifest_committed_at THEN
      RAISE EXCEPTION 'ingest run committed_at must equal its manifest committed_at'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.build_ingest_manifest_payload(requested_run_id bigint)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_build_object(
    'contractVersion', ingest_run.contract_version,
    'runHash', ingest_run.run_hash,
    'scopes', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'scopeHash', source_scope.scope_hash,
            'sourceId', source_scope.source_id,
            'scopeKey', source_scope.scope_key,
            'resultCount', source_scope.result_count,
            'observationHashes', COALESCE(
              (
                SELECT jsonb_agg(observation.observation_hash ORDER BY observation.observation_hash)
                FROM job_search.ingest_observations observation
                WHERE observation.scope_id = source_scope.id
              ),
              '[]'::jsonb
            )
          )
          ORDER BY source_scope.scope_hash
        )
        FROM job_search.ingest_source_scopes source_scope
        WHERE source_scope.run_id = ingest_run.id
      ),
      '[]'::jsonb
    ),
    'versionHashes', COALESCE(
      (
        SELECT jsonb_agg(referenced_version.version_hash ORDER BY referenced_version.version_hash)
        FROM (
          SELECT DISTINCT listing_version.version_hash
          FROM job_search.ingest_source_scopes source_scope
          JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
          JOIN job_search.ingest_observation_versions provenance ON provenance.observation_id = observation.id
          JOIN job_search.ingest_listing_versions listing_version ON listing_version.id = provenance.listing_version_id
          WHERE source_scope.run_id = ingest_run.id
        ) referenced_version
      ),
      '[]'::jsonb
    ),
    'edges', COALESCE(
      (
        SELECT jsonb_agg(
          jsonb_build_object(
            'observationHash', referenced_edge.observation_hash,
            'versionHash', referenced_edge.version_hash
          )
          ORDER BY referenced_edge.observation_hash, referenced_edge.version_hash
        )
        FROM (
          SELECT observation.observation_hash, listing_version.version_hash
          FROM job_search.ingest_source_scopes source_scope
          JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
          JOIN job_search.ingest_observation_versions provenance ON provenance.observation_id = observation.id
          JOIN job_search.ingest_listing_versions listing_version ON listing_version.id = provenance.listing_version_id
          WHERE source_scope.run_id = ingest_run.id
        ) referenced_edge
      ),
      '[]'::jsonb
    )
  )
  FROM job_search.ingest_runs ingest_run
  WHERE ingest_run.id = requested_run_id;
$$;

CREATE OR REPLACE FUNCTION job_search.guard_ingest_commit_manifest_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_ready_at timestamptz;
  expected_manifest_payload jsonb;
  actual_scope_count integer;
  actual_observation_count integer;
  actual_listing_version_count integer;
  actual_edge_count integer;
BEGIN
  SELECT status, ready_at
  INTO run_status, run_ready_at
  FROM job_search.ingest_runs
  WHERE id = NEW.run_id
  FOR UPDATE;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'ingest run % does not exist', NEW.run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF run_status <> 'ready' THEN
    RAISE EXCEPTION 'ingest run % must be ready before manifest insertion; state is %', NEW.run_id, run_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.committed_at < run_ready_at THEN
    RAISE EXCEPTION 'ingest manifest committed_at cannot precede ingest run ready_at'
      USING ERRCODE = 'check_violation';
  END IF;

  expected_manifest_payload := job_search.build_ingest_manifest_payload(NEW.run_id);
  IF NEW.manifest_payload IS DISTINCT FROM expected_manifest_payload THEN
    RAISE EXCEPTION 'ingest manifest payload does not match persisted ledger rows'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.manifest_hash IS DISTINCT FROM job_search.canonical_json_sha256(NEW.manifest_payload) THEN
    RAISE EXCEPTION 'ingest manifest hash does not match canonical payload'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    count(DISTINCT source_scope.id)::integer,
    count(DISTINCT observation.id)::integer,
    count(DISTINCT provenance.listing_version_id)::integer,
    count(DISTINCT (provenance.observation_id, provenance.listing_version_id))::integer
  INTO actual_scope_count, actual_observation_count, actual_listing_version_count, actual_edge_count
  FROM job_search.ingest_source_scopes source_scope
  LEFT JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
  LEFT JOIN job_search.ingest_observation_versions provenance ON provenance.observation_id = observation.id
  WHERE source_scope.run_id = NEW.run_id;

  IF NEW.scope_count IS DISTINCT FROM actual_scope_count
     OR NEW.observation_count IS DISTINCT FROM actual_observation_count
     OR NEW.listing_version_count IS DISTINCT FROM actual_listing_version_count
     OR NEW.edge_count IS DISTINCT FROM actual_edge_count THEN
    RAISE EXCEPTION 'ingest manifest counts do not match persisted ledger rows'
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION job_search.commit_ingest_run(
  requested_run_id bigint,
  requested_manifest_hash text,
  requested_manifest_payload jsonb,
  requested_committed_at text
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  current_status text;
  committed_manifest_id bigint;
  committed_manifest_hash text;
  committed_manifest_payload jsonb;
  committed_manifest_at timestamptz;
  persisted_ready_at timestamptz;
  persisted_committed_at timestamptz;
  parsed_committed_at timestamptz;
  actual_scope_count integer;
  actual_observation_count integer;
  actual_listing_version_count integer;
  actual_edge_count integer;
BEGIN
  IF requested_committed_at IS NULL
     OR requested_committed_at !~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$' THEN
    RAISE EXCEPTION 'committed_at must be an exact UTC ISO-8601 millisecond timestamp'
      USING ERRCODE = 'invalid_datetime_format';
  END IF;

  BEGIN
    parsed_committed_at := requested_committed_at::timestamptz;
  EXCEPTION
    WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RAISE EXCEPTION 'committed_at must be an exact UTC ISO-8601 millisecond timestamp'
        USING ERRCODE = 'invalid_datetime_format';
  END;

  IF to_char(
       parsed_committed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     ) IS DISTINCT FROM requested_committed_at THEN
    RAISE EXCEPTION 'committed_at must be an exact UTC ISO-8601 millisecond timestamp'
      USING ERRCODE = 'invalid_datetime_format';
  END IF;

  SELECT status, ready_at, committed_at
  INTO current_status, persisted_ready_at, persisted_committed_at
  FROM job_search.ingest_runs
  WHERE id = requested_run_id
  FOR UPDATE;

  IF current_status IS NULL THEN
    RAISE EXCEPTION 'ingest run % does not exist', requested_run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  IF persisted_ready_at IS NOT NULL
     AND parsed_committed_at < persisted_ready_at THEN
    RAISE EXCEPTION 'ingest run committed_at cannot precede ready_at'
      USING ERRCODE = 'check_violation';
  END IF;

  IF current_status = 'committed' THEN
    SELECT id, manifest_hash, manifest_payload, committed_at
    INTO committed_manifest_id, committed_manifest_hash, committed_manifest_payload, committed_manifest_at
    FROM job_search.ingest_commit_manifests
    WHERE run_id = requested_run_id;

    IF committed_manifest_hash IS DISTINCT FROM requested_manifest_hash
       OR committed_manifest_payload IS DISTINCT FROM requested_manifest_payload
       OR committed_manifest_at IS DISTINCT FROM parsed_committed_at
       OR persisted_committed_at IS DISTINCT FROM parsed_committed_at THEN
      RAISE EXCEPTION 'ingest run % was already committed with a different manifest or committed_at', requested_run_id
        USING ERRCODE = 'unique_violation';
    END IF;

    RETURN committed_manifest_id;
  END IF;

  IF current_status <> 'ready' THEN
    RAISE EXCEPTION 'ingest run % must be ready before commit; state is %', requested_run_id, current_status
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM job_search.ingest_listing_versions listing_version
    JOIN job_search.ingest_source_scopes producer_scope
      ON producer_scope.id = listing_version.created_by_scope_id
    WHERE producer_scope.run_id = requested_run_id
      AND NOT EXISTS (
        SELECT 1
        FROM job_search.ingest_observation_versions provenance
        JOIN job_search.ingest_observations observation
          ON observation.id = provenance.observation_id
        JOIN job_search.ingest_source_scopes observation_scope
          ON observation_scope.id = observation.scope_id
        WHERE provenance.listing_version_id = listing_version.id
          AND observation_scope.run_id = requested_run_id
      )
  ) THEN
    RAISE EXCEPTION 'ingest run % contains listing versions without same-run provenance', requested_run_id
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT
    count(DISTINCT source_scope.id)::integer,
    count(DISTINCT observation.id)::integer,
    count(DISTINCT provenance.listing_version_id)::integer,
    count(DISTINCT (provenance.observation_id, provenance.listing_version_id))::integer
  INTO actual_scope_count, actual_observation_count, actual_listing_version_count, actual_edge_count
  FROM job_search.ingest_source_scopes source_scope
  LEFT JOIN job_search.ingest_observations observation ON observation.scope_id = source_scope.id
  LEFT JOIN job_search.ingest_observation_versions provenance ON provenance.observation_id = observation.id
  WHERE source_scope.run_id = requested_run_id;

  INSERT INTO job_search.ingest_commit_manifests (
    run_id,
    manifest_hash,
    manifest_payload,
    scope_count,
    observation_count,
    listing_version_count,
    edge_count,
    committed_at
  )
  VALUES (
    requested_run_id,
    requested_manifest_hash,
    requested_manifest_payload,
    actual_scope_count,
    actual_observation_count,
    actual_listing_version_count,
    actual_edge_count,
    parsed_committed_at
  )
  ON CONFLICT (run_id) DO NOTHING
  RETURNING id
  INTO committed_manifest_id;
  IF committed_manifest_id IS NULL THEN
    SELECT id, manifest_hash, manifest_payload, committed_at
    INTO committed_manifest_id, committed_manifest_hash, committed_manifest_payload, committed_manifest_at
    FROM job_search.ingest_commit_manifests
    WHERE run_id = requested_run_id;

    IF committed_manifest_hash IS DISTINCT FROM requested_manifest_hash
       OR committed_manifest_payload IS DISTINCT FROM requested_manifest_payload
       OR committed_manifest_at IS DISTINCT FROM parsed_committed_at THEN
      RAISE EXCEPTION 'ingest run % has a conflicting commit manifest', requested_run_id
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;

  UPDATE job_search.ingest_runs
  SET status = 'committed',
      committed_at = parsed_committed_at
  WHERE id = requested_run_id;

  RETURN committed_manifest_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION
  job_search.commit_ingest_run(bigint, text, jsonb, text)
  FROM PUBLIC;

REVOKE INSERT, UPDATE, DELETE, TRUNCATE
  ON job_search.ingest_commit_manifests
  FROM PUBLIC;

REVOKE INSERT (created_at) ON job_search.ingest_runs FROM PUBLIC;
REVOKE INSERT (created_at) ON job_search.ingest_observations FROM PUBLIC;
REVOKE INSERT (created_at) ON job_search.ingest_listing_versions FROM PUBLIC;
REVOKE INSERT (created_at) ON job_search.ingest_observation_versions FROM PUBLIC;

DO $privileges$
DECLARE
  ambient_role text;
BEGIN
  FOR ambient_role IN
    SELECT rolname
    FROM pg_catalog.pg_roles
    WHERE rolname IN ('anon', 'authenticated', 'service_role')
  LOOP
    EXECUTE pg_catalog.format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON job_search.ingest_commit_manifests FROM %I',
      ambient_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE EXECUTE ON FUNCTION job_search.commit_ingest_run(bigint, text, jsonb, text) FROM %I',
      ambient_role
    );
    EXECUTE pg_catalog.format(
      'REVOKE INSERT (created_at) ON job_search.ingest_runs, job_search.ingest_observations, job_search.ingest_listing_versions, job_search.ingest_observation_versions FROM %I',
      ambient_role
    );
  END LOOP;
END;
$privileges$;

CREATE TRIGGER ingest_runs_guard_insert
BEFORE INSERT ON job_search.ingest_runs
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_run_insert();

CREATE TRIGGER ingest_runs_guard_transition
BEFORE UPDATE ON job_search.ingest_runs
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_run_transition();

CREATE TRIGGER ingest_runs_reject_delete
BEFORE DELETE ON job_search.ingest_runs
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_ledger_delete();

CREATE TRIGGER ingest_source_scopes_guard_insert
BEFORE INSERT ON job_search.ingest_source_scopes
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_source_scope_insert();

CREATE TRIGGER ingest_source_scopes_guard_transition
BEFORE UPDATE ON job_search.ingest_source_scopes
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_source_scope_transition();

CREATE TRIGGER ingest_source_scopes_reject_delete
BEFORE DELETE ON job_search.ingest_source_scopes
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_child_mutation();

CREATE TRIGGER ingest_observations_guard_insert
BEFORE INSERT ON job_search.ingest_observations
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_observation_insert();

CREATE TRIGGER ingest_observations_reject_mutation
BEFORE UPDATE OR DELETE ON job_search.ingest_observations
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_child_mutation();

CREATE TRIGGER ingest_listing_versions_guard_insert
BEFORE INSERT ON job_search.ingest_listing_versions
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_listing_version_insert();

CREATE TRIGGER ingest_listing_versions_reject_mutation
BEFORE UPDATE OR DELETE ON job_search.ingest_listing_versions
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_child_mutation();

CREATE TRIGGER ingest_observation_versions_guard_insert
BEFORE INSERT ON job_search.ingest_observation_versions
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_observation_version_insert();

CREATE TRIGGER ingest_observation_versions_reject_mutation
BEFORE UPDATE OR DELETE ON job_search.ingest_observation_versions
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_child_mutation();

CREATE TRIGGER ingest_commit_manifests_guard_insert
BEFORE INSERT ON job_search.ingest_commit_manifests
FOR EACH ROW EXECUTE FUNCTION job_search.guard_ingest_commit_manifest_insert();

CREATE TRIGGER ingest_commit_manifests_reject_mutation
BEFORE UPDATE OR DELETE ON job_search.ingest_commit_manifests
FOR EACH ROW EXECUTE FUNCTION job_search.reject_ingest_ledger_mutation();

CREATE INDEX IF NOT EXISTS ingest_source_scopes_run_status_idx
  ON job_search.ingest_source_scopes(run_id, status);

CREATE INDEX IF NOT EXISTS ingest_observations_scope_idx
  ON job_search.ingest_observations(scope_id);

CREATE INDEX IF NOT EXISTS ingest_listing_versions_listing_key_idx
  ON job_search.ingest_listing_versions(listing_key);

CREATE INDEX IF NOT EXISTS ingest_listing_versions_created_by_scope_idx
  ON job_search.ingest_listing_versions(created_by_scope_id);

CREATE INDEX IF NOT EXISTS ingest_observation_versions_listing_version_idx
  ON job_search.ingest_observation_versions(listing_version_id);
