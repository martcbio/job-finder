"""Modal shadow arm for the lab-openings scanner."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import time
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

try:
    import modal
except ModuleNotFoundError:  # Pure row-shaping tests do not require the Modal SDK.
    modal = None  # type: ignore[assignment]


APP_NAME = "jobsradar"
TASK_NAME = "jobsradar"
SUBSTRATE = "modal"
CADENCE_SECONDS = 10_800
REPO_SOURCE = Path(__file__).resolve().parents[1]
REPO_ROOT = Path("/opt/jobsradar")
TARGETS_PATH = REPO_ROOT / "cloud" / "targets.json"
SCAN_TIMEOUT_SECONDS = 1_650
PARITY_CONFLICT_COLUMNS = "run_date,substrate,run_id"
PUBLICATION_BATCH_SIZE = 200
PUBLICATION_MAX_ATTEMPTS = 3
PUBLICATION_RETRY_SECONDS = 1.0
TARGETS_FALLBACK_PREFIX = "careers.targets fallback:"
BOARD_STATUS_SOURCE_FIELDS = (
    "org",
    "company",
    "ats",
    "status",
    "totalOpenings",
    "error",
)


def _ignore_repo_path(path: Path) -> bool:
    """Exclude local state, credentials, VCS data, caches, and large non-runtime trees."""
    try:
        relative = path.relative_to(REPO_SOURCE)
    except ValueError:
        relative = path
    parts = relative.parts
    if not parts:
        return False
    excluded = {
        ".agents",
        ".claude",
        ".codex",
        ".git",
        "artifacts",
        "data",
        "logs",
        "node_modules",
        "prototypes",
    }
    if any(part in excluded for part in parts):
        return True
    cache_dirs = {"__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache"}
    if any(part in cache_dirs for part in parts):
        return True
    name = path.name
    return name == ".DS_Store" or name == ".env" or name.startswith(".env.")


def _required_string(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str) or not item:
        raise ValueError(f"{key} must be a non-empty string")
    return item


def _optional_string(value: dict[str, Any], key: str) -> str | None:
    item = value.get(key)
    if item is not None and not isinstance(item, str):
        raise ValueError(f"{key} must be a string or null")
    return item


def _string(value: dict[str, Any], key: str) -> str:
    item = value.get(key)
    if not isinstance(item, str):
        raise ValueError(f"{key} must be a string")
    return item


def _non_negative_integer(value: dict[str, Any], key: str) -> int:
    item = value.get(key)
    if isinstance(item, bool) or not isinstance(item, int) or item < 0:
        raise ValueError(f"{key} must be a non-negative integer")
    return item


def _parse_jsonl(content: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(content.splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"openings JSONL line {line_number} must be an object")
        rows.append(value)
    return rows


def ids_sha256(jsonl_content: str) -> str:
    """Hash LC_ALL=C-sorted org:ats:id triples joined by LF, without a trailing LF."""
    triples = [
        ":".join(
            (
                _required_string(opening, "org"),
                _required_string(opening, "ats"),
                _required_string(opening, "id"),
            )
        )
        for opening in _parse_jsonl(jsonl_content)
    ]
    triples.sort(key=lambda item: item.encode("utf-8"))
    return hashlib.sha256("\n".join(triples).encode("utf-8")).hexdigest()


def targets_sha256(targets: dict[str, Any]) -> str:
    """Hash sorted org:ats:company triples without a trailing LF."""
    triples = [
        ":".join(
            (
                org,
                _required_string(target, "ats"),
                _required_string(target, "company"),
            )
        )
        for org, target in targets.items()
        if isinstance(target, dict)
    ]
    if len(triples) != len(targets):
        raise ValueError("target entries must be objects")
    triples.sort(key=lambda item: item.encode("utf-8"))
    return hashlib.sha256("\n".join(triples).encode("utf-8")).hexdigest()


def _neutral_board_status(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list):
        raise ValueError("runs must be an array")
    neutral: list[dict[str, Any]] = []
    for index, item in enumerate(value):
        if not isinstance(item, dict):
            raise ValueError(f"runs item {index} must be an object")
        neutral.append(
            {
                key: item[key]
                for key in BOARD_STATUS_SOURCE_FIELDS
                if key in item
            }
        )
    return neutral


def shape_rows(
    status: dict[str, Any],
    jsonl_content: str,
    *,
    substrate: str = SUBSTRATE,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """Shape scanner artifacts into careers.openings_runs/openings rows."""
    run_id = _required_string(status, "runId")
    completed_at = _required_string(status, "completedAt")
    health = _required_string(status, "health")
    if health not in {"complete", "degraded", "failed"}:
        raise ValueError(f"unsupported scanner health: {health}")
    raw_count = _non_negative_integer(status, "rawOpenings")
    board_status = _neutral_board_status(status.get("runs"))
    diagnostics = status.get("diagnostics")
    if not isinstance(diagnostics, list) or not all(isinstance(item, str) for item in diagnostics):
        raise ValueError("diagnostics must be an array of strings")

    run_row = {
        "run_id": run_id,
        "run_date": _required_string(status, "date"),
        "scheduled_at": _required_string(status, "scheduledAt"),
        "started_at": _required_string(status, "startedAt"),
        "completed_at": completed_at,
        "health": health,
        "raw_openings_count": raw_count,
        "board_status": board_status,
        "diagnostics": diagnostics,
        "substrate": substrate,
    }

    opening_rows: list[dict[str, Any]] = []
    for opening in _parse_jsonl(jsonl_content):
        locations = opening.get("locations")
        if not isinstance(locations, list) or not all(isinstance(item, str) for item in locations):
            raise ValueError("opening locations must be an array of strings")
        title = _optional_string(opening, "title")
        posted_at = _optional_string(opening, "postedAt")
        opening_rows.append(
            {
                "org": _required_string(opening, "org"),
                "ats": _required_string(opening, "ats"),
                "external_id": _required_string(opening, "id"),
                "title": title,
                "company": _required_string(opening, "company"),
                "location": _string(opening, "location"),
                "locations": locations,
                "url": _required_string(opening, "url"),
                "posted_at": posted_at,
                "raw": opening.get("raw"),
                "first_seen_run_id": run_id,
                "first_seen_at": completed_at,
                "last_seen_run_id": run_id,
                "last_seen_at": completed_at,
            }
        )
    if health == "complete" and len(opening_rows) != raw_count:
        raise ValueError(
            f"complete run reported {raw_count} raw openings but JSONL contained {len(opening_rows)}"
        )
    return run_row, opening_rows


def _load_artifacts(market_dir: Path) -> tuple[dict[str, Any], str]:
    status_paths = sorted(market_dir.glob("openings-*.status.json"))
    if len(status_paths) != 1:
        raise FileNotFoundError(f"expected one scanner status artifact, found {len(status_paths)}")
    status_path = status_paths[0]
    status = json.loads(status_path.read_text(encoding="utf-8"))
    if not isinstance(status, dict):
        raise ValueError("scanner status artifact must contain an object")
    jsonl_path = status_path.with_name(status_path.name.replace(".status.json", ".jsonl"))
    if not jsonl_path.is_file():
        run_id = _required_string(status, "runId")
        jsonl_path = market_dir / "lab-openings" / "runs" / run_id / "openings.jsonl"
    jsonl_content = jsonl_path.read_text(encoding="utf-8") if jsonl_path.is_file() else ""
    return status, jsonl_content


def _fallback_status(
    *,
    scheduled_at: str,
    started_at: str,
    completed_at: str,
    exit_status: int,
    diagnostic: str,
) -> dict[str, Any]:
    digest = hashlib.sha256(f"{scheduled_at}:{started_at}".encode()).hexdigest()[:20]
    return {
        "date": completed_at[:10],
        "runId": f"modal-wrapper-{digest}",
        "scheduledAt": scheduled_at,
        "startedAt": started_at,
        "completedAt": completed_at,
        "health": "failed",
        "rawOpenings": 0,
        "runs": [],
        "diagnostics": [diagnostic, f"scanner exit status: {exit_status}"],
    }


def _supabase_config() -> tuple[str, dict[str, str]]:
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_KEY")
    missing = [
        name
        for name, value in (("SUPABASE_URL", url), ("SUPABASE_SERVICE_KEY", key))
        if not value
    ]
    if missing:
        raise RuntimeError(f"missing required environment variable(s): {', '.join(missing)}")
    assert url is not None and key is not None
    return url.rstrip("/"), {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }


def _expect_one(response: httpx.Response, operation: str) -> dict[str, Any]:
    response.raise_for_status()
    data = response.json()
    if not isinstance(data, list) or len(data) != 1 or not isinstance(data[0], dict):
        raise RuntimeError(f"{operation} did not return exactly one row")
    return data[0]


def _register_task(client: httpx.Client, base_url: str) -> None:
    """Idempotent nicety; shared-table schema drift must never kill the scan."""
    try:
        _register_task_strict(client, base_url)
    except httpx.HTTPStatusError as error:
        print(f"task registration skipped: HTTP {error.response.status_code}")


def _register_task_strict(client: httpx.Client, base_url: str) -> None:
    response = client.post(
        f"{base_url}/rest/v1/tasks",
        params={"on_conflict": "task,substrate"},
        headers={"Prefer": "resolution=merge-duplicates,return=representation"},
        json={
            "task": TASK_NAME,
            "substrate": SUBSTRATE,
            "cadence_seconds": CADENCE_SECONDS,
            "note": "Modal cloud shadow for the lab-openings scanner",
        },
    )
    _expect_one(response, "control-plane task registration")


def _start_beacon(client: httpx.Client, base_url: str, started_at: str) -> str:
    response = client.post(
        f"{base_url}/rest/v1/runs",
        headers={"Prefer": "return=representation"},
        json={
            "task": TASK_NAME,
            "substrate": SUBSTRATE,
            "scheduled_at": started_at,
            "started_at": started_at,
        },
    )
    row = _expect_one(response, "control-plane run start")
    run_id = row.get("id")
    if not run_id:
        raise RuntimeError("control-plane run start returned no id")
    return str(run_id)


def _heartbeat(client: httpx.Client, base_url: str) -> None:
    response = client.post(
        f"{base_url}/rest/v1/heartbeats",
        headers={"Prefer": "return=representation"},
        json={
            "task": TASK_NAME,
            "substrate": SUBSTRATE,
            "meta": {"notes": "scanner-running"},
        },
    )
    _expect_one(response, "control-plane heartbeat")


def _finish_beacon(
    client: httpx.Client,
    base_url: str,
    *,
    run_id: str,
    exit_status: int,
    notes: dict[str, Any],
) -> None:
    response = client.patch(
        f"{base_url}/rest/v1/runs",
        params={"id": f"eq.{run_id}"},
        headers={"Prefer": "return=representation"},
        json={
            "finished_at": datetime.now(UTC).isoformat(),
            "exit_status": exit_status,
            "notes": json.dumps(notes, sort_keys=True),
        },
    )
    _expect_one(response, "control-plane run finish")


def _write_runtime_targets(client: httpx.Client, base_url: str, market_dir: Path) -> str | None:
    try:
        baked_targets = json.loads(TARGETS_PATH.read_text(encoding="utf-8"))
        if not isinstance(baked_targets, dict):
            raise ValueError("baked targets config must contain an object")
        response = client.get(
            f"{base_url}/rest/v1/targets",
            params={"active": "eq.true", "select": "org,ats,company", "order": "org.asc"},
            headers={"Accept-Profile": "careers"},
        )
        response.raise_for_status()
        rows = response.json()
        if not isinstance(rows, list) or not rows:
            raise ValueError("careers.targets returned no active rows")
        targets: dict[str, dict[str, str | None]] = {}
        filled_ats: list[str] = []
        for row in rows:
            if not isinstance(row, dict):
                raise ValueError("careers.targets returned a non-object row")
            org = _required_string(row, "org")
            ats = _optional_string(row, "ats")
            company = _required_string(row, "company")
            if ats is None:
                baked_target = baked_targets.get(org)
                baked_ats = (
                    baked_target.get("ats")
                    if isinstance(baked_target, dict)
                    else None
                )
                if not isinstance(baked_ats, str) or not baked_ats:
                    raise ValueError(
                        f"careers.targets has no ATS and baked config has no mapping: {org}"
                    )
                ats = baked_ats
                filled_ats.append(f"{org}={ats}")
            targets[org] = {"ats": ats, "company": company}
        (market_dir / "targets.json").write_text(
            f"{json.dumps(targets, indent=2, sort_keys=True)}\n",
            encoding="utf-8",
        )
        return (
            "careers.targets filled ATS from baked config: " + ", ".join(filled_ats)
            if filled_ats
            else None
        )
    except Exception as error:
        shutil.copyfile(TARGETS_PATH, market_dir / "targets.json")
        return f"{TARGETS_FALLBACK_PREFIX} {type(error).__name__}: {error}"


def _apply_targets_diagnostic(
    run_row: dict[str, Any],
    targets_diagnostic: str | None,
) -> dict[str, Any]:
    """Preserve target-source degradation in persisted run health and diagnostics."""
    if targets_diagnostic is None:
        return run_row
    updated = {**run_row, "diagnostics": [*run_row["diagnostics"], targets_diagnostic]}
    if targets_diagnostic.startswith(TARGETS_FALLBACK_PREFIX) and updated["health"] == "complete":
        updated["health"] = "degraded"
    return updated


def _effective_exit_status(scanner_exit_status: int, health: str) -> int:
    if scanner_exit_status != 0:
        return scanner_exit_status
    return 0 if health == "complete" else 1


def _rpc_result(response: httpx.Response, operation: str) -> dict[str, Any]:
    response.raise_for_status()
    data = response.json()
    if isinstance(data, dict):
        return data
    if isinstance(data, list) and len(data) == 1 and isinstance(data[0], dict):
        return data[0]
    raise RuntimeError(f"{operation} did not return one result object")


def _post_publication_rpc(
    client: httpx.Client,
    base_url: str,
    function_name: str,
    payload: dict[str, Any],
) -> dict[str, Any]:
    response = client.post(
        f"{base_url}/rest/v1/rpc/{function_name}",
        headers={
            "Accept-Profile": "careers",
            "Content-Profile": "careers",
        },
        json=payload,
    )
    return _rpc_result(response, f"careers {function_name}")


def _parity_row(
    status: dict[str, Any],
    jsonl_content: str,
    targets: dict[str, Any],
) -> dict[str, Any]:
    return {
        "run_date": _required_string(status, "date"),
        "substrate": SUBSTRATE,
        "run_id": _required_string(status, "runId"),
        "openings_count": len(_parse_jsonl(jsonl_content)),
        "ids_sha256": ids_sha256(jsonl_content),
        "targets_sha256": targets_sha256(targets),
    }


def _persist_run_only(
    client: httpx.Client,
    base_url: str,
    run_row: dict[str, Any],
) -> dict[str, Any]:
    if run_row.get("health") not in {"degraded", "failed"}:
        raise ValueError("run-only publication requires degraded or failed health")
    result = _post_publication_rpc(
        client,
        base_url,
        "persist_openings_run_only",
        {"p_run": run_row},
    )
    if result.get("run_id") != run_row.get("run_id"):
        raise RuntimeError("run-only publication returned the wrong run_id")
    if result.get("health") != run_row.get("health"):
        raise RuntimeError("run-only publication returned the wrong health")
    if result.get("persisted_openings") != 0 or result.get("parity_openings_count") is not None:
        raise RuntimeError("run-only publication unexpectedly reported openings or parity")
    return result


def _validate_complete_receipt(
    result: dict[str, Any],
    *,
    run_id: Any,
    expected: int,
) -> dict[str, Any]:
    if result.get("run_id") != run_id:
        raise RuntimeError("complete publication returned the wrong run_id")
    if result.get("health") != "complete":
        raise RuntimeError("complete publication did not return complete health")
    for key in ("expected_openings", "persisted_openings", "parity_openings_count"):
        if result.get(key) != expected:
            raise RuntimeError(
                f"complete publication returned invalid {key}: {result.get(key)!r}"
            )
    return result


def _verify_complete_publication(
    client: httpx.Client,
    base_url: str,
    *,
    run_id: str,
    ids_digest: str,
    expected: int,
) -> dict[str, Any] | None:
    result = _post_publication_rpc(
        client,
        base_url,
        "verify_openings_publication",
        {
            "p_run_id": run_id,
            "p_ids_sha256": ids_digest,
        },
    )
    if result.get("published") is not True:
        return None
    return _validate_complete_receipt(result, run_id=run_id, expected=expected)


def _publish_complete_run(
    client: httpx.Client,
    base_url: str,
    run_row: dict[str, Any],
    opening_rows: list[dict[str, Any]],
    parity_row: dict[str, Any],
) -> dict[str, Any]:
    if run_row.get("health") != "complete":
        raise ValueError("complete publication requires complete health")
    expected = run_row.get("raw_openings_count")
    if isinstance(expected, bool) or not isinstance(expected, int) or expected < 0:
        raise ValueError("complete publication requires a non-negative raw opening count")
    if len(opening_rows) != expected:
        raise ValueError(
            f"complete publication expected {expected} openings but received {len(opening_rows)}"
        )
    if parity_row.get("openings_count") != expected:
        raise ValueError("parity opening count must equal the complete run raw opening count")
    if parity_row.get("run_id") != run_row.get("run_id"):
        raise ValueError("parity run_id must equal the complete run_id")
    parity_digest = parity_row.get("ids_sha256")
    if not isinstance(parity_digest, str) or not parity_digest:
        raise ValueError("parity ids_sha256 must be a non-empty string")
    run_id = run_row.get("run_id")
    if not isinstance(run_id, str) or not run_id:
        raise ValueError("complete publication requires a non-empty run_id")

    batches = [
        opening_rows[index : index + PUBLICATION_BATCH_SIZE]
        for index in range(0, len(opening_rows), PUBLICATION_BATCH_SIZE)
    ]
    last_error: Exception | None = None
    last_error_detail = ""
    for attempt in range(1, PUBLICATION_MAX_ATTEMPTS + 1):
        publication_id = str(uuid.uuid4())
        finalize_started = False
        try:
            _post_publication_rpc(
                client,
                base_url,
                "begin_openings_publication",
                {
                    "p_publication_id": publication_id,
                    "p_run": run_row,
                    "p_parity": parity_row,
                },
            )
            for batch in batches:
                _post_publication_rpc(
                    client,
                    base_url,
                    "stage_openings_publication",
                    {
                        "p_publication_id": publication_id,
                        "p_openings": batch,
                    },
                )
            finalize_started = True
            result = _post_publication_rpc(
                client,
                base_url,
                "finalize_openings_publication",
                {"p_publication_id": publication_id},
            )
            return _validate_complete_receipt(
                result,
                run_id=run_id,
                expected=expected,
            )
        except httpx.HTTPStatusError as error:
            last_error = error
            body = error.response.text.strip().replace("\n", " ")[:1_000]
            last_error_detail = f"HTTP {error.response.status_code}: {body}"
            retryable = (
                error.response.status_code in {408, 425, 429}
                or error.response.status_code >= 500
            )
            if not retryable:
                raise RuntimeError(
                    f"complete publication failed: HTTP {error.response.status_code}: {body}"
                ) from error
        except (httpx.TransportError, json.JSONDecodeError, RuntimeError) as error:
            last_error = error
            last_error_detail = f"{type(error).__name__}: {error}"

        if finalize_started:
            try:
                verified = _verify_complete_publication(
                    client,
                    base_url,
                    run_id=run_id,
                    ids_digest=parity_digest,
                    expected=expected,
                )
            except (httpx.HTTPError, json.JSONDecodeError, RuntimeError) as verify_error:
                last_error_detail = (
                    f"{last_error_detail}; verification failed: "
                    f"{type(verify_error).__name__}: {verify_error}"
                )
            else:
                if verified is not None:
                    return verified

        if attempt == PUBLICATION_MAX_ATTEMPTS:
            break
        print(
            f"complete publication attempt {attempt}/{PUBLICATION_MAX_ATTEMPTS} failed; "
            "retrying the whole staged publication"
        )
        time.sleep(PUBLICATION_RETRY_SECONDS * attempt)

    assert last_error is not None
    raise RuntimeError(
        f"complete publication failed after {PUBLICATION_MAX_ATTEMPTS} whole attempts: "
        f"{last_error_detail}"
    ) from last_error


def _run_scanner(
    client: httpx.Client,
    base_url: str,
    *,
    market_dir: Path,
    scheduled_at: str,
) -> int:
    environment = os.environ.copy()
    environment["CAREERS_MARKET_DIR"] = str(market_dir)
    environment["CAREERS_PROJECT_DIR"] = str(REPO_ROOT)
    process = subprocess.Popen(
        ["bun", "run", "labs:openings", "--", "record", "--scheduled-at", scheduled_at],
        cwd=REPO_ROOT,
        env=environment,
    )
    deadline = time.monotonic() + SCAN_TIMEOUT_SECONDS
    try:
        _heartbeat(client, base_url)
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                process.kill()
                process.communicate()
                return 124
            try:
                process.communicate(timeout=min(60, remaining))
                return process.returncode
            except subprocess.TimeoutExpired:
                _heartbeat(client, base_url)
    except Exception:
        process.kill()
        process.communicate()
        raise


def _execute_once() -> dict[str, Any]:
    started_at = datetime.now(UTC).isoformat()
    scheduled_at = started_at
    base_url, headers = _supabase_config()
    with httpx.Client(headers=headers, timeout=30.0) as client:
        _register_task(client, base_url)
        beacon_run_id = _start_beacon(client, base_url, started_at)
        scanner_exit_status = 1
        effective_exit_status = 1
        notes: dict[str, Any] = {"scanner_exit_status": scanner_exit_status}
        caught: Exception | None = None
        targets_diagnostic: str | None = None

        try:
            with tempfile.TemporaryDirectory(prefix="jobsradar-") as temp_dir:
                market_dir = Path(temp_dir)
                targets_diagnostic = _write_runtime_targets(client, base_url, market_dir)
                try:
                    scanner_exit_status = _run_scanner(
                        client,
                        base_url,
                        market_dir=market_dir,
                        scheduled_at=scheduled_at,
                    )
                except OSError as error:
                    scanner_exit_status = 127
                    caught = error

                completed_at = datetime.now(UTC).isoformat()
                try:
                    status, jsonl_content = _load_artifacts(market_dir)
                except (FileNotFoundError, json.JSONDecodeError, ValueError) as error:
                    if caught is None:
                        caught = error
                    status = _fallback_status(
                        scheduled_at=scheduled_at,
                        started_at=started_at,
                        completed_at=completed_at,
                        exit_status=scanner_exit_status,
                        diagnostic=f"scanner artifact unavailable: {type(error).__name__}",
                    )
                    jsonl_content = ""

                run_row, opening_rows = shape_rows(status, jsonl_content)
                run_row = _apply_targets_diagnostic(run_row, targets_diagnostic)
                if scanner_exit_status != 0 and run_row["health"] == "complete":
                    run_row = {
                        **run_row,
                        "health": "failed",
                        "diagnostics": [
                            *run_row["diagnostics"],
                            f"scanner exited nonzero: {scanner_exit_status}",
                        ],
                    }
                parity_status = "skipped_degraded"
                if run_row["health"] == "complete" and scanner_exit_status == 0:
                    runtime_targets = json.loads(
                        (market_dir / "targets.json").read_text(encoding="utf-8")
                    )
                    if not isinstance(runtime_targets, dict):
                        raise ValueError("runtime targets must contain an object")
                    parity_row = _parity_row(
                        status,
                        jsonl_content,
                        runtime_targets,
                    )
                    _publish_complete_run(
                        client,
                        base_url,
                        run_row,
                        opening_rows,
                        parity_row,
                    )
                    parity_status = "published_atomically"
                else:
                    _persist_run_only(client, base_url, run_row)
                effective_exit_status = _effective_exit_status(
                    scanner_exit_status, run_row["health"]
                )
                notes = {
                    "scanner_exit_status": scanner_exit_status,
                    "health": run_row["health"],
                    "raw_openings_count": run_row["raw_openings_count"],
                    "persisted_openings": (
                        len(opening_rows) if run_row["health"] == "complete" else 0
                    ),
                    "parity_status": parity_status,
                }
                if targets_diagnostic is not None:
                    notes["targets_diagnostic"] = targets_diagnostic
        except Exception as error:
            caught = caught or error
            effective_exit_status = scanner_exit_status if scanner_exit_status != 0 else 1
            notes = {
                "scanner_exit_status": scanner_exit_status,
                "wrapper_error": type(error).__name__,
            }
            if targets_diagnostic is not None:
                notes["targets_diagnostic"] = targets_diagnostic
            failure_status = _fallback_status(
                scheduled_at=scheduled_at,
                started_at=started_at,
                completed_at=datetime.now(UTC).isoformat(),
                exit_status=effective_exit_status,
                diagnostic=f"shadow wrapper failed: {type(error).__name__}",
            )
            try:
                failure_row, _ = shape_rows(failure_status, "")
                _persist_run_only(client, base_url, failure_row)
            except Exception:
                # The original exception remains authoritative; this best-effort write
                # cannot succeed when PostgREST itself is the failing boundary.
                pass
        finally:
            _finish_beacon(
                client,
                base_url,
                run_id=beacon_run_id,
                exit_status=effective_exit_status,
                notes=notes,
            )

        if caught is not None:
            raise RuntimeError(f"lab-openings shadow failed: {type(caught).__name__}") from caught
        if effective_exit_status != 0:
            raise RuntimeError(f"lab-openings scanner exited {effective_exit_status}")
        summary = {
            "run_id": run_row["run_id"],
            "health": run_row["health"],
            "raw_openings_count": run_row["raw_openings_count"],
            "persisted_openings": len(opening_rows),
            "scanner_exit_status": scanner_exit_status,
        }
        print(json.dumps(summary, sort_keys=True))
        return summary


if modal is not None:
    app = modal.App(APP_NAME)
    image = (
        modal.Image.debian_slim(python_version="3.12")
        .apt_install("ca-certificates", "curl", "unzip")
        .pip_install("httpx")
        # copy=True bakes a normal writable image layer instead of a live host mount.
        .add_local_dir(
            str(REPO_SOURCE),
            remote_path=str(REPO_ROOT),
            copy=True,
            ignore=_ignore_repo_path,
        )
        .run_commands(
            "curl -fsSL https://bun.sh/install | bash",
            "ln -sf /root/.bun/bin/bun /usr/local/bin/bun",
            # --ignore-scripts: the repo's prepare script (lefthook install) needs git,
            # which the slim image lacks; commit hooks have no role in the container.
            f"cd {REPO_ROOT} && bun install --frozen-lockfile --ignore-scripts",
        )
    )

    @app.function(
        image=image,
        secrets=[modal.Secret.from_name("control-plane")],
        schedule=modal.Cron("0 */3 * * *"),
        timeout=1_800,
    )
    def run_once() -> dict[str, Any]:
        """Run one complete shadow scan; also callable with modal run ::run_once."""
        return _execute_once()
