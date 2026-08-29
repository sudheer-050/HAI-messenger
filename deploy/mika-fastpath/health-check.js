/**
 * Mika fast-path health check (MYAG-197)
 *
 * Deliberately checks more than "the process answers a socket" -- it exercises
 * named service paths over HTTP so a deploy that starts cleanly but serves
 * broken responses (the "runs but is silently wrong" case the crash-restart
 * model can't catch) still fails the check.
 *
 * `fetchImpl` is injectable so this is unit-testable without a network call;
 * production code should pass Node's global fetch (or a small wrapper).
 */
'use strict';

const DEFAULT_CHECKS = [
    { name: 'static frontend', path: '/', expectStatus: 200 },
    { name: 'theme api (public, hits DB)', path: '/api/theme', expectStatus: 200, expectJson: true },
];

async function runOneCheck(baseUrl, check, fetchImpl, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const url = new URL(check.path, baseUrl).toString();
    try {
        const res = await fetchImpl(url, { signal: controller.signal });
        const statusOk = res.status === (check.expectStatus || 200);
        let jsonOk = true;
        if (check.expectJson) {
            try {
                await res.clone().json();
            } catch {
                jsonOk = false;
            }
        }
        return {
            name: check.name,
            path: check.path,
            ok: statusOk && jsonOk,
            status: res.status,
            detail: !statusOk ? `expected ${check.expectStatus}, got ${res.status}` : (!jsonOk ? 'response body was not valid JSON' : null),
        };
    } catch (err) {
        return { name: check.name, path: check.path, ok: false, status: null, detail: err.message };
    } finally {
        clearTimeout(timer);
    }
}

// Runs every check; a single failing check fails the whole health check
// (fast-path deploys are meant to be low-risk, so we don't average results).
async function runHealthChecks(baseUrl, {
    checks = DEFAULT_CHECKS,
    fetchImpl = globalThis.fetch,
    timeoutMs = 5000,
    retries = 2,
    retryDelayMs = 1000,
} = {}) {
    if (typeof fetchImpl !== 'function') {
        throw new Error('health-check requires a fetch implementation (pass fetchImpl or run on Node 18+)');
    }

    const results = [];
    for (const check of checks) {
        let attempt = 0;
        let result;
        do {
            result = await runOneCheck(baseUrl, check, fetchImpl, timeoutMs);
            if (result.ok) break;
            attempt += 1;
            if (attempt <= retries) {
                await new Promise(r => setTimeout(r, retryDelayMs));
            }
        } while (attempt <= retries);
        results.push({ ...result, attempts: attempt + 1 });
    }

    return {
        healthy: results.every(r => r.ok),
        results,
    };
}

module.exports = { DEFAULT_CHECKS, runHealthChecks, runOneCheck };
