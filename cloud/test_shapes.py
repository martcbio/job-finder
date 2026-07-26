#!/usr/bin/env python3
"""Pure self-checks for the Modal shadow row shaping."""

from __future__ import annotations

import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

import httpx

from modal_app import (
    PARITY_CONFLICT_COLUMNS,
    _apply_targets_diagnostic,
    _upsert_scan_rows,
    _write_runtime_targets,
    ids_sha256,
    shape_rows,
    targets_sha256,
)


STATUS = {
    "date": "2026-07-15",
    "runId": "scanner-run-1",
    "scheduledAt": "2026-07-15T09:00:00.000Z",
    "startedAt": "2026-07-15T09:00:01.000Z",
    "completedAt": "2026-07-15T09:00:08.000Z",
    "health": "degraded",
    "openings": 1,
    "rawOpenings": 1,
    "eligibleOpenings": 1,
    "suitableOpenings": 1,
    "unsuitableLocationOpenings": 0,
    "unsuitableRoleOpenings": 0,
    "undecidedOpenings": 0,
    "runs": [{"org": "openai", "ats": "ashby", "status": "hit"}],
    "diagnostics": ["One board failed"],
}

JSONL = """{"org":"openai","company":"OpenAI","ats":"ashby","id":"job-1","title":"Research Engineer","location":"London","locations":["London","Remote"],"url":"https://example.test/job-1","postedAt":"2026-07-14T12:00:00Z","locationEligibility":{"status":"eligible","reasonCodes":["location.europe_or_uk"]},"roleRelevance":{"status":"relevant","reasonCodes":["role.technical"]},"disposition":"suitable","raw":{"id":"job-1"}}
"""


class ShapeRowsTest(unittest.TestCase):
    def test_shapes_run_and_opening_rows(self) -> None:
        run, openings = shape_rows(STATUS, JSONL)

        self.assertEqual(
            run,
            {
                "run_id": "scanner-run-1",
                "run_date": "2026-07-15",
                "scheduled_at": "2026-07-15T09:00:00.000Z",
                "started_at": "2026-07-15T09:00:01.000Z",
                "completed_at": "2026-07-15T09:00:08.000Z",
                "health": "degraded",
                "matched_openings_count": 1,
                "raw_openings_count": 1,
                "eligible_openings_count": 1,
                "suitable_openings_count": 1,
                "unsuitable_location_openings_count": 0,
                "unsuitable_role_openings_count": 0,
                "undecided_openings_count": 0,
                "board_status": [{"org": "openai", "ats": "ashby", "status": "hit"}],
                "diagnostics": ["One board failed"],
                "substrate": "modal",
            },
        )
        self.assertEqual(
            openings,
            [
                {
                    "org": "openai",
                    "ats": "ashby",
                    "external_id": "job-1",
                    "title": "Research Engineer",
                    "company": "OpenAI",
                    "location": "London",
                    "locations": ["London", "Remote"],
                    "url": "https://example.test/job-1",
                    "posted_at": "2026-07-14T12:00:00Z",
                    "location_eligibility": "eligible",
                    "location_reason_codes": ["location.europe_or_uk"],
                    "role_relevance": "relevant",
                    "role_reason_codes": ["role.technical"],
                    "disposition": "suitable",
                    "raw": {"id": "job-1"},
                    "first_seen_run_id": "scanner-run-1",
                    "first_seen_at": "2026-07-15T09:00:08.000Z",
                    "last_seen_run_id": "scanner-run-1",
                    "last_seen_at": "2026-07-15T09:00:08.000Z",
                }
            ],
        )

    def test_failed_run_can_have_no_openings_artifact(self) -> None:
        failed = {
            **STATUS,
            "health": "failed",
            "openings": 0,
            "rawOpenings": 0,
            "eligibleOpenings": 0,
            "suitableOpenings": 0,
            "unsuitableLocationOpenings": 0,
            "unsuitableRoleOpenings": 0,
            "undecidedOpenings": 0,
        }
        run, openings = shape_rows(failed, "")

        self.assertEqual(run["health"], "failed")
        self.assertEqual(openings, [])


class IdsSha256Test(unittest.TestCase):
    def test_matches_precomputed_fixture(self) -> None:
        jsonl = """{"org":"anthropic","ats":"greenhouse","id":"job-2"}
{"org":"openai","ats":"ashby","id":"job-1"}
"""

        self.assertEqual(
            ids_sha256(jsonl),
            "f736a1dd2844e784abdce240a6e81838a5d00f78684c5003b486a33b15077d37",
        )

    def test_is_independent_of_jsonl_order(self) -> None:
        forward = """{"org":"anthropic","ats":"greenhouse","id":"job-2"}
{"org":"openai","ats":"ashby","id":"job-1"}
"""
        reverse = """{"org":"openai","ats":"ashby","id":"job-1"}
{"org":"anthropic","ats":"greenhouse","id":"job-2"}
"""

        self.assertEqual(ids_sha256(forward), ids_sha256(reverse))

    def test_target_hash_is_independent_of_object_order(self) -> None:
        forward = {
            "openai": {"ats": "ashby", "company": "OpenAI"},
            "anthropic": {"ats": "greenhouse", "company": "Anthropic"},
        }
        reverse = dict(reversed(list(forward.items())))

        self.assertEqual(targets_sha256(forward), targets_sha256(reverse))


class ParityPersistenceTest(unittest.TestCase):
    def test_keeps_every_scanner_run(self) -> None:
        self.assertEqual(PARITY_CONFLICT_COLUMNS, "run_date,substrate,run_id")


class RuntimeTargetsTest(unittest.TestCase):
    def test_fills_missing_live_ats_values_from_baked_targets(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.assertTrue(request.url.path.endswith("/targets"))
            return httpx.Response(
                200,
                json=[
                    {"org": "cursor", "ats": None, "company": "Cursor / Anysphere"},
                    {"org": "anthropic", "ats": "greenhouse", "company": "Anthropic"},
                ],
            )

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            baked_targets = root / "baked-targets.json"
            baked_targets.write_text(
                '{"cursor":{"ats":"ashby","company":"Cursor / Anysphere"}}\n',
                encoding="utf-8",
            )
            with (
                httpx.Client(transport=httpx.MockTransport(handler)) as client,
                patch("modal_app.TARGETS_PATH", baked_targets),
            ):
                diagnostic = _write_runtime_targets(client, "https://example.test", root)

            written = __import__("json").loads((root / "targets.json").read_text())

        self.assertEqual(written["cursor"]["ats"], "ashby")
        self.assertEqual(written["anthropic"]["ats"], "greenhouse")
        self.assertEqual(diagnostic, "careers.targets filled ATS from baked config: cursor=ashby")

    def test_target_fallback_degrades_an_otherwise_complete_run(self) -> None:
        run = {**STATUS, "health": "complete", "diagnostics": []}

        updated = _apply_targets_diagnostic(
            run,
            "careers.targets fallback: HTTPStatusError: service unavailable",
        )

        self.assertEqual(updated["health"], "degraded")
        self.assertIn("careers.targets fallback", updated["diagnostics"][0])


class OpeningPersistenceTest(unittest.TestCase):
    def test_batches_openings_and_retries_transient_server_errors(self) -> None:
        opening_attempts: list[list[dict[str, object]]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/openings_runs"):
                return httpx.Response(201, json=[{"run_id": "run-1"}])
            payload = __import__("json").loads(request.content)
            opening_attempts.append(payload)
            if len(opening_attempts) == 1:
                return httpx.Response(500, text="temporary PostgREST failure")
            return httpx.Response(201)

        rows = [{"external_id": f"job-{index}"} for index in range(450)]
        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep") as sleep,
        ):
            _upsert_scan_rows(client, "https://example.test", {"run_id": "run-1"}, rows)

        self.assertEqual([len(batch) for batch in opening_attempts], [200, 200, 200, 50])
        sleep.assert_called_once()

    def test_reports_postgrest_response_body_after_retry_exhaustion(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/openings_runs"):
                return httpx.Response(201, json=[{"run_id": "run-1"}])
            return httpx.Response(500, text="database statement timed out")

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep"),
            self.assertRaisesRegex(
                RuntimeError,
                "opening batch 1/1 failed after 3 attempts.*database statement timed out",
            ),
        ):
            _upsert_scan_rows(
                client,
                "https://example.test",
                {"run_id": "run-1"},
                [{"external_id": "job-1"}],
            )


if __name__ == "__main__":
    unittest.main()
