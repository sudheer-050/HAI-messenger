/**
 * Orchestrator end-to-end test (MYAG-204).
 *
 * The existing integration test (integration.test.js) proves the carve-out
 * and health-check MODULES work, but it never runs `orchestrator.js`,
 * `deploy.sh`, or `rollback.sh` themselves -- it swaps in ProcessDeployer
 * instead. That's exactly why MYAG-204 slipped through: the real rollback
 * contract (rollback.sh's exit code, then a fresh post-rollback health
 * check, then an honest audit claim) was never exercised.
 *
 * This test spawns the REAL orchestrator.js as a child process, which in
 * turn shells out to the REAL deploy.sh/rollback.sh. A fake `docker` CLI
 * (test/fake-docker-env/docker) stands in for the daemon -- this sandbox has
 * no docker socket access -- but it backs "images" with a real backgrounded
 * HTTP server (fake-service.js) so health-check.js is hitting real sockets,
 * not a stub. A fake `multica` CLI captures the audit comment body instead
 * of making a real API call.
 *
 * Still not covered here (see README.md "What's verified vs. not"):
 * deploy.sh/rollback.sh's actual `docker compose build/up`/image-tag
 * mechanics against a real docker daemon. That requires a disposable real
 * Compose stack (a CI runner or a throwaway stack on a host with docker
 * access) and has not been done as part of this change.
 *
 * Run with: node --test deploy/mika-fastpath/test/orchestrator-e2e.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { runHealthChecks } = require('../health-check');

const ORCHESTRATOR = path.join(__dirname, '..', 'orchestrator.js');
const FAKE_DOCKER_ENV = path.join(__dirname, 'fake-docker-env');

let portCounter = 5200 + Math.floor(Math.random() * 1000);
function nextPort() {
    portCounter += 1;
    return portCounter;
}

function runOrchestrator({ port, buildMode, rollbackStaysBroken, multicaLog, dockerState }) {
    const result = spawnSync(process.execPath, [
        ORCHESTRATOR,
        '--base=HEAD',
        '--head=HEAD',
        '--correlation-id=e2e-test',
        '--admin-request=e2e test change',
        '--issue-id=fake-issue-id',
        `--target-base-url=http://127.0.0.1:${port}`,
    ], {
        encoding: 'utf8',
        env: {
            ...process.env,
            PATH: `${FAKE_DOCKER_ENV}${path.delimiter}${process.env.PATH}`,
            TARGET_COMPOSE_DIR: dockerState, // any existing dir; fake docker ignores compose files
            MIKA_FASTPATH_IMAGE: 'e2e-test-backend',
            MIKA_FASTPATH_SERVICE: 'backend',
            FAKE_DOCKER_STATE: dockerState,
            FAKE_DOCKER_PORT: String(port),
            FAKE_DOCKER_NEXT_BUILD_MODE: buildMode,
            FAKE_DOCKER_ROLLBACK_STAYS_BROKEN: rollbackStaysBroken ? '1' : '0',
            FAKE_MULTICA_LOG: multicaLog,
        },
        timeout: 30000,
    });
    if (result.error) throw result.error;
    return result;
}

function readLog(logPath) {
    return fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
}

function makeScenarioDirs(name) {
    const dockerState = fs.mkdtempSync(path.join(os.tmpdir(), `mika-e2e-${name}-`));
    const multicaLog = path.join(dockerState, 'multica.log');
    return { dockerState, multicaLog };
}

async function stopService(dockerState) {
    const pidFile = path.join(dockerState, 'current_pid');
    if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
        try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    }
}

test('a routine change deploys and health-checks healthy end to end', async (t) => {
    const port = nextPort();
    const { dockerState, multicaLog } = makeScenarioDirs('deployed');
    t.after(() => stopService(dockerState));

    const result = runOrchestrator({ port, buildMode: 'good', dockerState, multicaLog });

    assert.equal(result.status, 0, result.stderr);
    const log = readLog(multicaLog);
    assert.match(log, /Fast-path deploy succeeded/);

    const actualHealth = await runHealthChecks(`http://127.0.0.1:${port}`, { retries: 0 });
    assert.equal(actualHealth.healthy, true, 'the service the orchestrator claims is healthy must actually be healthy');
});

test('a broken deploy is rolled back and the audit only claims restoration once verified', async (t) => {
    const port = nextPort();
    const { dockerState, multicaLog } = makeScenarioDirs('rolled-back');
    t.after(() => stopService(dockerState));

    const first = runOrchestrator({ port, buildMode: 'good', dockerState, multicaLog });
    assert.equal(first.status, 0, first.stderr);

    const second = runOrchestrator({ port, buildMode: 'broken', dockerState, multicaLog });
    assert.equal(second.status, 1, second.stderr);

    const log = readLog(multicaLog);
    assert.match(log, /restored and this was verified/);
    assert.doesNotMatch(log, /UNVERIFIED/);

    const actualHealth = await runHealthChecks(`http://127.0.0.1:${port}`, { retries: 0 });
    assert.equal(actualHealth.healthy, true, 'the audit claimed verified restoration -- the live service must actually be healthy');
});

test('rollback that runs but leaves the service broken is reported as unverified, never as restored', async (t) => {
    const port = nextPort();
    const { dockerState, multicaLog } = makeScenarioDirs('unverified');
    t.after(() => stopService(dockerState));

    const first = runOrchestrator({ port, buildMode: 'good', dockerState, multicaLog });
    assert.equal(first.status, 0, first.stderr);

    const second = runOrchestrator({
        port, buildMode: 'broken', rollbackStaysBroken: true, dockerState, multicaLog,
    });
    assert.equal(second.status, 4, second.stderr);

    const log = readLog(multicaLog);
    assert.match(log, /UNVERIFIED/);
    assert.match(log, /Manual intervention required/);
    assert.doesNotMatch(log, /restored and this was verified/);
    assert.doesNotMatch(log, /prior working deployment has been restored/);

    const actualHealth = await runHealthChecks(`http://127.0.0.1:${port}`, { retries: 0 });
    assert.equal(actualHealth.healthy, false, 'this is the exact MYAG-204 bug: the service must genuinely still be broken here');
});

test('when rollback.sh itself fails (no prior version to restore), that is reported plainly and never as restored', async (t) => {
    const port = nextPort();
    const { dockerState, multicaLog } = makeScenarioDirs('rollback-failed');
    t.after(() => stopService(dockerState));

    // First-ever deploy, and it's broken: deploy.sh never tagged a last-good
    // image (there was nothing running yet), so rollback.sh has nothing to
    // restore to and must fail outright.
    const result = runOrchestrator({ port, buildMode: 'broken', dockerState, multicaLog });
    assert.equal(result.status, 5, result.stderr);

    const log = readLog(multicaLog);
    assert.match(log, /rollback itself FAILED/);
    assert.match(log, /cannot roll back/);
    assert.match(log, /Manual intervention required immediately/);
    assert.doesNotMatch(log, /has been restored/);

    const actualHealth = await runHealthChecks(`http://127.0.0.1:${port}`, { retries: 0 });
    assert.equal(actualHealth.healthy, false, 'no rollback happened, so the broken deploy must still be what is live');
});
