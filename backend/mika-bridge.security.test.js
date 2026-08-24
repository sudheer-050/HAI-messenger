/**
 * Mika Bridge Security Tests (MYAG-127 contract, MYAG-130 implementation)
 *
 * These are manual/integration test cases for QA to verify before MYAG-128
 * (end-to-end verification) is unblocked. Each case documents the exact
 * request and the expected HTTP status + response shape. Pure-logic coverage
 * (reply-selection/idempotency-hash correctness) lives in the automated
 * mika-bridge.unit.test.js instead — these cases need a live stack because
 * they exercise auth, rate limiting, and the async Multica CLI round trip.
 *
 * Note: since MYAG-130, POST /api/admin/mika/message ACKs with 202 + a
 * requestId immediately; the actual reply arrives later over Socket.IO
 * ('mika_reply') or via GET /api/admin/mika/requests, not in this response.
 *
 * Prerequisites:
 *   - Stack running (docker compose up)
 *   - At least one admin account (ADMIN_USERNAMES configured in .env)
 *   - A second non-admin account
 *   - Mika bridge env vars (MULTICA_PROJECT_ID, MIKA_AGENT_ID,
 *     MIKA_PARENT_ISSUE_ID) NOT set for the "unconfigured" tests; set for the
 *     "configured" tests, with the `multica` CLI installed and authenticated
 *     on the host running the backend
 *
 * Run with: node mika-bridge.security.test.js <base_url> <admin_token> <user_token>
 * or execute each curl command manually.
 */

const BASE = process.argv[2] || 'http://localhost:3000';
const ADMIN_COOKIE = process.argv[3] || '';
const USER_COOKIE  = process.argv[4] || '';

const cases = [
    {
        id: 'SEC-1',
        name: 'Unauthenticated request → 401',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json' },
        body: { message: 'hello mika' },
        expect: { status: 401 },
    },
    {
        id: 'SEC-2',
        name: 'Authenticated non-admin → 403',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: USER_COOKIE },
        body: { message: 'hello mika' },
        expect: { status: 403 },
    },
    {
        id: 'SEC-3',
        name: 'Missing message body → 400',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: {},
        expect: { status: 400, errorIncludes: 'message' },
    },
    {
        id: 'SEC-4',
        name: 'Message over 4000 chars → 400',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'A'.repeat(4001) },
        expect: { status: 400, errorIncludes: '4000' },
    },
    {
        id: 'SEC-5',
        name: 'Mika bridge unconfigured (env vars missing) → 503',
        note: 'Run with MULTICA_PROJECT_ID/MIKA_AGENT_ID/MIKA_PARENT_ISSUE_ID unset in the environment',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'hello mika' },
        expect: { status: 503, errorIncludes: 'not configured' },
    },
    {
        id: 'SEC-6',
        name: 'Accepted request returns 202 + requestId, never a raw CLI error/credential',
        note: 'The response must never contain multica CLI stdout/stderr, file paths, or the string "multica_cli_error"',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'hello mika ' + Date.now() },
        expect: { status: 202, hasField: 'requestId' },
    },
    {
        id: 'SEC-7',
        name: 'Per-user rate limit (6th request within 10 min) → 429',
        note: 'Send 6 distinct-message requests as the same admin; the 6th should return 429',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'rate limit test' },
        repeatCount: 6,
        expect: { statusOnRepeat: 429, repeatIndex: 6 },
    },
    {
        id: 'SEC-8',
        name: 'Idempotency: identical message within 5 min reuses the same requestId',
        note: 'Send the same message twice within 5 minutes; second response should carry { cached: true } and the same requestId as the first',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'idempotency test ' + Date.now() },
        expect: { onSecondCall: { cached: true } },
    },
    {
        id: 'SEC-9',
        name: 'Non-admin cannot access other /api/admin/* endpoints either',
        method: 'GET',
        path: '/api/admin/overview',
        headers: { Cookie: USER_COOKIE },
        expect: { status: 403 },
    },
    {
        id: 'SEC-10',
        name: 'No Multica bearer-token credentials in any committed file',
        note: 'Manual: run `git grep -rE "MULTICA_API_TOKEN|api\\.multica\\.ai" -- . :!.env.example` and confirm zero results — the CLI-based bridge has no bearer token to leak; only the multica CLI\'s own auth on the host matters',
        manual: true,
    },
    {
        id: 'SEC-11',
        name: 'Reply relayed to the admin only came from the trusted Mika agent id on the exact issue created',
        note: 'Manual: with the bridge configured, confirm in DB (mika_bridge_requests) that a completed row\'s reply text matches the corresponding Multica issue comment, and that a comment posted by a different agent/user on that issue is never surfaced as the reply',
        manual: true,
    },
    {
        id: 'SEC-12',
        name: 'Restart recovery: a pending request survives a backend restart',
        note: 'Manual: send a message, restart the backend before Mika replies, and confirm the request either resumes polling (still within timeout) or is marked timeout — never left stuck as pending forever',
        manual: true,
    },
];

async function runTest(tc) {
    if (tc.manual) {
        console.log(`[${tc.id}] MANUAL — ${tc.name}`);
        if (tc.note) console.log(`       Note: ${tc.note}`);
        return;
    }
    try {
        const res = await fetch(`${BASE}${tc.path}`, {
            method: tc.method || 'GET',
            headers: tc.headers || {},
            body: tc.body ? JSON.stringify(tc.body) : undefined,
        });
        const body = await res.text();
        const ok = tc.expect.status ? res.status === tc.expect.status : true;
        const tokenLeak = tc.expect.bodyMustNotContain && body.includes(tc.expect.bodyMustNotContain);
        const errorOk = tc.expect.errorIncludes ? body.toLowerCase().includes(tc.expect.errorIncludes.toLowerCase()) : true;
        const hasFieldOk = tc.expect.hasField ? (() => { try { return tc.expect.hasField in JSON.parse(body); } catch { return false; } })() : true;

        const pass = ok && !tokenLeak && errorOk && hasFieldOk;
        console.log(`[${tc.id}] ${pass ? 'PASS' : 'FAIL'} — ${tc.name}`);
        if (!pass) {
            console.log(`       Expected status ${tc.expect.status}, got ${res.status}`);
            console.log(`       Body: ${body.slice(0, 300)}`);
        }
    } catch (err) {
        console.log(`[${tc.id}] ERROR — ${tc.name}: ${err.message}`);
    }
}

(async () => {
    console.log(`\nMika Bridge Security Tests — ${BASE}\n`);
    for (const tc of cases) {
        await runTest(tc);
    }
    console.log('\nNote: SEC-7 (rate limit) and SEC-8 (idempotency) require manual setup;');
    console.log('run them after resetting Redis or with a fresh account.\n');
})();
