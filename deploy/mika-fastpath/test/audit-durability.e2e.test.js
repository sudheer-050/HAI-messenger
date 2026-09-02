/**
 * Audit-durability failure-injection tests (MYAG-205).
 *
 * MYAG-194's acceptance criterion 4 requires every fast-path attempt --
 * deployed, rolled back, or rejected -- to produce an auditable record. The
 * original implementation could lose that record on two independent Multica
 * CLI failures:
 *
 *   1. `fileNormalIssue` (the `multica issue create` reroute call on a
 *      rejected attempt) throwing before `postAuditComment` was ever reached,
 *      which propagated out of main() to the top-level crash handler and
 *      skipped the audit comment entirely.
 *   2. `postAuditComment` itself (`multica issue comment add`) failing --
 *      e.g. a CLI outage -- which had no fallback and silently dropped the
 *      one required record of the attempt.
 *
 * These tests spawn the REAL orchestrator.js (same harness style as
 * orchestrator-e2e.test.js) against a fake `multica` CLI that can be told to
 * fail on a specific subcommand via FAKE_MULTICA_FAIL_ON, and prove:
 *   - a reroute-filing failure doesn't prevent the audit comment from being
 *     posted, and the failure itself is surfaced in that comment.
 *   - an audit-comment-post failure falls back to a durable local outbox
 *     record instead of the attempt vanishing.
 *   - this holds on both the rejected path and the deployed path.
 *
 * Run with: node --test deploy/mika-fastpath/test/audit-durability.e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ORCHESTRATOR = path.join(__dirname, '..', 'orchestrator.js');
const FAKE_DOCKER_ENV = path.join(__dirname, 'fake-docker-env');

let portCounter = 6200 + Math.floor(Math.random() * 1000);
function nextPort() {
    portCounter += 1;
    return portCounter;
}

function git(args, cwd) {
    execFileSync('git', args, { cwd, stdio: 'pipe' });
}

// A throwaway repo (not this checkout) with a commit that touches
// backend/server.js, so the carve-out actually trips without depending on
// this project's real git history.
function makeCarveOutRepo() {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-e2e-carveout-repo-'));
    git(['init', '-q'], repoDir);
    git(['config', 'user.email', 'test@example.com'], repoDir);
    git(['config', 'user.name', 'Test'], repoDir);
    fs.mkdirSync(path.join(repoDir, 'backend'));
    fs.writeFileSync(path.join(repoDir, 'backend', 'server.js'), '// v1\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'base'], repoDir);
    const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    fs.writeFileSync(path.join(repoDir, 'backend', 'server.js'), '// v2 - touches crypto/relay code\n');
    git(['add', '.'], repoDir);
    git(['commit', '-q', '-m', 'change server.js'], repoDir);
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir, encoding: 'utf8' }).trim();

    return { repoDir, baseSha, headSha };
}

function readLog(logPath) {
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function readOutbox(outboxDir) {
    if (!fs.existsSync(outboxDir)) return [];
    return fs.readdirSync(outboxDir).map(f => fs.readFileSync(path.join(outboxDir, f), 'utf8'));
}

async function stopService(dockerState) {
    const pidFile = path.join(dockerState, 'current_pid');
    if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
}

test('a reroute-filing failure does not prevent the audit comment, and surfaces the failure in it', () => {
    const { repoDir, baseSha, headSha } = makeCarveOutRepo();
    const multicaLog = path.join(repoDir, 'multica.log');

    const result = spawnSync(process.execPath, [
        ORCHESTRATOR,
        `--base=${baseSha}`,
        `--head=${headSha}`,
        '--correlation-id=reroute-fail-test',
        '--admin-request=touch server.js',
        '--issue-id=fake-issue-id',
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_DOCKER_ENV}${path.delimiter}${process.env.PATH}`,
            MIKA_FASTPATH_REPO_ROOT: repoDir,
            FAKE_MULTICA_LOG: multicaLog,
            FAKE_MULTICA_FAIL_ON: 'issue create',
        },
        timeout: 30000,
    });

    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /failed to file the normal-review reroute issue/);

    const log = readLog(multicaLog);
    assert.match(log, /=== multica issue create /, 'the reroute attempt must still have been made');
    assert.match(log, /=== multica issue comment add /, 'the audit comment must still be posted despite the reroute failure');
    assert.match(log, /Fast-path rejected/);
    assert.match(log, /could NOT be filed automatically/);
    assert.match(log, /needs to manually file the reroute issue/);
});

test('an audit-comment-post failure on a rejected attempt falls back to a durable local outbox record', () => {
    const { repoDir, baseSha, headSha } = makeCarveOutRepo();
    const multicaLog = path.join(repoDir, 'multica.log');
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-e2e-outbox-'));

    const result = spawnSync(process.execPath, [
        ORCHESTRATOR,
        `--base=${baseSha}`,
        `--head=${headSha}`,
        '--correlation-id=post-fail-rejected-test',
        '--admin-request=touch server.js',
        '--issue-id=fake-issue-id',
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_DOCKER_ENV}${path.delimiter}${process.env.PATH}`,
            MIKA_FASTPATH_REPO_ROOT: repoDir,
            MIKA_FASTPATH_AUDIT_OUTBOX_DIR: outboxDir,
            FAKE_MULTICA_LOG: multicaLog,
            FAKE_MULTICA_FAIL_ON: 'issue comment add',
        },
        timeout: 30000,
    });

    // Rejection is still reported via the process exit code even though
    // nothing could be posted to Multica.
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /falling back to a local outbox record/);

    const records = readOutbox(outboxDir);
    assert.equal(records.length, 1, 'exactly one durable audit record must be left behind');
    assert.match(records[0], /Fast-path rejected/);
    assert.match(records[0], /post-fail-rejected-test/);
});

test('an audit-comment-post failure on a successful deploy falls back to a durable local outbox record', async (t) => {
    const port = nextPort();
    const dockerState = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-e2e-post-fail-deploy-'));
    const multicaLog = path.join(dockerState, 'multica.log');
    const outboxDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mika-e2e-outbox-'));
    t.after(() => stopService(dockerState));

    const result = spawnSync(process.execPath, [
        ORCHESTRATOR,
        '--base=HEAD',
        '--head=HEAD',
        '--correlation-id=post-fail-deployed-test',
        '--admin-request=routine change',
        '--issue-id=fake-issue-id',
        `--target-base-url=http://127.0.0.1:${port}`,
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_DOCKER_ENV}${path.delimiter}${process.env.PATH}`,
            TARGET_COMPOSE_DIR: dockerState,
            MIKA_FASTPATH_IMAGE: 'e2e-test-backend',
            MIKA_FASTPATH_SERVICE: 'backend',
            MIKA_FASTPATH_AUDIT_OUTBOX_DIR: outboxDir,
            FAKE_DOCKER_STATE: dockerState,
            FAKE_DOCKER_PORT: String(port),
            FAKE_DOCKER_NEXT_BUILD_MODE: 'good',
            FAKE_MULTICA_LOG: multicaLog,
            FAKE_MULTICA_FAIL_ON: 'issue comment add',
        },
        timeout: 30000,
    });

    // The deploy itself succeeded -- exit code reflects that -- even though
    // reporting it to Multica failed.
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /falling back to a local outbox record/);

    const records = readOutbox(outboxDir);
    assert.equal(records.length, 1, 'exactly one durable audit record must be left behind');
    assert.match(records[0], /Fast-path deploy succeeded/);
    assert.match(records[0], /post-fail-deployed-test/);
});
