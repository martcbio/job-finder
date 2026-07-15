# Lab-openings cloud shadow

This Modal arm runs the existing scanner every three hours in UTC and writes only to a container scratch directory plus the estate Supabase project. It never mounts or writes `/Users/mcb/Claudelocal/careers/market`; local launchd remains the production arm. `cloud/targets.json` is the baked shadow copy of the local target configuration and must be kept in parity deliberately.

## Deploy and verify

Run these from the repository root, in order:

```sh
cd /Users/mcb/Claudelocal/careers/resume2/projects/job-finder-cursor-party
supabase db query --linked -f cloud/schema.sql
```

In the linked Supabase project's **Settings → API → Exposed schemas**, add `careers` if it is not already present. Do not add an anonymous policy. No Storage bucket is used.

```sh
modal deploy cloud/modal_app.py
modal run cloud/modal_app.py::run_once
```

Gate 0 passes only when `run_once` exits zero and prints a final JSON summary shaped like:

```json
{"health":"complete","matched_openings_count":12,"persisted_openings":12,"run_id":"...","scanner_exit_status":0}
```

`health` may honestly be `degraded`, but `failed`, a nonzero scanner exit, an artifact error, a PostgREST error, or a missing final summary fails the gate. This run is the datacenter-egress check for Ashby, Greenhouse, and Lever before trusting the cron.

## Check authenticated reads

Use a signed-in user's access token, not the service-role key:

```sh
curl --fail-with-body "$SUPABASE_URL/rest/v1/openings_runs?select=run_id,completed_at,health,matched_openings_count,substrate&order=completed_at.desc&limit=5" \
  -H "apikey: $SUPABASE_ANON_KEY" \
  -H "Authorization: Bearer $SUPABASE_USER_JWT" \
  -H "Accept-Profile: careers"

curl --fail-with-body "$SUPABASE_URL/rest/v1/openings?select=org,ats,external_id,title,first_seen_at,last_seen_at&order=last_seen_at.desc&limit=20" \
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

The doctor becomes stale when the last successful control-plane run is older than twice the registered 10,800-second cadence. Bakeoff cutover is a later decision: keep launchd untouched until cloud/local output parity is established.

## Kill switch

```sh
modal app stop careers-lab-openings
```
