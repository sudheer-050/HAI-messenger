# Chrome Beta smoke gate

Minimal, repeatable smoke matrix over HAI's browser-critical PWA paths,
meant to run against Chrome Beta before every Chrome Stable promotion
(MYAG-238). See `MATRIX.md` for the full path list and per-run results.

This is QA tooling, not part of the app build or its dependency tree —
kept in its own `package.json` under `qa/` deliberately.

## Prerequisites

1. A running HAI instance to test against — **your own local `docker compose
   up`, never `myhai.org`**. Start the stack per the root `README.md`.
2. Google Chrome Beta installed on the host running the tests:
   ```bash
   npx playwright install chrome-beta
   ```
   (or point Playwright at a system install — see Playwright's `channel` docs.)
3. One or two seeded test accounts on that local instance (do not reuse real
   user accounts or real message history).

## Running

```bash
cd qa/chrome-beta-smoke
npm install
CHROME_BETA_SMOKE_BASE_URL=http://localhost:3000 \
CHROME_BETA_SMOKE_USERNAME=<seeded-test-account-email> \
CHROME_BETA_SMOKE_PASSWORD=<seeded-test-account-password> \
npx playwright test
```

Any test whose required env var(s) are unset skips explicitly rather than
reporting a false pass or fail — check the run output for `skipped` counts,
not just `passed`.

## After a run

1. Record the exact Chrome Beta version (`chrome://version` or
   `npx playwright test --list` output), the app revision (`git rev-parse
   HEAD` of the tested checkout), and platform in `MATRIX.md`'s run log.
2. File a defect issue for any `fail`, linked to the row's TC-id, with the
   Playwright trace/screenshot attached — **scrub any message plaintext
   before attaching**, since `use.screenshot`/`trace` can capture on-screen
   chat content.
3. Update `MATRIX.md`'s result column for every row, including `blocked` /
   `not-tested` ones with a one-line reason. Every row needs an explicit
   result — a blank cell is not a valid outcome.

## What this does not cover

- **Offline-to-online message delivery** (TC-3.2) and **install/update
  prompt UX** (TC-7.1) need either two synchronized accounts or a real
  install surface this headless harness doesn't drive yet — verify those
  manually per MYAG-10 until/unless repeated Chrome-Beta-specific failures
  justify automating them here.
- **1:1 WebRTC call** and **OS-level notification permission/badging** —
  see `MATRIX.md`: neither has an implementation in the current codebase to
  test against.
