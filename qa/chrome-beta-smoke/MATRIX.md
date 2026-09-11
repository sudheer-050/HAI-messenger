# Chrome Beta smoke matrix

Reusable gate to run against Chrome Beta before every Chrome Stable
promotion (MYAG-238). Covers HAI's browser-managed, PWA-critical paths only —
not a general regression suite. Each row maps to an existing MYAG-10 manual
test case where one exists.

Run this matrix with `npx playwright test` from this directory (see
`README.md`) after exporting the env vars it needs. Fill in one results table
per run, dated and versioned as below.

## Result legend

- **pass** — exercised against the target Chrome Beta build, behaved as
  expected.
- **fail** — exercised, did not behave as expected. File a defect issue
  linked to the row's TC-id and record the issue key here.
- **blocked** — could not be exercised this run for an environment reason
  (no browser, no test env, missing credentials, etc). Not a product
  judgment either way.
- **not-tested** — in scope but out of reach of this harness for a reason
  other than environment (e.g. the underlying feature doesn't exist yet).

## Matrix

| # | Path | MYAG-10 TC-id(s) | Automatable via this harness | Notes |
|---|------|-------------------|-------------------------------|-------|
| 1 | Login / unlock | TC-1.1, TC-1.2, TC-1.5, TC-1.6 | Yes — needs `BASE_URL` + a seeded test account | Backend auth (JWT + bcrypt) is standard; no browser-specific risk identified beyond normal form/cookie behavior. |
| 2 | IndexedDB device-key recovery | TC-2.4 | Yes — needs `BASE_URL` + a seeded test account | Client stores the non-extractable RSA private key in IndexedDB (`frontend/index.html`, `openHaiDb`/key-store helpers) and re-imports it into a `CryptoKey` each session. Chrome Beta IndexedDB/WebCrypto behavior changes are the actual regression risk here, not app logic. |
| 3 | Service-worker update | none | Partially — registration is checkable; update-flow needs a served app | `frontend/service-worker.js` is a **deliberate pure passthrough** (`fetch` handler always does `fetch(event.request, {cache: 'no-store'})`, no `install`-time caching). Confirm this hasn't regressed into caching stale responses, since that's the one failure mode a passthrough SW can still have (see MYAG-... offline-caching finding below, this is the opposite risk). |
| 4 | Offline-to-online message delivery | TC-3.2 | Yes — needs `BASE_URL`, two seeded accounts, Redis-backed backend | Offline queue/drain is a socket + Redis concern; verify no duplicate/reordered delivery on reconnect specifically under Chrome Beta's networking/back-forward-cache behavior. |
| 5 | Install / update | TC-7.1 | Partially — installability criteria are checkable statically | `manifest.json` present and valid (verified 2026-09-04: `start_url`, `scope`, `display: standalone`, 192/512 icons present at `frontend/icons/`). Full install-prompt/update-flow needs a served app and a real Chrome install surface (not automatable headless). |
| 6 | Notification permission and badging | none | **Not applicable as currently built** | No `Notification` API, no Push API (`pushManager.subscribe`), and no `navigator.setAppBadge` calls anywhere in `frontend/index.html` or `service-worker.js`. The existing "notification badge" is a DOM-only red-dot UI element, not an OS-level notification or app-icon badge. This item as scoped in MYAG-238/239 assumes browser-managed notification/badging surface that HAI doesn't currently use — see run report. |
| 7 | Microphone permission | TC-4.2 (partial) | Yes — needs `BASE_URL`, a seeded account, and a fake-media-capable Chrome launch (`--use-fake-device-for-media-stream`) | `getUserMedia({audio:true})` + `MediaRecorder` at `frontend/index.html:7527`. TC-4.2 covers the voice-note UX; this row is specifically the browser permission-prompt/grant path. |
| 8 | One 1:1 WebRTC call | none | **Not applicable — feature not implemented** | No `RTCPeerConnection`, no WebRTC signaling, and no TURN/STUN config anywhere in the repo (grepped `frontend/`, `backend/`). HAI does not currently have voice/video calling. This row cannot be exercised, blocked, or failed — it has nothing to run against. |

## Run log

Append one dated section per execution. Do not include plaintext messages,
private keys, credentials, TURN secrets, or personal data in evidence —
screenshots/HAR files must be scrubbed of message bodies before attaching.

### 2026-09-04 — see run report in MYAG-239

No live execution performed this run (harness authored and validated, but no
browser or Docker runtime was available in the authoring environment). See
the MYAG-239 issue comment for the full explicit per-row status and the
environment-gap explanation.
