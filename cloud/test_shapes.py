#!/usr/bin/env python3
"""Pure self-checks for the Modal shadow row shaping."""

from __future__ import annotations

import json
import unittest
from pathlib import Path
import tempfile
from unittest.mock import patch

import httpx

from modal_app import (
    PARITY_CONFLICT_COLUMNS,
    _apply_targets_diagnostic,
    _effective_exit_status,
    _persist_run_only,
    _publish_complete_run,
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
    "runs": [
        {
            "org": "openai",
            "company": "OpenAI",
            "ats": "ashby",
            "status": "hit",
            "totalOpenings": 1,
            "eligibleOpenings": 1,
            "suitableOpenings": 1,
            "matchedOpenings": 1,
        }
    ],
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
                "raw_openings_count": 1,
                "board_status": [
                    {
                        "org": "openai",
                        "company": "OpenAI",
                        "ats": "ashby",
                        "status": "hit",
                        "totalOpenings": 1,
                    }
                ],
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
                    "raw": {"id": "job-1"},
                    "first_seen_run_id": "scanner-run-1",
                    "first_seen_at": "2026-07-15T09:00:08.000Z",
                    "last_seen_run_id": "scanner-run-1",
                    "last_seen_at": "2026-07-15T09:00:08.000Z",
                }
            ],
        )

    def test_ignores_candidate_judgments_even_when_malformed(self) -> None:
        candidate_fields = {
            "locationEligibility": "profile-dependent",
            "roleRelevance": {"status": "relevant", "reasonCodes": "not-an-array"},
            "disposition": ["suitable"],
        }
        opening = {
            **json.loads(JSONL),
            **candidate_fields,
        }

        candidate_counts = {
            **STATUS,
            "openings": "profile-dependent",
            "eligibleOpenings": {"candidate": True},
            "suitableOpenings": None,
            "unsuitableLocationOpenings": ["candidate"],
            "unsuitableRoleOpenings": -1,
            "undecidedOpenings": "candidate-derived",
        }

        run, openings = shape_rows(candidate_counts, f"{json.dumps(opening)}\n")

        self.assertEqual(run["raw_openings_count"], 1)
        for key in (
            "matched_openings_count",
            "eligible_openings_count",
            "suitable_openings_count",
            "unsuitable_location_openings_count",
            "unsuitable_role_openings_count",
            "undecided_openings_count",
        ):
            self.assertNotIn(key, run)
        self.assertEqual(
            run["board_status"],
            [
                {
                    "org": "openai",
                    "company": "OpenAI",
                    "ats": "ashby",
                    "status": "hit",
                    "totalOpenings": 1,
                }
            ],
        )
        for key in (
            "location_eligibility",
            "location_reason_codes",
            "role_relevance",
            "role_reason_codes",
            "disposition",
        ):
            self.assertNotIn(key, openings[0])

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

    def test_target_hash_canonically_represents_a_null_ats(self) -> None:
        targets = {
            "cursor": {"ats": None, "company": "Cursor / Anysphere"},
            "anthropic": {"ats": "greenhouse", "company": "Anthropic"},
        }

        self.assertEqual(
            targets_sha256(targets),
            "c344ef949e7b5268a4dc322af671b8097d13eb4079df4f972c356c0f67ac2b77",
        )


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
            parity_targets = __import__("json").loads(
                (root / "targets.parity.json").read_text()
            )

        self.assertEqual(written["cursor"]["ats"], "ashby")
        self.assertEqual(written["anthropic"]["ats"], "greenhouse")
        self.assertIsNone(parity_targets["cursor"]["ats"])
        self.assertEqual(
            targets_sha256(parity_targets),
            "c344ef949e7b5268a4dc322af671b8097d13eb4079df4f972c356c0f67ac2b77",
        )
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
    def test_degraded_health_is_never_operational_success(self) -> None:
        self.assertEqual(_effective_exit_status(0, "complete"), 0)
        self.assertEqual(_effective_exit_status(0, "degraded"), 1)
        self.assertEqual(_effective_exit_status(0, "failed"), 1)
        self.assertEqual(_effective_exit_status(124, "complete"), 124)

    def test_degraded_run_persists_health_but_not_openings(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            return httpx.Response(
                200,
                json={
                    "run_id": "run-degraded",
                    "health": "degraded",
                    "persisted_openings": 0,
                    "parity_openings_count": None,
                },
            )

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = _persist_run_only(
                client,
                "https://example.test",
                {"run_id": "run-degraded", "health": "degraded"},
            )

        self.assertEqual(result["persisted_openings"], 0)
        self.assertEqual(len(requests), 1)
        self.assertTrue(
            requests[0].url.path.endswith("/rpc/persist_openings_run_only")
        )

    def test_complete_run_stages_bounded_batches_then_finalizes(self) -> None:
        requests: list[tuple[str, dict[str, object]]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            payload = json.loads(request.content)
            requests.append((request.url.path, payload))
            if request.url.path.endswith("/finalize_openings_publication"):
                return httpx.Response(
                    200,
                    json={
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 450,
                        "persisted_openings": 450,
                        "parity_openings_count": 450,
                    },
                )
            return httpx.Response(200, json={"ok": True})

        rows = [{"external_id": f"job-{index}"} for index in range(450)]
        run = {"run_id": "run-1", "health": "complete", "raw_openings_count": 450}
        parity = {
            "run_id": "run-1",
            "openings_count": 450,
            "ids_sha256": "fixture-digest",
        }
        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = _publish_complete_run(
                client,
                "https://example.test",
                run,
                rows,
                parity,
            )

        stage_payloads = [
            payload
            for path, payload in requests
            if path.endswith("/stage_openings_publication")
        ]
        self.assertEqual(
            [len(payload["p_openings"]) for payload in stage_payloads],
            [200, 200, 50],
        )
        self.assertTrue(requests[0][0].endswith("/begin_openings_publication"))
        self.assertTrue(requests[-1][0].endswith("/finalize_openings_publication"))
        self.assertEqual(
            {payload["p_publication_id"] for _, payload in requests},
            {requests[0][1]["p_publication_id"]},
        )
        self.assertEqual(result["persisted_openings"], 450)

    def test_transient_batch_failure_retries_the_whole_publication(self) -> None:
        requests: list[tuple[str, dict[str, object]]] = []
        failed_once = False

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal failed_once
            payload = json.loads(request.content)
            requests.append((request.url.path, payload))
            if request.url.path.endswith("/stage_openings_publication") and not failed_once:
                failed_once = True
                return httpx.Response(500, text="temporary PostgREST failure")
            if request.url.path.endswith("/finalize_openings_publication"):
                return httpx.Response(
                    200,
                    json={
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 1,
                        "persisted_openings": 1,
                        "parity_openings_count": 1,
                    },
                )
            return httpx.Response(200, json={"ok": True})

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep") as sleep,
        ):
            _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )

        begins = [
            payload
            for path, payload in requests
            if path.endswith("/begin_openings_publication")
        ]
        self.assertEqual(len(begins), 2)
        self.assertNotEqual(
            begins[0]["p_publication_id"],
            begins[1]["p_publication_id"],
        )
        sleep.assert_called_once()

    def test_ambiguous_408_finalize_is_verified_as_committed(self) -> None:
        requests: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request.url.path)
            if request.url.path.endswith("/finalize_openings_publication"):
                return httpx.Response(408, text="gateway timed out after commit")
            if request.url.path.endswith("/verify_openings_publication"):
                return httpx.Response(
                    200,
                    json={
                        "published": True,
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 1,
                        "persisted_openings": 1,
                        "parity_openings_count": 1,
                    },
                )
            return httpx.Response(200, json={"ok": True})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )

        self.assertTrue(result["published"])
        self.assertEqual(
            len([path for path in requests if path.endswith("/begin_openings_publication")]),
            1,
        )
        self.assertEqual(
            len([path for path in requests if path.endswith("/verify_openings_publication")]),
            1,
        )

    def test_malformed_finalize_receipt_is_verified_as_committed(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/finalize_openings_publication"):
                return httpx.Response(200, json={"unexpected": "receipt"})
            if request.url.path.endswith("/verify_openings_publication"):
                return httpx.Response(
                    200,
                    json={
                        "published": True,
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 1,
                        "persisted_openings": 1,
                        "parity_openings_count": 1,
                    },
                )
            return httpx.Response(200, json={"ok": True})

        with httpx.Client(transport=httpx.MockTransport(handler)) as client:
            result = _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )

        self.assertTrue(result["published"])

    def test_lost_finalize_response_retries_when_verification_is_negative(self) -> None:
        finalize_attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal finalize_attempts
            if request.url.path.endswith("/finalize_openings_publication"):
                finalize_attempts += 1
                if finalize_attempts == 1:
                    raise httpx.ReadTimeout("lost response", request=request)
                return httpx.Response(
                    200,
                    json={
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 1,
                        "persisted_openings": 1,
                        "parity_openings_count": 1,
                    },
                )
            if request.url.path.endswith("/verify_openings_publication"):
                return httpx.Response(200, json={"published": False})
            return httpx.Response(200, json={"ok": True})

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep"),
        ):
            result = _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )

        self.assertEqual(finalize_attempts, 2)
        self.assertEqual(result["persisted_openings"], 1)

    def test_prior_ambiguous_finalize_is_verified_after_later_begin_failure(self) -> None:
        begin_attempts = 0

        def handler(request: httpx.Request) -> httpx.Response:
            nonlocal begin_attempts
            if request.url.path.endswith("/begin_openings_publication"):
                begin_attempts += 1
                if begin_attempts == 2:
                    return httpx.Response(500, text="later begin failed")
            if request.url.path.endswith("/finalize_openings_publication"):
                raise httpx.ReadTimeout("lost committed response", request=request)
            if request.url.path.endswith("/verify_openings_publication"):
                if begin_attempts == 1:
                    return httpx.Response(200, json={"published": False})
                return httpx.Response(
                    200,
                    json={
                        "published": True,
                        "run_id": "run-1",
                        "health": "complete",
                        "expected_openings": 1,
                        "persisted_openings": 1,
                        "parity_openings_count": 1,
                    },
                )
            return httpx.Response(200, json={"ok": True})

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep"),
        ):
            result = _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )

        self.assertEqual(begin_attempts, 2)
        self.assertTrue(result["published"])

    def test_rejects_count_mismatch_before_publication(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            self.fail(f"unexpected request: {request.url}")

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            self.assertRaisesRegex(
                ValueError,
                "expected 2 openings but received 1",
            ),
        ):
            _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 2},
                [{"external_id": "job-1"}],
                {"run_id": "run-1", "openings_count": 2},
            )

    def test_reports_response_body_after_whole_retry_exhaustion(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(500, text="database statement timed out")

        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            patch("modal_app.time.sleep"),
            self.assertRaisesRegex(
                RuntimeError,
                "failed after 3 whole attempts.*database statement timed out",
            ),
        ):
            _publish_complete_run(
                client,
                "https://example.test",
                {"run_id": "run-1", "health": "complete", "raw_openings_count": 1},
                [{"external_id": "job-1"}],
                {
                    "run_id": "run-1",
                    "openings_count": 1,
                    "ids_sha256": "fixture-digest",
                },
            )


class PublicationSchemaTest(unittest.TestCase):
    def test_rpc_is_service_role_only_and_finalize_is_transactional(self) -> None:
        schema = (Path(__file__).parent / "schema_publication.sql").read_text(
            encoding="utf-8"
        )

        self.assertIn("FROM PUBLIC, anon, authenticated;", schema)
        self.assertIn("TO service_role;", schema)
        self.assertIn(
            "careers.finalize_openings_publication(uuid)",
            schema,
        )
        self.assertIn("openings batch exceeds the 200-row limit", schema)
        self.assertIn("source_opening := jsonb_build_object(", schema)
        self.assertIn("'external_id', opening->>'external_id'", schema)
        self.assertIn("'raw', opening->'raw'", schema)
        self.assertNotIn("            opening\n        )", schema)
        source_projection = schema[
            schema.index("source_opening := jsonb_build_object("):
            schema.index("\n        );", schema.index("source_opening := jsonb_build_object("))
        ]
        for candidate_key in (
            "eligible",
            "suitable",
            "matched",
            "location_eligibility",
            "role_relevance",
            "disposition",
            "reason_codes",
        ):
            self.assertNotIn(candidate_key, source_projection)
        self.assertNotIn("opening->'location_reason_codes'", schema)
        self.assertNotIn("opening->'role_reason_codes'", schema)
        self.assertIn("'undecided',\n        ARRAY[]::text[]", schema)
        self.assertNotIn("p_run->>'eligible_openings_count'", schema)
        self.assertNotIn("p_run->>'suitable_openings_count'", schema)
        self.assertIn("(p_run->>'raw_openings_count')::integer", schema)
        self.assertIn("UPDATE careers.openings AS persisted", schema)
        self.assertIn("COLLATE \"C\"", schema)
        self.assertIn("E'\\n' ORDER BY identity_text", schema)
        self.assertIn("COALESCE(", schema)
        self.assertIn("convert_to(", schema)
        self.assertIn("sha256(", schema)
        self.assertNotIn("pgcrypto", schema)
        self.assertNotIn("extensions.digest(", schema)
        self.assertIn("parity identity digest does not match staged openings", schema)
        self.assertIn("careers.verify_openings_publication(text, text)", schema)
        finalizer_offset = schema.index("finalize_openings_publication")
        self.assertLess(
            schema.index("INSERT INTO careers.openings_runs", finalizer_offset),
            schema.index("INSERT INTO careers.parity_runs", finalizer_offset),
        )


if __name__ == "__main__":
    unittest.main()
