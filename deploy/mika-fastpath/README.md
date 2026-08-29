## Mika fast-path deploy pipeline (MYAG-197)

Lets an admin-approved change from the Mika chat bridge (`backend/mika-bridge.js`,
`/api/admin/mika/message`) ship through commit → build → deploy → post-deploy
health check → automatic rollback on failure, with a hard, code-enforced
carve-out that routes anything touching crypto/secrets to the normal review
pipeline instead of the fast path.

### CI workflow

`ci/mika-fastpath.workflow.yml` is a ready-to-use GitHub Actions workflow, but
it lives outside `.github/workflows/` on purpose: this PR was pushed with a
token that lacks the `workflow` OAuth scope, and GitHub rejects any push that
touches `.github/workflows/*` without it. Someone with that scope (or via the
GitHub web UI, which isn't subject to this restriction) needs to copy this
file to `.github/workflows/mika-fastpath.yml` for it to actually run as a
workflow — it does nothing sitting here.

### Pieces

| File | Role |
|---|---|
| `carve-out.js` | Deterministic path-based denylist check. Whole files are blocked (`backend/server.js`, `frontend/index.html`, `.env`, `.env.example`, `cloudflared/**`) rather than "the crypto lines within them" — see the comment in the file for why a sub-file heuristic was rejected. |
| `health-check.js` | Hits real service paths (`/`, `/api/theme`) post-deploy, not just "is the process up." A deploy that starts cleanly but serves broken responses fails this. |
| `audit.js` | Formats and posts the mandatory audit comment (success, rollback, or rejection) via the `multica` CLI — reuses the CLI install/auth the Mika bridge already requires, no new credential surface. |
| `orchestrator.js` | Ties the above together: diff → carve-out check → deploy.sh → health-check → rollback.sh if unhealthy → exactly one audit comment, always. |
| `deploy.sh` / `rollback.sh` | Tag-based docker compose deploy/rollback for the `backend` service. `deploy.sh` tags the currently-running image `hurricane-backend:last-good` before building/starting the new one; `rollback.sh` restores that tag. Requires `image: hurricane-backend:latest` on the `backend` service in `docker-compose.yml` (added as part of this change) so the tag is authoritative. |
| `test/` | Integration test proving the three required scenarios — see below. |

### What's verified vs. not

- `carve-out.js`, `health-check.js`, `audit.js` (formatting) are unit-tested (`node --test deploy/mika-fastpath/*.unit.test.js`) with no external dependencies.
- `test/integration.test.js` exercises the *real* `carve-out.js` and `health-check.js` end-to-end against a locally-spawned process (not docker — this sandbox has no docker socket access) and proves:
  - (a) a routine change clears the carve-out and a healthy deploy is confirmed by a real HTTP health check.
  - (b) a change touching `backend/server.js` is rejected by the carve-out before anything is deployed; the previously-running version is left untouched.
  - (c) a deploy that starts (process up) but serves broken responses fails the health check, and rollback demonstrably restores correct behavior — re-checked with the same health-check module, not assumed from a script's exit code.
- **Not verified in this change**: `deploy.sh` / `rollback.sh`'s actual `docker compose` / image-tag mechanics. This development sandbox has no docker daemon access (`permission denied` on `/var/run/docker.sock`), so the real docker path could not be exercised here. These scripts should be run against a real docker daemon (a CI runner, or a throwaway compose stack on the home server — **not** the live `myhai.org` containers) before being trusted for an actual fast-path deploy.
- **Not wired up**: nothing in this PR connects the pipeline to the live production instance, grants it real Multica API credentials, or hooks it to a CI trigger that fires automatically. `orchestrator.js` requires `--issue-id` / `MIKA_PARENT_ISSUE_ID` and will refuse to run without it; `TARGET_COMPOSE_DIR` defaults to the local checkout, not the production compose directory. Pointing this at `myhai.org` for real is a separate, explicit step.

### Carve-out design note

The issue asks to block changes to "`backend/server.js`'s crypto/relay functions" and "key-handling code in `frontend/index.html`" specifically, but also requires the check to be "an explicit file/path allowlist or denylist check, not a heuristic." Distinguishing crypto-related lines from other lines in the same file requires either a heuristic (AST inspection, keyword matching) that can be bypassed by renaming or restructuring, or a maintained line-range list that goes stale the moment the file changes shape. Blocking the whole file is the deterministic option that satisfies "not a heuristic" and "cannot be bypassed by a change that merely avoids naming the excluded files" — the tradeoff is that *any* change to `backend/server.js` or `frontend/index.html`, not just crypto-related ones, goes through the normal review pipeline instead of the fast path. Given how central both files are, this seemed like the right tradeoff to flag explicitly rather than silently narrow the carve-out to "just the crypto functions."

### Running the tests

```
node --test deploy/mika-fastpath/*.unit.test.js deploy/mika-fastpath/test/*.test.js
```
