/**
 * Health check unit tests (MYAG-197) -- uses a fake fetchImpl, no network.
 * Run with: node --test health-check.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runHealthChecks } = require('./health-check');

function fakeFetch(responses) {
    let call = 0;
    return async (url) => {
        const entry = responses[call] || responses[responses.length - 1];
        call += 1;
        if (entry.throw) throw new Error(entry.throw);
        return {
            status: entry.status,
            clone() { return this; },
            async json() {
                if (entry.badJson) throw new Error('not json');
                return entry.body || {};
            },
        };
    };
}

test('healthy when every check returns its expected status', async () => {
    const fetchImpl = fakeFetch([{ status: 200 }, { status: 200, body: { ok: true } }]);
    const result = await runHealthChecks('http://localhost:3000', {
        checks: [
            { name: 'root', path: '/', expectStatus: 200 },
            { name: 'theme', path: '/api/theme', expectStatus: 200, expectJson: true },
        ],
        fetchImpl,
        retries: 0,
    });
    assert.equal(result.healthy, true);
    assert.equal(result.results.length, 2);
});

test('unhealthy when a check returns the wrong status, after retrying', async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls += 1;
        return { status: 500, clone() { return this; }, async json() { return {}; } };
    };
    const result = await runHealthChecks('http://localhost:3000', {
        checks: [{ name: 'root', path: '/', expectStatus: 200 }],
        fetchImpl,
        retries: 2,
        retryDelayMs: 1,
    });
    assert.equal(result.healthy, false);
    assert.equal(result.results[0].ok, false);
    assert.equal(calls, 3); // initial attempt + 2 retries
});

test('unhealthy when the endpoint is unreachable (network error)', async () => {
    const fetchImpl = fakeFetch([{ throw: 'ECONNREFUSED' }]);
    const result = await runHealthChecks('http://localhost:3000', {
        checks: [{ name: 'root', path: '/', expectStatus: 200 }],
        fetchImpl,
        retries: 0,
    });
    assert.equal(result.healthy, false);
    assert.match(result.results[0].detail, /ECONNREFUSED/);
});

test('unhealthy when a JSON check gets a 200 but a non-JSON body', async () => {
    const fetchImpl = fakeFetch([{ status: 200, badJson: true }]);
    const result = await runHealthChecks('http://localhost:3000', {
        checks: [{ name: 'theme', path: '/api/theme', expectStatus: 200, expectJson: true }],
        fetchImpl,
        retries: 0,
    });
    assert.equal(result.healthy, false);
});

test('one failing check fails the whole health check even if others pass', async () => {
    const fetchImpl = fakeFetch([{ status: 200 }, { status: 500 }]);
    const result = await runHealthChecks('http://localhost:3000', {
        checks: [
            { name: 'root', path: '/', expectStatus: 200 },
            { name: 'theme', path: '/api/theme', expectStatus: 200 },
        ],
        fetchImpl,
        retries: 0,
    });
    assert.equal(result.healthy, false);
});

test('throws a clear error if no fetch implementation is available', async () => {
    await assert.rejects(
        () => runHealthChecks('http://localhost:3000', { fetchImpl: null }),
        /requires a fetch implementation/
    );
});
