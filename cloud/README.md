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
```

In the linked Supabase project's **Settings → API → Exposed schemas**, add `careers` if it is not already present. Do not add an anonymous policy. No Storage bucket is used.

```sh
modal deploy cloud/modal_app.py
modal run cloud/modal_app.py::run_once
```

Gate 0 passes only when `run_once` exits zero and prints a final JSON summary shaped like:

```json
{"eligible_openings_count":50,"health":"complete","matched_openings_count":12,"persisted_openings":723,"raw_openings_count":723,"run_id":"...","scanner_exit_status":0,"suitable_openings_count":12}
```

`health` may honestly be `degraded`, but `failed`, a nonzero scanner exit, an artifact error, a PostgREST error, or a missing final summary fails the gate. This run is the datacenter-egress check for Ashby, Greenhouse, and Lever before trusting the cron.

After parity passes, `opps update` downloads the latest complete Modal candidate
set through the local API, validates its count and full ATS bodies, and writes an
atomic local projection. It visibly falls back to the Mac scanner on any
failure; it never moves authenticated or session-bound acquisition to Modal.

## Check authenticated reads

Use a signed-in user's access token, not the service-role key:

```sh
curl --fail-with-body "$SUPABASE_URL/rest/v1/openings_runs?select=run_id,completed_at,health,raw_openings_count,eligible_openings_count,suitable_openings_count,substrate&order=completed_at.desc&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Accept-Profile: careers"

curl --fail-with-body "$SUPABASE_URL/rest/v1/openings?select=org,ats,external_id,title,location_eligibility,role_relevance,disposition,first_seen_at,last_seen_at&order=last_seen_at.desc&limit=20" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Accept-Profile: careers"
```

In the Supabase SQL editor, verify the control-plane lifecycle and doctor state:

```sql
select * from runs where task = 'careers-lab-openings' order by created_at desc limit 5;
select * from heartbeats where task = 'careers-lab-openings' order by beat_at desc limit 5;
select * from doctor where task = 'careers-lab-openings';
```

The doctor becomes stale when the last successful control-plane run is older than twice the registered 10,800-second cadence. Keep both arms running and use `careers.parity_runs` plus the operations UI to investigate count or digest divergence.

## Kill switch

```sh
modal app stop careers-lab-openings
```
