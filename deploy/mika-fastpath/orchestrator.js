#!/usr/bin/env node
/**
 * Mika fast-path orchestrator (MYAG-197)
 *
 * Entry point the Mika bridge / CI calls for an admin-approved change.
 * Steps, in order:
 *   1. Diff the change against the current deployed ref -> list of changed files.
 *   2. Carve-out check (deterministic, path-based). If blocked: file a normal
 *      issue, post an audit comment, exit non-zero. Nothing is built or deployed.
 *   3. Otherwise: build + deploy via deploy.sh, then run post-deploy health
 *      checks against the deployed instance.
 *   4. If health checks fail: rollback.sh restores the last known-good
 *      version, then health checks are re-run to confirm restoration.
 *   5. Post exactly one audit comment for the whole attempt, always.
 *
 * This script intentionally never runs against the live production host by
 * default -- TARGET_BASE_URL/TARGET_COMPOSE_DIR must be explicitly set (see
 * README.md). Wiring it to myhai.org is a separate, explicit step.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const { checkCarveOut } = require('./carve-out');
const { runHealthChecks } = require('./health-check');
const { formatAuditComment, postAuditComment, fileNormalIssue } = require('./audit');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function getChangedFiles(baseRef, headRef) {
    const out = execFileSync('git', ['diff', '--name-only', `${baseRef}..${headRef}`], {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    return out.split('\n').map(l => l.trim()).filter(Boolean);
}

function runScript(scriptPath, args, envExtra) {
    return execFileSync(scriptPath, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...envExtra },
    });
}

// Rollback is only ever reported as successful once a fresh post-rollback
// health check has actually passed -- a clean `rollback.sh` exit code only
// proves the script ran, not that the restored service works (MYAG-204).
async function attemptRollback({ dryRun, baseUrl }) {
    if (dryRun) {
        return { outcome: 'rolled_back', rollbackHealth: { healthy: true, results: [] }, rollbackError: null };
    }
    try {
        runScript(path.join(__dirname, 'rollback.sh'), []);
    } catch (rollbackErr) {
        return { outcome: 'rollback_failed', rollbackHealth: null, rollbackError: rollbackErr.message };
    }
    const rollbackHealth = await runHealthChecks(baseUrl);
    if (rollbackHealth.healthy) {
        return { outcome: 'rolled_back', rollbackHealth, rollbackError: null };
    }
    return { outcome: 'rollback_unverified', rollbackHealth, rollbackError: null };
}

// rejected/deployed keep their existing exit codes; the rollback outcomes
// each get their own so callers (CI, the Mika bridge) can tell "restored and
// confirmed" apart from "restoration unverified" or "rollback itself failed"
// instead of collapsing all three into a single non-zero exit.
const EXIT_CODES = {
    deployed: 0,
    rejected: 1,
    rolled_back: 1,
    rollback_unverified: 4,
    rollback_failed: 5,
};

async function main() {
    const args = require('util').parseArgs({
        options: {
            base: { type: 'string', default: 'HEAD~1' },
            head: { type: 'string', default: 'HEAD' },
            'correlation-id': { type: 'string' },
            'admin-request': { type: 'string', default: '' },
            'issue-id': { type: 'string' }, // where the audit comment / normal issue is filed
            'target-base-url': { type: 'string', default: process.env.TARGET_BASE_URL || '' },
            'dry-run': { type: 'boolean', default: false },
        },
    }).values;

    const correlationId = args['correlation-id'] || `local-${Date.now()}`;
    const issueId = args['issue-id'] || process.env.MIKA_PARENT_ISSUE_ID;
    if (!issueId) {
        console.error('No --issue-id / MIKA_PARENT_ISSUE_ID given -- cannot post the required audit comment. Aborting.');
        process.exit(2);
    }

    const changedFiles = getChangedFiles(args.base, args.head);
    const carveOut = checkCarveOut(changedFiles);

    if (!carveOut.allowed) {
        console.log('Carve-out triggered:', carveOut.blockedFiles);
        const descPath = path.join(os.tmpdir(), `mika-fastpath-reroute-${correlationId}.md`);
        fs.writeFileSync(descPath, [
            `A Mika fast-path change (correlation \`${correlationId}\`) was rejected because it touches a carved-out path.`,
            '',
            `**Admin request:** ${args['admin-request'] || '(not provided)'}`,
            '',
            '**Blocked files:**',
            ...carveOut.blockedFiles.map(f => `- \`${f}\``),
            '',
            '**All changed files:**',
            ...changedFiles.map(f => `- \`${f}\``),
            '',
            'This needs to go through the normal review pipeline (specialist -> Gatekeeper -> in_review).',
        ].join('\n'));

        if (!args['dry-run']) {
            await fileNormalIssue({
                title: `[Mika fast-path reroute ${correlationId}] carve-out hit`,
                descriptionPath: descPath,
                projectId: process.env.MULTICA_PROJECT_ID,
            });
        }
        fs.unlinkSync(descPath);

        const body = formatAuditComment({
            outcome: 'rejected',
            correlationId,
            adminRequestSummary: args['admin-request'],
            changedFiles,
            blockedFiles: carveOut.blockedFiles,
        });
        if (!args['dry-run']) await postAuditComment({ issueId, body });
        else console.log(body);
        process.exit(1);
    }

    let deployError = null;
    let healthResult = null;
    let rollbackHealth = null;
    let rollbackError = null;
    let outcome = 'deployed';
    const baseUrl = args['target-base-url'] || 'http://127.0.0.1:3000';

    try {
        if (!args['dry-run']) {
            runScript(path.join(__dirname, 'deploy.sh'), []);
        }
        healthResult = args['dry-run'] ? { healthy: true, results: [] } : await runHealthChecks(baseUrl);

        if (!healthResult.healthy) {
            const rollback = await attemptRollback({ dryRun: args['dry-run'], baseUrl });
            outcome = rollback.outcome;
            rollbackHealth = rollback.rollbackHealth;
            rollbackError = rollback.rollbackError;
        }
    } catch (err) {
        deployError = err.message;
        const rollback = await attemptRollback({ dryRun: args['dry-run'], baseUrl });
        outcome = rollback.outcome;
        rollbackHealth = rollback.rollbackHealth;
        rollbackError = rollback.rollbackError;
    }

    const body = formatAuditComment({
        outcome,
        correlationId,
        adminRequestSummary: args['admin-request'],
        changedFiles,
        healthCheck: healthResult,
        rollbackHealthCheck: rollbackHealth,
        rollbackError,
        error: deployError,
    });
    if (!args['dry-run']) await postAuditComment({ issueId, body });
    else console.log(body);

    process.exit(EXIT_CODES[outcome] ?? 1);
}

main().catch(err => {
    console.error('mika-fastpath orchestrator crashed:', err);
    process.exit(3);
});
