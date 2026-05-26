# Job Finder UI Prototype Gallery

Four visual directions for the job-finder review UI. **Signal Cockpit** is wired to
live Postgres data and fast refresh; the others read the same API hook.

Reads from the local JSON API when available; falls back to mock data when the API is offline.

## Run (via Caddy)

Host Caddy serves the app at:

- **https://job-finder.test:8443/** (preferred)
- **https://job-finder.auto.test:8443/** (same upstream; explicit snippet overrides the socket router)

Snippet: `~/Codelocal/caddy/dev.d/job-finder.caddy`

**Persistent dev server (recommended):**

```bash
cd prototypes/ui
bun install
./scripts/install-launchd.sh
```

Or foreground: `bun run dev`

Vite listens on `127.0.0.1:32002`. A 502 usually means that process is not running.

After changing the Caddy snippet:

```bash
caddy reload --config /Users/mcb/Codelocal/caddy/host/Caddyfile
```

Start the API separately (from worktree root) for live data:

```bash
export DATABASE_URL=postgres://mcb@localhost:5432/jobs
bun run api
```

Direct dev (no Caddy): same port — http://127.0.0.1:32002/

## Prototypes

| ID | Name | Concept |
|----|------|---------|
| `cockpit` | Signal Cockpit | **Live** — queue, source yield, fast refresh |
| `swipe` | Swipe Triage | Card stack for fast review decisions |
| `bento` | Bento Command | Living dashboard tiles with micro-motion |
| `timeline` | Pipeline Timeline | Runs, events, sources chronology |

Signal Cockpit calls `POST /api/refresh/fast` and reads `GET /api/jobs/queue`,
`/api/source-health`, `/api/pipeline-runs`, and `/api/runs/latest`.
