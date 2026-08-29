/**
 * Audit formatting unit tests (MYAG-197) -- formatAuditComment is pure.
 * postAuditComment/fileNormalIssue shell out to the multica CLI and are
 * exercised by the integration test harness instead (test/integration.sh).
 * Run with: node --test audit.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { formatAuditComment } = require('./audit');

test('rejected outcome lists blocked files and states nothing was deployed', () => {
    const body = formatAuditComment({
        outcome: 'rejected',
        correlationId: 'abc123',
        adminRequestSummary: 'Add a dark mode toggle',
        changedFiles: ['backend/server.js', 'frontend/admin.html'],
        blockedFiles: ['backend/server.js'],
    });
    assert.match(body, /Fast-path rejected/);
    assert.match(body, /backend\/server\.js/);
    assert.match(body, /normal issue has been filed/);
    assert.match(body, /Nothing was built or deployed/);
});

test('deployed outcome reports passing health check results', () => {
    const body = formatAuditComment({
        outcome: 'deployed',
        correlationId: 'def456',
        adminRequestSummary: 'Fix double-send bug',
        changedFiles: ['frontend/admin.html'],
        healthCheck: { healthy: true, results: [{ name: 'root', path: '/', ok: true }] },
    });
    assert.match(body, /Fast-path deploy succeeded/);
    assert.match(body, /Health check.*passed/s);
});

test('rolled_back outcome reports the failing check and confirms restoration', () => {
    const body = formatAuditComment({
        outcome: 'rolled_back',
        correlationId: 'ghi789',
        adminRequestSummary: 'Change theme default',
        healthCheck: {
            healthy: false,
            results: [{ name: 'theme api', path: '/api/theme', ok: false, detail: 'expected 200, got 500' }],
        },
    });
    assert.match(body, /rolled back/);
    assert.match(body, /FAILED \(expected 200, got 500\)/);
    assert.match(body, /prior working deployment has been restored/);
});

test('includes the correlation id and admin request summary for traceability', () => {
    const body = formatAuditComment({
        outcome: 'deployed',
        correlationId: 'XYZ-1',
        adminRequestSummary: 'Bump footer copyright year',
    });
    assert.match(body, /XYZ-1/);
    assert.match(body, /Bump footer copyright year/);
});

test('an error is surfaced in the comment when present', () => {
    const body = formatAuditComment({
        outcome: 'rolled_back',
        error: 'docker compose up failed: image build error',
    });
    assert.match(body, /docker compose up failed/);
});
