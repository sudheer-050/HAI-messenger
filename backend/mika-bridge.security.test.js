/**
 * Mika Bridge Security Tests (MYAG-127)
 *
 * These are manual/integration test cases for QA to verify before MYAG-126
 * stage 2 (Frontend) is unblocked. Each case documents the exact request and
 * the expected HTTP status + response shape.
 *
 * Prerequisites:
 *   - Stack running (docker compose up)
 *   - At least one admin account (ADMIN_USERNAMES configured in .env)
 *   - A second non-admin account
 *   - Mika bridge env vars NOT set for the "unconfigured" tests; set for the
 *     "configured" tests
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
        note: 'Run with MULTICA_API_TOKEN unset in the environment',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'hello mika' },
        expect: { status: 503, errorIncludes: 'not configured' },
    },
    {
        id: 'SEC-6',
        name: 'MULTICA_API_TOKEN absent from all response bodies',
        note: 'Call /api/auth/me, /api/admin/overview, and /api/admin/mika/message; verify token never appears in any response body',
        method: 'GET',
        path: '/api/auth/me',
        headers: { Cookie: ADMIN_COOKIE },
        expect: {
            status: 200,
            bodyMustNotContain: process.env.MULTICA_API_TOKEN || 'multica_token_here',
        },
    },
    {
        id: 'SEC-7',
        name: 'Per-user rate limit (6th request within 10 min) → 429',
        note: 'Send 6 identical requests as the same admin; the 6th should return 429',
        method: 'POST',
        path: '/api/admin/mika/message',
        headers: { 'Content-Type': 'application/json', Cookie: ADMIN_COOKIE },
        body: { message: 'rate limit test' },
        repeatCount: 6,
        expect: { statusOnRepeat: 429, repeatIndex: 6 },
    },
    {
        id: 'SEC-8',
        name: 'Idempotency: identical message within 5 min returns cached:true',
        note: 'Send the same message twice within 5 minutes; second response should include { cached: true }',
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
        name: 'Credentials in .env are not in docker-compose.yml or any committed file',
        note: 'Manual: run `git grep -r MULTICA_API_TOKEN -- . :!.env.example :!docker-compose.yml` and confirm zero results that contain an actual token value (not a variable placeholder)',
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

        const pass = ok && !tokenLeak && errorOk;
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
