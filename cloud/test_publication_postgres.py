#!/usr/bin/env python3
"""Disposable PostgreSQL integration smoke for atomic cloud publication."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


REPO_ROOT = Path(__file__).resolve().parents[1]
POSTGRES_TOOLS = {
    name: shutil.which(name)
    for name in ("initdb", "pg_ctl", "psql")
}
MISSING_POSTGRES_TOOLS = [
    name for name, executable in POSTGRES_TOOLS.items() if executable is None
]


def _sql_literal(value: str) -> str:
    return f"'{value.replace(chr(39), chr(39) * 2)}'"


def _identity_digest(*identities: str) -> str:
    payload = "\n".join(sorted(identities, key=lambda value: value.encode("utf-8")))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


class PublicationPostgresTest(unittest.TestCase):
    root: Path
    data_directory: Path
    psql_command: list[str]
    started = False

    @classmethod
    def setUpClass(cls) -> None:
        if MISSING_POSTGRES_TOOLS:
            raise RuntimeError(
                "PostgreSQL integration requires binaries: "
                + ", ".join(MISSING_POSTGRES_TOOLS)
            )
        cls.root = Path(tempfile.mkdtemp(prefix="jobsradar-cloud-pg-", dir="/tmp"))
        cls.data_directory = cls.root / "data"
        initdb = POSTGRES_TOOLS["initdb"]
        pg_ctl = POSTGRES_TOOLS["pg_ctl"]
        psql = POSTGRES_TOOLS["psql"]
        assert initdb is not None and pg_ctl is not None and psql is not None

        try:
            cls._command(
                [
                    initdb,
                    "-D",
                    str(cls.data_directory),
                    "--no-locale",
                    "--encoding=UTF8",
                    "--auth=trust",
                ]
            )
            cls._command(
                [
                    pg_ctl,
                    "-D",
                    str(cls.data_directory),
                    "-o",
                    f"-F -c listen_addresses='' -k {cls.root}",
                    "-l",
                    str(cls.root / "postgres.log"),
                    "-w",
                    "start",
                ]
            )
            cls.started = True
            cls.psql_command = [
                psql,
                "-X",
                "-v",
                "ON_ERROR_STOP=1",
                "-h",
                str(cls.root),
                "-d",
                "postgres",
            ]
            cls._sql(
                """
                CREATE ROLE anon NOLOGIN;
                CREATE ROLE authenticated NOLOGIN;
                CREATE ROLE service_role NOLOGIN BYPASSRLS;
                """
            )
            for schema_path in (
                REPO_ROOT / "cloud" / "schema.sql",
                REPO_ROOT / "cloud" / "schema_additions.sql",
                REPO_ROOT / "cloud" / "schema_publication.sql",
            ):
                cls._command([*cls.psql_command, "-f", str(schema_path)])
        except BaseException:
            cls._cleanup()
            raise

    @classmethod
    def tearDownClass(cls) -> None:
        cls._cleanup()

    @classmethod
    def _cleanup(cls) -> None:
        pg_ctl = POSTGRES_TOOLS.get("pg_ctl")
        if cls.started and pg_ctl is not None:
            subprocess.run(
                [
                    pg_ctl,
                    "-D",
                    str(cls.data_directory),
                    "-m",
                    "immediate",
                    "-w",
                    "stop",
                ],
                check=False,
                capture_output=True,
                text=True,
            )
            cls.started = False
        root = getattr(cls, "root", None)
        if root is not None:
            shutil.rmtree(root, ignore_errors=True)

    @staticmethod
    def _command(command: list[str], *, input_text: str | None = None) -> subprocess.CompletedProcess[str]:
        result = subprocess.run(
            command,
            input=input_text,
            capture_output=True,
            text=True,
            env={**os.environ, "LC_ALL": "C"},
            check=False,
        )
        if result.returncode != 0:
            raise AssertionError(
                f"{Path(command[0]).name} exited {result.returncode}:\n{result.stderr.strip()}"
            )
        return result

    @classmethod
    def _sql(cls, sql: str, *, tuples_only: bool = False) -> str:
        command = [*cls.psql_command]
        if tuples_only:
            command.append("-At")
        return cls._command(command, input_text=sql).stdout.strip()

    @classmethod
    def _sql_failure(cls, sql: str) -> str:
        result = subprocess.run(
            cls.psql_command,
            input=sql,
            capture_output=True,
            text=True,
            env={**os.environ, "LC_ALL": "C"},
            check=False,
        )
        if result.returncode == 0:
            raise AssertionError("expected SQL to fail")
        return result.stderr

    def test_atomic_publication_privileges_and_retry(self) -> None:
        good_digest = _identity_digest(
            "anthropic:greenhouse:job-2",
            "openai:ashby:job-1",
        )
        self.assertEqual(
            good_digest,
            "f736a1dd2844e784abdce240a6e81838a5d00f78684c5003b486a33b15077d37",
        )
        good_run = {
            "run_id": "run-good",
            "run_date": "2026-07-30",
            "scheduled_at": "2026-07-30T10:00:00Z",
            "started_at": "2026-07-30T10:00:01Z",
            "completed_at": "2026-07-30T10:00:02Z",
            "health": "complete",
            "raw_openings_count": 2,
            "board_status": [
                {
                    "org": "openai",
                    "company": "OpenAI",
                    "ats": "ashby",
                    "status": "hit",
                    "totalOpenings": 1,
                }
            ],
            "diagnostics": [],
            "substrate": "modal",
        }
        good_parity = {
            "run_id": "run-good",
            "run_date": "2026-07-30",
            "substrate": "modal",
            "openings_count": 2,
            "ids_sha256": good_digest,
            "targets_sha256": "fixture-targets",
        }
        good_openings = [
            {
                "org": "openai",
                "ats": "ashby",
                "external_id": "job-1",
                "title": "Research Engineer",
                "company": "OpenAI",
                "location": "London",
                "locations": ["London"],
                "url": "https://example.test/job-1",
                "posted_at": "2026-07-29T00:00:00Z",
                "raw": {"id": "job-1", "source": "ats"},
                "first_seen_run_id": "run-good",
                "first_seen_at": "2026-07-30T10:00:02Z",
                "last_seen_run_id": "run-good",
                "last_seen_at": "2026-07-30T10:00:02Z",
                "location_eligibility": "eligible",
                "eligibleOpenings": 99,
                "disposition": "suitable",
            },
            {
                "org": "anthropic",
                "ats": "greenhouse",
                "external_id": "job-2",
                "title": "Systems Engineer",
                "company": "Anthropic",
                "location": "Paris",
                "locations": ["Paris"],
                "url": "https://example.test/job-2",
                "posted_at": None,
                "raw": {"id": "job-2", "source": "ats"},
                "first_seen_run_id": "run-good",
                "first_seen_at": "2026-07-30T10:00:02Z",
                "last_seen_run_id": "run-good",
                "last_seen_at": "2026-07-30T10:00:02Z",
                "role_relevance": "relevant",
                "matchedOpenings": 99,
                "reason_codes": ["candidate"],
            },
        ]
        good_publication_id = "00000000-0000-0000-0000-000000000010"
        self._sql(
            f"""
            SET ROLE service_role;
            SELECT careers.begin_openings_publication(
                '{good_publication_id}'::uuid,
                {_sql_literal(json.dumps(good_run))}::jsonb,
                {_sql_literal(json.dumps(good_parity))}::jsonb
            );
            SELECT careers.stage_openings_publication(
                '{good_publication_id}'::uuid,
                {_sql_literal(json.dumps(good_openings))}::jsonb
            );
            """
        )

        staged_candidate_keys = self._sql(
            f"""
            SELECT count(*)
            FROM careers.openings_publication_rows_stage
            WHERE publication_id = '{good_publication_id}'::uuid
              AND (
                  opening_row ? 'location_eligibility'
                  OR opening_row ? 'eligibleOpenings'
                  OR opening_row ? 'disposition'
                  OR opening_row ? 'role_relevance'
                  OR opening_row ? 'matchedOpenings'
                  OR opening_row ? 'reason_codes'
              );
            """,
            tuples_only=True,
        )
        self.assertEqual(staged_candidate_keys, "0")

        receipt = json.loads(
            self._sql(
                f"""
                SET ROLE service_role;
                SELECT careers.finalize_openings_publication(
                    '{good_publication_id}'::uuid
                );
                """,
                tuples_only=True,
            ).splitlines()[-1]
        )
        self.assertEqual(receipt["persisted_openings"], 2)

        neutral_projection = self._sql(
            f"""
            SELECT
                run.raw_openings_count || ':'
                || run.matched_openings_count || ':'
                || run.eligible_openings_count || ':'
                || run.suitable_openings_count || ':'
                || run.unsuitable_location_openings_count || ':'
                || run.unsuitable_role_openings_count || ':'
                || run.undecided_openings_count || ':'
                || parity.ids_sha256 || ':'
                || count(opening.*) FILTER (
                    WHERE opening.location_eligibility = 'undecided'
                      AND opening.role_relevance = 'undecided'
                      AND opening.disposition = 'undecided'
                      AND cardinality(opening.location_reason_codes) = 0
                      AND cardinality(opening.role_reason_codes) = 0
                )
            FROM careers.openings_runs run
            JOIN careers.parity_runs parity ON parity.run_id = run.run_id
            JOIN careers.openings opening ON opening.last_seen_run_id = run.run_id
            WHERE run.run_id = 'run-good'
            GROUP BY run.run_id, parity.run_date, parity.substrate, parity.run_id;
            """,
            tuples_only=True,
        )
        self.assertEqual(neutral_projection, f"2:0:0:0:0:0:2:{good_digest}:2")

        verified = json.loads(
            self._sql(
                f"""
                SET ROLE service_role;
                SELECT careers.verify_openings_publication('run-good', '{good_digest}');
                """,
                tuples_only=True,
            ).splitlines()[-1]
        )
        self.assertTrue(verified["published"])

        authenticated_access = self._sql(
            """
            SET ROLE authenticated;
            SELECT
                (SELECT count(*) FROM careers.openings)::text || ':'
                || has_table_privilege(
                    'authenticated',
                    'careers.openings_publication_stage',
                    'SELECT'
                )::text || ':'
                || has_function_privilege(
                    'authenticated',
                    'careers.finalize_openings_publication(uuid)',
                    'EXECUTE'
                )::text;
            """,
            tuples_only=True,
        ).splitlines()[-1]
        self.assertEqual(authenticated_access, "2:false:false")

        retry_run = {
            **good_run,
            "run_id": "run-retry",
            "raw_openings_count": 1,
            "board_status": [],
        }
        retry_opening = {
            **good_openings[0],
            "org": "retry",
            "external_id": "job-x",
            "company": "Retry",
            "first_seen_run_id": "run-retry",
            "last_seen_run_id": "run-retry",
        }
        retry_digest = _identity_digest("retry:ashby:job-x")
        wrong_parity = {
            **good_parity,
            "run_id": "run-retry",
            "openings_count": 1,
            "ids_sha256": "f" * 64,
        }
        failed_publication_id = "00000000-0000-0000-0000-000000000020"
        self._sql(
            f"""
            SET ROLE service_role;
            SELECT careers.begin_openings_publication(
                '{failed_publication_id}'::uuid,
                {_sql_literal(json.dumps(retry_run))}::jsonb,
                {_sql_literal(json.dumps(wrong_parity))}::jsonb
            );
            SELECT careers.stage_openings_publication(
                '{failed_publication_id}'::uuid,
                {_sql_literal(json.dumps([retry_opening]))}::jsonb
            );
            """
        )
        failure = self._sql_failure(
            f"""
            SET ROLE service_role;
            SELECT careers.finalize_openings_publication(
                '{failed_publication_id}'::uuid
            );
            """
        )
        self.assertIn("parity identity digest does not match staged openings", failure)
        rollback_state = self._sql(
            f"""
            SELECT
                (SELECT count(*) FROM careers.openings_runs WHERE run_id = 'run-retry')
                || ':' ||
                (SELECT count(*) FROM careers.parity_runs WHERE run_id = 'run-retry')
                || ':' ||
                (SELECT count(*) FROM careers.openings WHERE org = 'retry')
                || ':' ||
                (SELECT count(*) FROM careers.openings_publication_rows_stage
                 WHERE publication_id = '{failed_publication_id}'::uuid);
            """,
            tuples_only=True,
        )
        self.assertEqual(rollback_state, "0:0:0:1")

        retry_publication_id = "00000000-0000-0000-0000-000000000021"
        correct_parity = {**wrong_parity, "ids_sha256": retry_digest}
        retry_receipt = json.loads(
            self._sql(
                f"""
                SET ROLE service_role;
                SELECT careers.begin_openings_publication(
                    '{retry_publication_id}'::uuid,
                    {_sql_literal(json.dumps(retry_run))}::jsonb,
                    {_sql_literal(json.dumps(correct_parity))}::jsonb
                );
                SELECT careers.stage_openings_publication(
                    '{retry_publication_id}'::uuid,
                    {_sql_literal(json.dumps([retry_opening]))}::jsonb
                );
                SELECT careers.finalize_openings_publication(
                    '{retry_publication_id}'::uuid
                );
                """,
                tuples_only=True,
            ).splitlines()[-1]
        )
        self.assertEqual(retry_receipt["persisted_openings"], 1)
        retry_state = self._sql(
            f"""
            SELECT
                (SELECT count(*) FROM careers.openings_runs WHERE run_id = 'run-retry')
                || ':' ||
                (SELECT count(*) FROM careers.parity_runs
                 WHERE run_id = 'run-retry' AND ids_sha256 = '{retry_digest}')
                || ':' ||
                (SELECT count(*) FROM careers.openings WHERE org = 'retry')
                || ':' ||
                (SELECT count(*) FROM careers.openings_publication_rows_stage
                 WHERE publication_id = '{failed_publication_id}'::uuid)
                || ':' ||
                (SELECT count(*) FROM careers.openings_publication_stage
                 WHERE publication_id = '{retry_publication_id}'::uuid);
            """,
            tuples_only=True,
        )
        self.assertEqual(retry_state, "1:1:1:0:0")

        downgrade = self._sql_failure(
            f"""
            SET ROLE service_role;
            SELECT careers.persist_openings_run_only(
                {_sql_literal(json.dumps({**good_run, "health": "failed"}))}::jsonb
            );
            """
        )
        self.assertIn("different immutable content", downgrade)

        candidate_board_status = {
            **retry_run,
            "run_id": "run-candidate-board",
            "health": "failed",
            "board_status": [{"org": "openai", "eligibleOpenings": 1}],
        }
        rejected_board_status = self._sql_failure(
            f"""
            SET ROLE service_role;
            SELECT careers.persist_openings_run_only(
                {_sql_literal(json.dumps(candidate_board_status))}::jsonb
            );
            """
        )
        self.assertIn("board_status contains non-source fields", rejected_board_status)


if __name__ == "__main__":
    unittest.main()
