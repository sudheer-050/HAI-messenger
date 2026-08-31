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
const { getChangedFiles } = require('./changed-files');
const { runHealthChecks } = require('./health-check');
const { formatAuditComment, postAuditComment, fileNormalIssue } = require('./audit');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function runScript(scriptPath, args, envExtra) {
    return execFileSync(scriptPath, args, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
        env: { ...process.env, ...envExtra },
    });
}

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

    const changedFiles = getChangedFiles(args.base, args.head, { cwd: REPO_ROOT });
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
    let outcome = 'deployed';

    try {
        if (!args['dry-run']) {
            runScript(path.join(__dirname, 'deploy.sh'), []);
        }
        const baseUrl = args['target-base-url'] || 'http://127.0.0.1:3000';
        healthResult = args['dry-run'] ? { healthy: true, results: [] } : await runHealthChecks(baseUrl);

        if (!healthResult.healthy) {
            outcome = 'rolled_back';
            if (!args['dry-run']) {
                runScript(path.join(__dirname, 'rollback.sh'), []);
                healthResult = await runHealthChecks(baseUrl);
            }
        }
    } catch (err) {
        deployError = err.message;
        outcome = 'rolled_back';
        if (!args['dry-run']) {
            try {
                runScript(path.join(__dirname, 'rollback.sh'), []);
            } catch (rollbackErr) {
                deployError += ` | rollback also failed: ${rollbackErr.message}`;
            }
        }
    }

    const body = formatAuditComment({
        outcome,
        correlationId,
        adminRequestSummary: args['admin-request'],
        changedFiles,
        healthCheck: healthResult,
        error: deployError,
    });
    if (!args['dry-run']) await postAuditComment({ issueId, body });
    else console.log(body);

    process.exit(outcome === 'deployed' ? 0 : 1);
}

main().catch(err => {
    console.error('mika-fastpath orchestrator crashed:', err);
    process.exit(3);
});
