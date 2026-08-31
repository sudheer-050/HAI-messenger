/**
 * Audit formatting unit tests (MYAG-197) -- formatAuditComment is pure.
 * postAuditComment/fileNormalIssue shell out to the multica CLI and are
 * exercised by the integration test harness instead (test/integration.sh).
 * Run with: node --test audit.unit.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { formatAuditComment, writeAuditOutbox } = require('./audit');

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

test('rolled_back outcome reports the failing check and confirms restoration only once the post-rollback check passed', () => {
    const body = formatAuditComment({
        outcome: 'rolled_back',
        correlationId: 'ghi789',
        adminRequestSummary: 'Change theme default',
        healthCheck: {
            healthy: false,
            results: [{ name: 'theme api', path: '/api/theme', ok: false, detail: 'expected 200, got 500' }],
        },
        rollbackHealthCheck: {
            healthy: true,
            results: [{ name: 'theme api', path: '/api/theme', ok: true }],
        },
    });
    assert.match(body, /rolled back/);
    assert.match(body, /FAILED \(expected 200, got 500\)/);
    assert.match(body, /restored and this was verified/);
});

test('rollback_unverified outcome never claims restoration', () => {
    const body = formatAuditComment({
        outcome: 'rollback_unverified',
        correlationId: 'jkl012',
        adminRequestSummary: 'Change theme default',
        healthCheck: {
            healthy: false,
            results: [{ name: 'theme api', path: '/api/theme', ok: false, detail: 'expected 200, got 500' }],
        },
        rollbackHealthCheck: {
            healthy: false,
            results: [{ name: 'theme api', path: '/api/theme', ok: false, detail: 'expected 200, got 500' }],
        },
    });
    assert.match(body, /UNVERIFIED/);
    assert.match(body, /Manual intervention required/);
    assert.doesNotMatch(body, /prior working deployment has been restored/);
    assert.doesNotMatch(body, /restored and this was verified/);
});

test('rollback_failed outcome reports the rollback error and never claims restoration', () => {
    const body = formatAuditComment({
        outcome: 'rollback_failed',
        correlationId: 'mno345',
        adminRequestSummary: 'Change theme default',
        healthCheck: { healthy: false, results: [] },
        rollbackError: 'no hurricane-backend:last-good image found -- cannot roll back',
    });
    assert.match(body, /rollback itself FAILED/);
    assert.match(body, /no hurricane-backend:last-good image found/);
    assert.match(body, /Manual intervention required immediately/);
    assert.doesNotMatch(body, /has been restored/);
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

// MYAG-205: a reroute-issue-filing failure must be surfaced in the audit
// comment, not silently swallowed, and must not claim the normal issue was
// filed when it wasn't.
test('rejected outcome with a reroute error reports the failure and does not claim the issue was filed', () => {
    const body = formatAuditComment({
        outcome: 'rejected',
        correlationId: 'abc123',
        adminRequestSummary: 'Add a dark mode toggle',
        changedFiles: ['backend/server.js'],
        blockedFiles: ['backend/server.js'],
        rerouteError: 'multica issue create failed: connection refused',
    });
    assert.match(body, /could NOT be filed automatically/);
    assert.match(body, /connection refused/);
    assert.match(body, /needs to manually file the reroute issue/);
    assert.doesNotMatch(body, /A normal issue has been filed/);
});

test('rejected outcome without a reroute error still claims the issue was filed', () => {
    const body = formatAuditComment({
        outcome: 'rejected',
        correlationId: 'abc123',
        blockedFiles: ['backend/server.js'],
    });
    assert.match(body, /A normal issue has been filed/);
    assert.doesNotMatch(body, /could NOT be filed automatically/);
});

// MYAG-205: when the audit comment itself cannot be posted to Multica, it
// must be persisted to a durable local file instead of being lost.
test('writeAuditOutbox persists the audit body and failure metadata to a local file', () => {
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-audit-outbox-test-'));
    const body = '### Fast-path deploy succeeded\n\nsome details';

    const outboxPath = writeAuditOutbox({
        correlationId: 'corr-1',
        issueId: 'issue-1',
        body,
        postError: 'multica issue comment add failed: timeout',
        outboxDir,
    });

    assert.equal(fs.existsSync(outboxPath), true);
    const written = fs.readFileSync(outboxPath, 'utf8');
    assert.match(written, /corr-1/);
    assert.match(written, /issue-1/);
    assert.match(written, /timeout/);
    assert.match(written, /Fast-path deploy succeeded/);
    assert.match(written, /some details/);
});

test('writeAuditOutbox creates the outbox directory if it does not exist yet', () => {
    const outboxDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mika-audit-outbox-test-')), 'nested', 'dir');
    assert.equal(fs.existsSync(outboxDir), false);

    writeAuditOutbox({ correlationId: 'corr-2', issueId: 'issue-2', body: 'x', postError: 'y', outboxDir });

    assert.equal(fs.existsSync(outboxDir), true);
    assert.equal(fs.readdirSync(outboxDir).length, 1);
});

test('writeAuditOutbox sanitizes the correlation id used in the filename', () => {
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-audit-outbox-test-'));
    const outboxPath = writeAuditOutbox({
        correlationId: '../../etc/passwd',
        issueId: 'issue-3',
        body: 'x',
        postError: 'y',
        outboxDir,
    });
    assert.equal(path.dirname(outboxPath), outboxDir, 'must not escape the outbox directory');
});
