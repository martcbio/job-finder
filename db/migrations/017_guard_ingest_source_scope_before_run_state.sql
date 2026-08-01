-- Preserve the immutable 016 ledger schema while making scope-contract errors
-- deterministic even when a parent run has already moved out of collecting.
CREATE OR REPLACE FUNCTION job_search.guard_ingest_source_scope_insert()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  run_status text;
  run_contract_version integer;
  run_scope_plan jsonb;
  expected_identity jsonb;
  expected_hash text;
BEGIN
  SELECT status, contract_version, scope_plan
  INTO run_status, run_contract_version, run_scope_plan
  FROM job_search.ingest_runs
  WHERE id = NEW.run_id
  FOR UPDATE;

  IF run_status IS NULL THEN
    RAISE EXCEPTION 'ingest run % does not exist', NEW.run_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;
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
  IF run_status <> 'collecting' THEN
    RAISE EXCEPTION 'ingest run % is %, not collecting', NEW.run_id, run_status
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;
