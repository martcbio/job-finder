# UI prototypes (gallery)

Experimental visual directions for the jobsradar review UI. **Not production code.**

## Gallery vs wired

| Layer | Path | Purpose |
|-------|------|---------|
| **Gallery** | `prototypes/ui/` | Seven switchable concepts; compare layouts and tone. Mock-data fallback when API is offline. |
| **Wired (future)** | TBD (e.g. `ui/` at repo root) | One or two chosen flows with real refresh, review actions, and error handling. |

Keep the gallery intact when promoting a direction — we may return to unused prototypes or mix ideas later.

## Serve locally

Host Caddy snippet: `~/Codelocal/caddy/dev.d/jobsradar.caddy`

- https://jobsradar.test:8443/ (preferred)
- https://jobsradar.auto.test:8443/

See [ui/README.md](ui/README.md) for install, LaunchAgent, and API notes.
