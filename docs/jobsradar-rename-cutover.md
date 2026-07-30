# Jobsradar rename cutover

This PR prepares the code and service templates for the canonical checkout:

```text
/Users/mcb/Claudelocal/careers/jobsradar
```

Merging the PR does not move the active checkout, restart launchd, change Caddy,
or redeploy Modal. Perform the stateful cutover only after the PR is merged.

## 1. Stop writers

Boot out the two parent-careers agents that still invoke scripts by absolute
path:

```sh
launchctl bootout "gui/$(id -u)/com.mcb.careers.lab-openings"
launchctl bootout "gui/$(id -u)/com.mcb.careers.jobs-db-backup"
```

Also stop the retired API, UI, and fast-refresh labels if they are loaded.

## 2. Move the checkout

Move the whole standalone repository, including `.git`, in one filesystem
operation:

```sh
mv /Users/mcb/Claudelocal/careers/resume2/projects/job-finder-cursor-party \
  /Users/mcb/Claudelocal/careers/jobsradar
cd /Users/mcb/Claudelocal/careers/jobsradar
```

Do not leave a compatibility symlink. The code derives its own root, and the
launchd templates are rendered from the post-move path.

## 3. Update parent-owned configuration

Replace the retired checkout path with the new root in:

- `/Users/mcb/Claudelocal/careers/market/launchd/com.mcb.careers.lab-openings.plist`
- `/Users/mcb/Claudelocal/careers/market/launchd/com.mcb.careers.jobs-db-backup.plist`
- `/Users/mcb/Claudelocal/careers/.gitignore`
- current estate documentation that identifies the live pipeline

Re-copy and bootstrap the two parent launchd plists only after inspecting their
rendered paths.

## 4. Install renamed local services

```sh
./scripts/install-jobsradar-launchd.sh all
```

The installer renders templates using the actual checkout root, unloads the
retired `com.mcb.job-finder*` labels, and installs:

- `com.mcb.jobsradar-api`
- `com.mcb.jobsradar-ui`
- `com.mcb.jobsradar.fast-refresh`

## 5. Rename the local web route

Rename `~/Codelocal/caddy/dev.d/job-finder.caddy` to `jobsradar.caddy`, replace
the hostnames with `jobsradar.test` and `jobsradar.auto.test`, reload Caddy, and
verify `https://jobsradar.test:8443/`.

## 6. Redeploy Modal

From the new checkout:

```sh
modal deploy cloud/modal_app.py
modal run cloud/modal_app.py::run_once
```

The image root is `/opt/jobsradar`. Accept only a complete, zero-exit run. A
degraded run must persist diagnostics without changing durable openings.

## 7. Acceptance

Run:

```sh
bun run typecheck
bun run lint
bun test src/**/__tests__/
python3 cloud/test_shapes.py
./scripts/opps doctor
```

Then verify no installed plist or active Caddy snippet contains the retired
checkout path. Keep the old directory absent; do not recreate it as a symlink.
