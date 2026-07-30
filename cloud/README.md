# Lab-openings Modal arm

This is the cloud half of the dual-arm lab-openings scanner. Modal runs every three hours in UTC and writes only to a container scratch directory plus the estate Supabase `careers` schema; the macOS launchd arm writes the local market artifacts. Both are operational arms and publish comparable parity rows. Modal never mounts or writes `/Users/mcb/Claudelocal/careers/market`. Active targets come from `careers.targets`; `cloud/targets.json` fills missing ATS mappings and is the fallback when the remote target read fails.

## Parity digest contract

Both arms parse the run JSONL into `org:ats:id` triples, sort those complete UTF-8 strings bytewise (`LC_ALL=C` order), join them with one LF byte between entries and no trailing LF, then SHA-256 the resulting bytes. An empty run hashes the empty byte string. `openings_count` is the number of parsed JSONL rows.

## Deploy and verify

Run these from the repository root, in order:

```sh
cd /Users/mcb/Claudelocal/careers/jobsradar
supabase db query --linked -f cloud/schema.sql
supabase db query --linked -f cloud/schema_additions.sql
supabase db query --linked -f cloud/schema_publication.sql
```

In the linked Supabase project's **Settings → API → Exposed schemas**, add `careers` if it is not already present. Do not add an anonymous policy. No Storage bucket is used.

`schema_publication.sql` must be applied last because its finalizer writes all
three tables created by the first two files. Its RPCs are executable only by
`service_role`; do not expose them to `anon` or `authenticated`.

Complete runs are published atomically. Modal creates an isolated publication
ID, stages openings through service-role RPC calls capped at 200 rows (so a
realistic full ATS corpus is not one oversized HTTP/PostgREST payload), then
finalizes the run row, every opening, and parity row in one database
transaction. Readers see all three or none. A transient failure retries the
whole publication with a fresh ID; target upserts make a lost-response retry
idempotent. After an ambiguous finalize timeout or malformed response, Modal
checks the committed run and parity digest before retrying, so a successful
commit is not reported as a failure. Degraded and failed runs use the run-only
RPC and never publish openings or parity.

Modal publication is Radar-neutral. It ignores the scanner's candidate-specific
eligibility, relevance, reason-code, disposition, and derived-count fields.
Per-board status retains only source acquisition fields (`org`, `company`, `ats`,
`status`, `totalOpenings`, and `error`), and the staging RPC rebuilds every
opening from a strict source-field whitelist. The final transaction recomputes
the identity digest from staged `org:ats:external_id` values using the byte-order
and LF contract above and rejects a caller-supplied mismatch.
Legacy database columns remain only for compatibility: each opening is stored
as `undecided` with empty reason arrays, candidate judgment counts are zero, and
`undecided_openings_count` equals the preserved raw opening count. Candidate
judgment belongs in JobsDigest, not capture.

```sh
modal deploy cloud/modal_app.py
modal run cloud/modal_app.py::run_once
```

Gate 0 passes only when `run_once` exits zero and prints a final JSON summary shaped like:

```json
{"health":"complete","persisted_openings":723,"raw_openings_count":723,"run_id":"...","scanner_exit_status":0}
```

`health` may honestly be `degraded`, but `failed`, a nonzero scanner exit, an artifact error, a PostgREST error, or a missing final summary fails the gate. This run is the datacenter-egress check for Ashby, Greenhouse, and Lever before trusting the cron.

After parity passes, `opps update` downloads the latest complete Modal source
set through the local API, validates its count and full ATS bodies, and writes an
atomic local projection. It visibly falls back to the Mac scanner on any
failure; it never moves authenticated or session-bound acquisition to Modal.

## Check authenticated reads

Use a signed-in user's access token, not the service-role key:

```sh
curl --fail-with-body "$SUPABASE_URL/rest/v1/openings_runs?select=run_id,completed_at,health,raw_openings_count,undecided_openings_count,substrate&order=completed_at.desc&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Accept-Profile: careers"

curl --fail-with-body "$SUPABASE_URL/rest/v1/openings?select=org,ats,external_id,title,company,location,url,first_seen_at,last_seen_at&order=last_seen_at.desc&limit=20" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Accept-Profile: careers"
```

In the Supabase SQL editor, verify the control-plane lifecycle and doctor state:

```sql
select * from runs where task = 'jobsradar' order by created_at desc limit 5;
select * from heartbeats where task = 'jobsradar' order by beat_at desc limit 5;
select * from doctor where task = 'jobsradar';
```

The doctor becomes stale when the last successful control-plane run is older than twice the registered 10,800-second cadence. Keep both arms running and use `careers.parity_runs` plus the operations UI to investigate count or digest divergence.

## Kill switch

```sh
modal app stop jobsradar
```
