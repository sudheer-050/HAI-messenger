/**
 * Fast-path integration test (MYAG-197)
 *
 * Exercises the REAL carve-out and health-check modules (no mocking of the
 * logic under test) against a locally-spawned process standing in for the
 * deployed backend, proving the three scenarios the issue's acceptance
 * criteria ask for:
 *   (a) a routine change passes the carve-out and a healthy deploy is confirmed
 *   (b) a change touching a carved-out path is rejected BEFORE anything is
 *       deployed -- the previously-running version is left untouched
 *   (c) a broken deploy fails the health check and rollback actually restores
 *       the prior working version (verified by re-running the health check,
 *       not just by trusting the rollback script's exit code)
 *
 * Docker itself is not reachable in this sandbox (no socket permission), so
 * deploy.sh/rollback.sh's actual `docker compose`/image-tag mechanics are
 * NOT exercised here -- ProcessDeployer stands in for them. Those scripts
 * still need to be run against a real docker daemon (CI or the home server)
 * before being trusted for a live deploy; that verification has not been
 * done as part of this change.
 *
 * Run with: node --test deploy/mika-fastpath/test/integration.test.js
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { checkCarveOut } = require('../carve-out');
const { runHealthChecks } = require('../health-check');
const { ProcessDeployer } = require('./process-deployer');

const PORT = 4123 + Math.floor(Math.random() * 1000);
const BASE_URL = `http://127.0.0.1:${PORT}`;

test('scenario (a): a routine change clears the carve-out and a good deploy is healthy', async (t) => {
    const carveOut = checkCarveOut(['frontend/admin.html', 'README.md']);
    assert.equal(carveOut.allowed, true);

    const deployer = new ProcessDeployer(PORT);
    t.after(() => deployer.teardown());

    await deployer.deploy('good');
    const health = await runHealthChecks(BASE_URL, { retries: 0 });
    assert.equal(health.healthy, true);
});

test('scenario (b): a carved-out change is rejected before any deploy happens', async (t) => {
    const deployer = new ProcessDeployer(PORT + 1);
    t.after(() => deployer.teardown());

    // Establish a known-good running version first, as if it were already live.
    await deployer.deploy('good');
    const before = await runHealthChecks(`http://127.0.0.1:${PORT + 1}`, { retries: 0 });
    assert.equal(before.healthy, true);

    const carveOut = checkCarveOut(['backend/server.js', 'README.md']);
    assert.equal(carveOut.allowed, false);
    assert.deepEqual(carveOut.blockedFiles, ['backend/server.js']);

    // The orchestrator's contract: on a carve-out hit, it must return before
    // ever calling deploy.sh. We simulate that contract directly here --
    // deployer.deploy is simply never called for the (fake) blocked change --
    // and confirm the previously-running version is exactly as it was.
    const after = await runHealthChecks(`http://127.0.0.1:${PORT + 1}`, { retries: 0 });
    assert.equal(after.healthy, true);
    assert.equal(deployer.currentMode, 'good');
});

test('scenario (c): a broken deploy fails health check, and rollback actually restores service', async (t) => {
    const deployer = new ProcessDeployer(PORT + 2);
    t.after(() => deployer.teardown());
    const url = `http://127.0.0.1:${PORT + 2}`;

    await deployer.deploy('good');
    const goodHealth = await runHealthChecks(url, { retries: 0 });
    assert.equal(goodHealth.healthy, true);

    await deployer.deploy('broken');
    const brokenHealth = await runHealthChecks(url, { retries: 0 });
    assert.equal(brokenHealth.healthy, false, 'the broken deploy must fail health check even though the process is up');

    await deployer.rollback();
    const restoredHealth = await runHealthChecks(url, { retries: 0 });
    assert.equal(restoredHealth.healthy, true, 'rollback must restore actual working behavior, not just restart something');
    assert.equal(deployer.currentMode, 'good');
});
