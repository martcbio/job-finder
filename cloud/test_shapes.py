#!/usr/bin/env python3
"""Pure self-checks for the Modal shadow row shaping."""

from __future__ import annotations

import unittest

from modal_app import shape_rows


STATUS = {
    "date": "2026-07-15",
    "runId": "scanner-run-1",
    "scheduledAt": "2026-07-15T09:00:00.000Z",
    "startedAt": "2026-07-15T09:00:01.000Z",
    "completedAt": "2026-07-15T09:00:08.000Z",
    "health": "degraded",
    "openings": 1,
    "runs": [{"org": "openai", "ats": "ashby", "status": "hit"}],
    "diagnostics": ["One board failed"],
}

JSONL = """{"org":"openai","company":"OpenAI","ats":"ashby","id":"job-1","title":"Research Engineer","location":"London","locations":["London","Remote"],"url":"https://example.test/job-1","postedAt":"2026-07-14T12:00:00Z","raw":{"id":"job-1"}}
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
                    "raw": {"id": "job-1"},
                    "first_seen_run_id": "scanner-run-1",
                    "first_seen_at": "2026-07-15T09:00:08.000Z",
                    "last_seen_run_id": "scanner-run-1",
                    "last_seen_at": "2026-07-15T09:00:08.000Z",
                }
            ],
        )

    def test_failed_run_can_have_no_openings_artifact(self) -> None:
        failed = {**STATUS, "health": "failed", "openings": 0}
        run, openings = shape_rows(failed, "")

        self.assertEqual(run["health"], "failed")
        self.assertEqual(openings, [])


if __name__ == "__main__":
    unittest.main()
